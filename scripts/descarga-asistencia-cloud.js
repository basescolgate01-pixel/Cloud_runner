/**
 * descarga-asistencia-cloud.js
 * Versión para Google Cloud Run:
 *  - headless: true  (sin pantalla)
 *  - guarda el .xlsx en /tmp
 *  - envía el archivo por email al terminar
 *  - expone un servidor HTTP para que Cloud Scheduler lo dispare
 */

const puppeteer = require('puppeteer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const http = require('http');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  // Power BI
  pbiEmail:    process.env.PBI_EMAIL    || 'colgate_ecr@frax.cl',
  pbiPassword: process.env.PBI_PASSWORD || 'TPIrwqU9',
  powerBiUrl:  'https://app.powerbi.com/groups/02d55b93-6dd2-4b31-824a-9e980b02afb5/reports/e3a2de1e-a071-4a23-9bc0-65e57a51519c/96968b20444fb49a9cd2?experience=power-bi',

  // Descarga: /tmp en Railway, Downloads/asistencia en local
  downloadPath: process.env.RAILWAY_ENVIRONMENT
    ? '/tmp/asistencia'
    : require('path').join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'asistencia'),

  // Email de destino
  emailDestino: process.env.EMAIL_DESTINO || 'mriquelme@ecrgroup.cl',

  // Gmail remitente — usar App Password, no la contraseña normal
  gmailUser:    process.env.GMAIL_USER     || 'basescolgate01@gmail.com',
  gmailPass:    process.env.GMAIL_APP_PASS || 'hipuxekkzmxxafbp',

  // Puerto del servidor HTTP
  port: parseInt(process.env.PORT || '8080'),
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getFechaPartes() {
  // Siempre usar hora de Santiago (UTC-3/UTC-4) independiente del servidor
  const partes = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day:   '2-digit',
    month: '2-digit',
    year:  'numeric',
  }).formatToParts(new Date());
  return {
    dia:  partes.find(p => p.type === 'day').value,
    mes:  partes.find(p => p.type === 'month').value,
    anio: partes.find(p => p.type === 'year').value,
  };
}

function getFechaActual() {
  const { dia, mes, anio } = getFechaPartes();
  return `${dia}-${mes}-${anio}`;
}

function getFechaFiltro() {
  // El slicer de Power BI en locale es-CL muestra y acepta DD-MM-YYYY con guiones
  // (ej: "02-06-2026"). Tipear con slashes o en formato M/D/YYYY no funciona.
  const { dia, mes, anio } = getFechaPartes();
  return `${dia}-${mes}-${anio}`; // DD-MM-YYYY
}

// ─── LOGIN POWER BI ───────────────────────────────────────────────────────────
async function loginPowerBI(page) {
  console.log('  [1] Pantalla Power BI login...');
  await page.waitForSelector('input[type="email"], input[placeholder="Enter email"]', { visible: true, timeout: 20000 });
  const input = await page.$('input[type="email"]') || await page.$('input[placeholder="Enter email"]');
  await input.click({ clickCount: 3 });
  await input.type(CONFIG.pbiEmail, { delay: 80 });
  await sleep(500);
  const enviado = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Enviar' || b.textContent.trim() === 'Submit');
    if (btn) { btn.click(); return true; }
    return false;
  });
  if (!enviado) await page.keyboard.press('Enter');
  console.log('  ✅ Email enviado');
}

async function loginMicrosoft(page) {
  console.log('  [2] Pantalla Microsoft contraseña...');
  await page.waitForSelector('input[name="passwd"], input[type="password"]', { visible: true, timeout: 30000 });
  const pwd = await page.$('input[name="passwd"]') || await page.$('input[type="password"]');
  await pwd.click({ clickCount: 3 });
  await pwd.type(CONFIG.pbiPassword, { delay: 80 });
  await sleep(500);
  const btn = await page.$('#idSIButton9') || await page.$('input[type="submit"]');
  if (btn) await btn.click(); else await page.keyboard.press('Enter');
  console.log('  ✅ Contraseña enviada');
}

async function manejarKMSI(page) {
  await sleep(2000);
  const btnNo = await page.$('#idBtn_Back');
  if (btnNo) { await btnNo.click(); console.log('  ✅ KMSI: No'); return; }
  const btnSi = await page.$('#idSIButton9');
  if (btnSi) { await btnSi.click(); console.log('  ✅ KMSI: Sí'); return; }
  console.log('  ℹ️  Sin pantalla KMSI');
}

// ─── SETEAR FECHA ─────────────────────────────────────────────────────────────
async function buscarInputsFecha(page) {
  // Reintentar hasta 10 veces con 3 segundos entre intentos (30s total)
  for (let intento = 0; intento < 10; intento++) {
    // Buscar en página principal
    const selectores = [
      'input.date-slicer-input',
      'input[class*="date-slicer"]',
      'input[class*="dateSlicer"]',
      'input[type="text"][class*="slicer"]',
    ];
    for (const sel of selectores) {
      const inputs = await page.$$(sel);
      if (inputs.length >= 2) {
        console.log(`  ✅ Inputs encontrados en página (${sel}): ${inputs.length}`);
        return { contexto: page, inputs };
      }
    }

    // Buscar en iframes
    for (const frame of page.frames()) {
      try {
        for (const sel of selectores) {
          const fi = await frame.$$(sel);
          if (fi.length >= 1) {
            console.log(`  ✅ Inputs encontrados en frame (${sel}): ${fi.length}`);
            return { contexto: frame, inputs: fi };
          }
        }
      } catch (_) {}
    }

    console.log(`  ⌛ Inputs no encontrados, reintento ${intento + 1}/10...`);
    await sleep(3000);
  }
  return { contexto: page, inputs: [] };
}

async function setearFecha(page, fecha) {
  // `fecha` viene en formato M/D/YYYY desde getFechaFiltro() (ej: "6/2/2026").
  // Tipeamos directamente en el input en lugar de navegar el calendario: el
  // tipeo no depende del idioma de la UI (el reporte está en español) ni de
  // dónde quede el foco del calendario, así que es confiable en headless.
  console.log(`  Seteando fecha: ${fecha}`);
  const { contexto, inputs } = await buscarInputsFecha(page);
  if (inputs.length === 0) throw new Error('No se encontraron inputs de fecha');

  const inputsConPos = [];
  for (const inp of inputs) {
    const x = await contexto.evaluate(el => el.getBoundingClientRect().x, inp);
    inputsConPos.push({ inp, x });
  }
  inputsConPos.sort((a, b) => a.x - b.x);

  // Llenar HASTA primero (índice 1), luego DESDE (índice 0)
  const orden = inputsConPos.length >= 2
    ? [{ inp: inputsConPos[1].inp, label: 'HASTA' }, { inp: inputsConPos[0].inp, label: 'DESDE' }]
    : inputsConPos.map((o, i) => ({ inp: o.inp, label: i === 0 ? 'DESDE' : 'HASTA' }));

  for (const { inp, label } of orden) {
    console.log(`  → Seteando ${label} a ${fecha}...`);
    try {
      // 1. Enfocar
      await inp.click();
      await sleep(300);

      // 2. Limpiar el campo con el setter nativo (lo detecta React/Angular)
      await contexto.evaluate(el => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, inp);
      await sleep(200);

      // 3. Seleccionar todo + borrar (doble seguro)
      await inp.click({ clickCount: 3 });
      await sleep(200);
      await contexto.keyboard.press('Backspace');
      await sleep(200);

      // 4. Tipear la fecha carácter por carácter
      await inp.type(fecha, { delay: 80 });
      await sleep(500);

      // 5. Disparar eventos de cambio
      await contexto.evaluate(el => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
      }, inp);
      await sleep(400);

      // 6. Enter + Tab para confirmar y cerrar el calendario
      await contexto.keyboard.press('Enter');
      await sleep(400);
      await contexto.keyboard.press('Tab');
      await sleep(1000);

      const val = await contexto.evaluate(el => el.value, inp);
      console.log(`  ✅ ${label} = "${val}"`);
    } catch (e) {
      console.log(`  ⚠️ Error en ${label}: ${e.message}`);
      try { await contexto.keyboard.press('Escape'); } catch (_) {}
      await sleep(500);
    }
  }

  try {
    await page.screenshot({ path: path.join(CONFIG.downloadPath, 'debug-fecha.png') });
    console.log('  📸 Screenshot guardado');
  } catch (_) {}

  await sleep(5000);
}

// ─── EXPORTAR TABLA ───────────────────────────────────────────────────────────
async function exportarTabla(page) {
  console.log('  Exportando tabla de detalle...');
  await sleep(1500);

  const selectoresMenu = [
    'button.vcMenuBtn',
    '[aria-label="Más opciones"]',
    '[aria-label="More options"]',
    '[title="Más opciones"]',
    '[title="More options"]',
    'button[class*="vcMenu"]',
  ];

  // Buscar tabla de detalle inferior por columnas únicas
  const tablaRect = await page.evaluate(() => {
    const claves = ['NOMBRE LOCAL', 'RUT PERSONA', 'NOMBRE CARGO'];
    const fallback = ['NOMBRE LOCAL', 'NOMBRE PERSONA', 'NOMBRE PROVEEDOR'];
    const todos = Array.from(document.querySelectorAll('div, section, article'));

    const buscar = (textos, minY) => {
      let mejor = null;
      for (const el of todos) {
        const r = el.getBoundingClientRect();
        if (r.width < 400 || r.height < 80 || r.y < minY) continue;
        const txt = el.textContent || '';
        const score = textos.filter(t => txt.includes(t)).length;
        if (score >= 2 && (!mejor || r.width * r.height < mejor.area)) {
          mejor = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height };
        }
      }
      return mejor;
    };

    return buscar(claves, 300) || buscar(fallback, 300);
  });

  const cx   = tablaRect ? tablaRect.x + Math.round(tablaRect.w / 2) : 800;
  const cyMid = tablaRect ? tablaRect.y + Math.round(tablaRect.h / 2) : 700;
  const cyTop = tablaRect ? tablaRect.y + 5 : 500;

  console.log(`  Tabla en cx=${cx}, cyMid=${cyMid}, cyTop=${cyTop}`);

  // Click en el centro de la tabla
  await page.mouse.move(cx, cyMid);
  await sleep(400);
  await page.mouse.click(cx, cyMid);
  await sleep(800);

  // Subir mouse lentamente para revelar el botón "..."
  let clickOk = false;
  for (const xTry of [cx, tablaRect ? tablaRect.x + tablaRect.w - 40 : 1400]) {
    if (clickOk) break;
    for (let y = cyMid; y >= cyTop - 20; y -= 10) {
      await page.mouse.move(xTry, y);
      await sleep(120);
      const res = await page.evaluate((sels) => {
        for (const sel of sels) {
          for (const btn of document.querySelectorAll(sel)) {
            const r = btn.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.x > 100 && r.y > 100) {
              btn.click();
              return { ok: true, sel, x: Math.round(r.x), y: Math.round(r.y) };
            }
          }
        }
        return null;
      }, selectoresMenu);
      if (res) { console.log(`  ✅ Menú en (${res.x},${res.y})`); clickOk = true; break; }
    }
  }

  if (!clickOk) throw new Error('No se encontró botón de menú del visual');
  await sleep(1200);

  // Click en "Exportar datos"
  const exportado = await page.evaluate(() => {
    for (const txt of ['Exportar datos', 'Export data']) {
      for (const sel of ['button.pbi-menu-item', '[role="menuitem"]', 'button']) {
        const item = Array.from(document.querySelectorAll(sel)).find(i => i.textContent.trim() === txt);
        if (item && item.getBoundingClientRect().width > 0) { item.click(); return txt; }
      }
    }
    return null;
  });
  if (!exportado) throw new Error('No se encontró "Exportar datos" en el menú');
  console.log(`  ✅ "${exportado}" clickeado`);
  await sleep(3000);

  // Confirmar diálogo
  for (let i = 0; i < 20; i++) {
    const ok = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return ['Exportar','Export'].includes(b.textContent.trim()) && r.width > 0;
      });
      if (btns.length === 0) return false;
      btns[btns.length - 1].click();
      return true;
    });
    if (ok) { console.log(`  ✅ Diálogo confirmado`); break; }
    if (i % 4 === 0) console.log(`  ⌛ Esperando diálogo... ${i+1}/20`);
    await sleep(500);
  }
}

// ─── ENVIAR EMAIL ─────────────────────────────────────────────────────────────
async function enviarEmail(archivoPath, fecha) {
  console.log(`\n📧 Enviando email a ${CONFIG.emailDestino}...`);

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailPass },
  });

  await transporter.sendMail({
    from: `"Asistencia Power BI" <${CONFIG.gmailUser}>`,
    to: CONFIG.emailDestino,
    subject: `Asistencia Google_CO ${fecha}`,
    text: `Adjunto el reporte de asistencia del ${fecha}.`,
    attachments: [
      { filename: path.basename(archivoPath), path: archivoPath },
      ...(fs.existsSync(path.join(CONFIG.downloadPath, 'debug-fecha.png'))
        ? [{ filename: 'debug-fecha.png', path: path.join(CONFIG.downloadPath, 'debug-fecha.png') }]
        : []),
    ],
  });

  console.log('  ✅ Email enviado');
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────
async function descargarAsistencia() {
  const fecha = getFechaActual();
  console.log('═══════════════════════════════════════════');
  console.log('  Descarga Asistencia Power BI — CLOUD');
  console.log(`  Fecha: ${fecha}`);
  console.log('═══════════════════════════════════════════\n');

  if (!fs.existsSync(CONFIG.downloadPath)) {
    fs.mkdirSync(CONFIG.downloadPath, { recursive: true });
  }

  const archivosAntes = new Set(fs.readdirSync(CONFIG.downloadPath));
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      slowMo: 30,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--lang=es-CL',
        '--accept-lang=es-CL,es,en',
      ],
      env: { ...process.env, LANG: 'es_CL.UTF-8', LANGUAGE: 'es_CL:es' },
      defaultViewport: { width: 1920, height: 1080 },
    });

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const cdp = await page.target().createCDPSession();

    // Asegurar que la carpeta exista
    fs.mkdirSync(CONFIG.downloadPath, { recursive: true });
    console.log(`  📁 Carpeta de descarga: ${CONFIG.downloadPath}`);

    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: CONFIG.downloadPath,
      eventsEnabled: true,   // ← habilita eventos de descarga
    });

    // Escuchar eventos de descarga del propio Chrome
    let downloadInfo = null;
    cdp.on('Browser.downloadWillBegin', evt => {
      downloadInfo = { guid: evt.guid, name: evt.suggestedFilename, done: false, error: false };
      console.log(`  📥 Descarga iniciada por Chrome: ${evt.suggestedFilename}`);
    });
    cdp.on('Browser.downloadProgress', evt => {
      if (!downloadInfo || evt.guid !== downloadInfo.guid) return;
      if (evt.state === 'completed') { downloadInfo.done = true; console.log('  ✅ Chrome confirmó descarga completa'); }
      if (evt.state === 'canceled')  { downloadInfo.error = true; downloadInfo.done = true; console.log('  ❌ Descarga cancelada'); }
    });

    // Navegar
    console.log('📍 Navegando a Power BI...');
    await page.goto(CONFIG.powerBiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    let url = page.url();

    // Login
    console.log('\n🔑 Login...');
    if (url.includes('singleSignOn') || url.includes('powerbi.com/signin')) {
      await loginPowerBI(page); await sleep(3000); url = page.url();
    }
    if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
      await loginMicrosoft(page); await sleep(3000); url = page.url();
    }
    if (url.includes('login.microsoftonline') || url.includes('login.microsoft')) {
      await manejarKMSI(page); await sleep(3000); url = page.url();
    }

    // Esperar reporte
    console.log('\n⏳ Esperando reporte...');
    await page.waitForFunction(
      () => window.location.href.includes('app.powerbi.com/groups'),
      { timeout: 60000 }
    );
    await sleep(15000); // Power BI tarda más en renderizar en headless
    console.log('✅ Reporte cargado');

    // Fechas
    console.log(`\n📅 Seteando fecha: ${getFechaFiltro()}`);
    await setearFecha(page, getFechaFiltro());

    // Exportar
    console.log('\n📥 Exportando...');
    await exportarTabla(page);

    // Esperar descarga usando eventos CDP (más confiable que polling)
    console.log('\n⏳ Esperando descarga...');
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (downloadInfo?.done) break;
      if (i % 10 === 0) console.log(`  ⌛ ${i + 1}/90 seg...`);
    }

    if (!downloadInfo || !downloadInfo.done) throw new Error('Timeout: la descarga no completó en 90 segundos');
    if (downloadInfo.error) throw new Error('La descarga fue cancelada por Chrome');

    // Buscar el archivo: puede llamarse igual al sugerido, o ser el guid
    const posibles = [
      path.join(CONFIG.downloadPath, downloadInfo.name),
      path.join(CONFIG.downloadPath, downloadInfo.guid),
    ];
    let rutaArchivo = posibles.find(p => fs.existsSync(p));

    // Último fallback: el xlsx más reciente en la carpeta
    if (!rutaArchivo) {
      const recientes = fs.readdirSync(CONFIG.downloadPath)
        .filter(f => f.endsWith('.xlsx') && !f.includes('.tmp'))
        .map(f => ({ f, mtime: fs.statSync(path.join(CONFIG.downloadPath, f)).mtime }))
        .sort((a, b) => b.mtime - a.mtime);
      if (recientes.length > 0) rutaArchivo = path.join(CONFIG.downloadPath, recientes[0].f);
    }

    if (!rutaArchivo) throw new Error(`Archivo no encontrado en ${CONFIG.downloadPath}`);

    const archivoDescargado = path.basename(rutaArchivo);
    const carpetaDescargado = CONFIG.downloadPath;
    console.log(`  ✅ Archivo listo: ${rutaArchivo}`);

    // Renombrar al nombre final
    const nombreFinal = `asistencia-${fecha}.xlsx`;
    const rutaNueva = path.join(CONFIG.downloadPath, nombreFinal);
    if (rutaArchivo !== rutaNueva) {
      if (fs.existsSync(rutaNueva)) fs.unlinkSync(rutaNueva);
      fs.renameSync(rutaArchivo, rutaNueva);
    }

    console.log('\n✅ ¡Descarga completada!');

    // Enviar email
    await enviarEmail(rutaNueva, fecha);

    return { ok: true, archivo: nombreFinal };

  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    if (browser) { await sleep(1000); await browser.close(); }
  }
}

// ─── MODO DE EJECUCIÓN ────────────────────────────────────────────────────────
// Si RAILWAY_ENVIRONMENT o HTTP_MODE están seteados → servidor HTTP (Railway/Cloud Run)
// Si no → corre directamente y sale (runner local / cron)

const HTTP_MODE = process.env.RAILWAY_ENVIRONMENT || process.env.HTTP_MODE;

if (!HTTP_MODE) {
  // ── Modo directo (runner local) ──────────────────────────────────────────
  console.log('🖥️  Modo: ejecución directa (sin servidor HTTP)');
  descargarAsistencia().then(resultado => {
    console.log('\n📦 Resultado:', JSON.stringify(resultado));
    process.exit(resultado.ok ? 0 : 1);
  }).catch(err => {
    console.error('❌ Error fatal:', err.message);
    process.exit(1);
  });

} else {
  // ── Modo servidor HTTP (Railway / Cloud Run) ─────────────────────────────
  console.log('☁️  Modo: servidor HTTP en puerto', CONFIG.port);
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST' || req.method === 'GET') {
      console.log(`\n🚀 Tarea iniciada por ${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const resultado = await descargarAsistencia();
      res.end(JSON.stringify(resultado));
    } else {
      res.writeHead(405);
      res.end('Method not allowed');
    }
  });

  server.listen(CONFIG.port, () => {
    console.log(`🟢 Servidor escuchando en puerto ${CONFIG.port}`);
  });
}
