require('dotenv').config();
const express    = require('express');
const cron       = require('node-cron');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const { spawn }  = require('child_process');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JOBS_PATH   = path.join(__dirname, 'jobs.json');
const LOGS_DIR    = path.join(__dirname, 'logs');
const SCRIPTS_DIR = path.join(__dirname, 'scripts');
if (!fs.existsSync(LOGS_DIR))    fs.mkdirSync(LOGS_DIR,    { recursive: true });
if (!fs.existsSync(SCRIPTS_DIR)) fs.mkdirSync(SCRIPTS_DIR, { recursive: true });

// Multer — guarda scripts subidos en /scripts
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, SCRIPTS_DIR),
    filename:    (req, file, cb) => cb(null, file.originalname),
  }),
  fileFilter: (req, file, cb) => cb(null, /\.(js|py)$/.test(file.originalname)),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const state     = {};
const cronTasks = {};

function loadJobs() {
  const configs = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  configs.forEach(job => {
    if (state[job.id]) {
      Object.assign(state[job.id], {
        name: job.name, description: job.description,
        script: job.script, cron: job.cron, enabled: job.enabled,
      });
    } else {
      state[job.id] = {
        ...job,
        status: 'idle', lastRun: null, lastResult: null,
        logs: [], history: [], lastDuration: null, runStart: null,
      };
    }
  });
}

function saveJobs() {
  const data = Object.values(state).map(({ id, name, description, script, cron: c, enabled, notify }) =>
    ({ id, name, description, script, cron: c, enabled, notify: notify || { on: 'never', email: '' } }));
  fs.writeFileSync(JOBS_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── Email notifications ───────────────────────────────────────────────────────
function getMailer() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASS },
  });
}

async function sendNotification(job, duration) {
  const n = job.notify;
  if (!n || n.on === 'never' || !n.email) return;
  if (n.on === 'failure' && job.status !== 'error')   return;
  if (n.on === 'success' && job.status !== 'success') return;

  const mailer = getMailer();
  if (!mailer) { console.log('  ⚠ Notificación: GMAIL_USER/GMAIL_APP_PASS no configurados'); return; }

  const ok   = job.status === 'success';
  const icon = ok ? '✅' : '❌';
  const hora = new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' });

  try {
    await mailer.sendMail({
      from:    `"Cloud Runner" <${process.env.GMAIL_USER}>`,
      to:      n.email,
      subject: `${icon} [Cloud Runner] "${job.name}" ${ok ? 'completó OK' : 'falló'}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;background:#0d1117;color:#e6edf3;padding:24px;border-radius:10px">
          <h2 style="margin:0 0 6px">${icon} ${job.name}</h2>
          <p style="color:#7d8590;margin:0 0 20px">${job.description||''}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px">
            <tr><td style="padding:8px 0;color:#7d8590;width:130px">Estado</td>
                <td style="padding:8px 0;color:${ok?'#3fb950':'#f85149'};font-weight:700">${ok?'Éxito':'Error'}</td></tr>
            <tr><td style="padding:8px 0;color:#7d8590">Resultado</td>
                <td style="padding:8px 0">${job.lastResult||''}</td></tr>
            <tr><td style="padding:8px 0;color:#7d8590">Duración</td>
                <td style="padding:8px 0">${fmtDur(duration)}</td></tr>
            <tr><td style="padding:8px 0;color:#7d8590">Hora</td>
                <td style="padding:8px 0">${hora}</td></tr>
          </table>
          <p style="margin-top:20px;font-size:11px;color:#484f58">Cloud Runner — notificación automática</p>
        </div>`,
    });
    console.log(`  📧 Notificación enviada a ${n.email} (${job.status})`);
  } catch (err) {
    console.error(`  ❌ Error al enviar notificación: ${err.message}`);
  }
}

function scheduleJob(job) {
  if (cronTasks[job.id]) { cronTasks[job.id].stop(); delete cronTasks[job.id]; }
  if (job.cron && job.enabled && cron.validate(job.cron)) {
    cronTasks[job.id] = cron.schedule(job.cron, () => {
      console.log(`\n[cron] ${new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })} → ${job.name}`);
      runJob(job.id);
    }, { timezone: 'America/Santiago' });
    console.log(`  ⏰ Programado: "${job.name}"  →  ${job.cron}`);
  } else if (!job.enabled) {
    console.log(`  ⏸  Deshabilitado: "${job.name}"`);
  }
}

function runJob(id) {
  const job = state[id];
  if (!job)                     return { error: 'Job no encontrado' };
  if (job.status === 'running') return { error: 'Ya está corriendo' };

  const runStart = Date.now();
  job.status   = 'running';
  job.lastRun  = new Date().toISOString();
  job.runStart = job.lastRun;
  job.logs     = [];

  const addLog = line => {
    const ts    = new Date().toLocaleTimeString('es-CL');
    const entry = `[${ts}] ${line}`;
    job.logs.push(entry);
    if (job.logs.length > 500) job.logs.splice(0, 1);
    fs.appendFileSync(path.join(LOGS_DIR, `${id}.log`), entry + '\n');
  };

  addLog(`▶ Iniciando "${job.name}"...`);

  const scriptPath = path.resolve(__dirname, job.script);
  if (!fs.existsSync(scriptPath)) {
    job.status = 'error'; job.lastResult = 'Script no encontrado';
    addLog(`❌ Archivo no encontrado: ${scriptPath}`);
    return { error: 'Script no encontrado' };
  }

  const cmd   = scriptPath.endsWith('.js') ? 'node' : (process.platform === 'win32' ? 'python' : 'python3');
  const child = spawn(cmd, [scriptPath], { env: { ...process.env }, cwd: path.dirname(scriptPath) });

  child.stdout.on('data', d => d.toString().split('\n').filter(l => l.trim()).forEach(addLog));
  child.stderr.on('data', d => d.toString().split('\n').filter(l => l.trim()).forEach(l => addLog(`⚠ ${l}`)));

  child.on('close', code => {
    const duration    = Math.round((Date.now() - runStart) / 1000);
    job.status        = code === 0 ? 'success' : 'error';
    job.lastResult    = code === 0 ? 'Completado OK' : `Error (código ${code})`;
    job.lastDuration  = duration;
    job.runStart      = null;

    job.history.unshift({ startTime: job.lastRun, duration, status: job.status, result: job.lastResult });
    if (job.history.length > 10) job.history.pop();

    addLog(code === 0 ? `✅ Completado en ${fmtDur(duration)}` : `❌ Falló (código ${code}) en ${fmtDur(duration)}`);
    sendNotification(job, duration); // no-op si notify.on === 'never'
    setTimeout(() => { if (job.status !== 'running') job.status = 'idle'; }, 60_000);
  });

  child.on('error', err => {
    job.status = 'error'; job.lastResult = err.message; job.runStart = null;
    addLog(`❌ ${err.message}`);
  });

  return { ok: true };
}

function fmtDur(secs) {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

// Init
loadJobs();
Object.values(state).forEach(scheduleJob);

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/jobs', (_, res) =>
  res.json(Object.values(state).map(j => ({
    id: j.id, name: j.name, description: j.description,
    status: j.status, lastRun: j.lastRun, lastResult: j.lastResult,
    cron: j.cron, enabled: j.enabled, notify: j.notify || { on: 'never', email: '' },
    lastDuration: j.lastDuration, runStart: j.runStart,
    history: (j.history || []).slice(0, 5),
  }))));

app.post('/api/jobs/:id/run', (req, res) => res.json(runJob(req.params.id)));

app.get('/api/jobs/:id/logs', (req, res) => {
  const job = state[req.params.id];
  if (!job) return res.status(404).json({ error: 'Not found' });
  const offset = parseInt(req.query.offset) || 0;
  res.json({ status: job.status, lastResult: job.lastResult, logs: job.logs.slice(offset), total: job.logs.length });
});

app.put('/api/jobs/:id', (req, res) => {
  const job = state[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  const { cron: newCron, enabled, name, description, notify } = req.body;
  if (newCron !== undefined) {
    if (newCron && !cron.validate(newCron))
      return res.status(400).json({ error: 'Expresión cron inválida' });
    job.cron = newCron;
  }
  if (enabled     !== undefined) job.enabled     = Boolean(enabled);
  if (name        !== undefined) job.name        = name;
  if (description !== undefined) job.description = description;
  if (notify      !== undefined) job.notify      = notify;
  saveJobs();
  scheduleJob(job);
  console.log(`  💾 "${job.name}" → cron: "${job.cron}" | enabled: ${job.enabled}`);
  res.json({ ok: true });
});

// Eliminar una entrada del historial (?idx=N) o todo el historial
app.delete('/api/jobs/:id/history', (req, res) => {
  const job = state[req.params.id];
  if (!job) return res.status(404).json({ error: 'No encontrado' });
  const idx = req.query.idx !== undefined ? parseInt(req.query.idx) : null;
  if (idx !== null) {
    job.history.splice(idx, 1);
  } else {
    job.history = [];
  }
  res.json({ ok: true });
});

app.delete('/api/jobs/:id', (req, res) => {
  const job = state[req.params.id];
  if (!job) return res.status(404).json({ error: 'No encontrado' });
  if (cronTasks[req.params.id]) { cronTasks[req.params.id].stop(); delete cronTasks[req.params.id]; }
  delete state[req.params.id];
  saveJobs();
  console.log(`  🗑  Eliminado: "${job.name}"`);
  res.json({ ok: true });
});

// Scripts
app.get('/api/scripts', (req, res) => {
  const files = fs.readdirSync(SCRIPTS_DIR).filter(f => /\.(js|py)$/.test(f));
  res.json(files);
});

app.post('/api/scripts/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo o tipo no válido (.js, .py)' });
  console.log(`  📁 Script subido: ${req.file.filename}`);
  res.json({ ok: true, filename: req.file.filename });
});

app.post('/api/jobs', (req, res) => {
  const { name, description, script, cron: cronExpr, enabled } = req.body;
  if (!name || !script) return res.status(400).json({ error: 'Nombre y script son requeridos' });
  if (cronExpr && !cron.validate(cronExpr))
    return res.status(400).json({ error: 'Expresión cron inválida' });
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now();
  state[id] = {
    id, name, description: description || '',
    script: `./scripts/${script}`,
    cron: cronExpr || '', enabled: enabled !== false,
    status: 'idle', lastRun: null, lastResult: null,
    logs: [], history: [], lastDuration: null, runStart: null,
  };
  saveJobs();
  scheduleJob(state[id]);
  console.log(`  ✅ Job creado: "${name}" → ${script}`);
  res.json({ ok: true, id });
});

app.listen(PORT, () => {
  console.log(`\n☁️  Cloud Runner → http://localhost:${PORT}`);
  console.log(`   ${Object.keys(state).length} job(s) cargados\n`);
});
