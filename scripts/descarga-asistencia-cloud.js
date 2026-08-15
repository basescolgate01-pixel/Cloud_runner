/**
 * descarga-asistencia-cloud.js
 * Versión para Google Cloud Run:
 *  - headless: true  (sin pantalla)
 *  - guarda el .xlsx en /tmp
 *  - envía el archivo por email al terminar
 *  - expone un servidor HTTP para que Cloud Scheduler lo dispare
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const nodemailer = require('nodemailer');
const { limpiarChromeHuerfano } = require('./_cleanup');

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

  // Gmail remitente — App Password (nodemailer)
  gmailUser:    process.env.GMAIL_USER     || 'notificaciones.colgate@gmail.com',
  gmailAppPass: process.env.GMAIL_APP_PASS || '',

  // Puerto del servidor HTTP
  port: parseInt(process.env.PORT || '8080'),
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Envuelve una promesa con un timeout propio. Imprescindible con Puppeteer:
// si Chrome queda sin responder (falta de CPU, página colgada, etc.), un
// page.evaluate() puede quedarse esperando para siempre en vez de fallar.
// Preferimos que falle rápido y quede claro en el log dónde se atascó.
function conTimeout(promesa, ms, etiqueta) {
  let h;
  return Promise.race([
    promesa,
    new Promise((_, rej) => { h = setTimeout(() => rej(new Error(`Timeout (${ms / 1000}s) en: ${etiqueta}`)), ms); }),
  ]).finally(() => clearTimeout(h));
}

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
  // TEMPORAL: hardcodeada al 14 para pruebas (el 15 no tiene datos en el BI)
  // TODO: volver a fecha dinámica cuando el BI esté actualizado
  return '14-08-2026';
}

// ─── LOGIN POWER BI ───────────────────────────────────────────────────────────
async function loginPowerBI(page) {
  console.log('  [1] Pantalla Power BI login...');
  console.log(`  URL actual: ${page.url().split('?')[0]}`);

  // Manejar pantalla "elegir cuenta" de Microsoft si aparece
  const pickAccount = await page.$('div[data-focuszone-id], div[class*="tile"]').catch(() => null);
  if (pickAccount) {
    console.log('  Pantalla "elegir cuenta" detectada, buscando cuenta...');
    const cuenta = await page.evaluate((email) => {
      const tiles = Array.from(document.querySelectorAll('[data-test-id="tiles-user-row"], div[class*="account"], div[tabindex]'));
      const match = tiles.find(t => t.textContent.includes(email));
      if (match) { match.click(); return true; }
      return false;
    }, CONFIG.pbiEmail);
    if (cuenta) { await sleep(3000); return; }
  }

  await page.waitForSelector('input[type="email"], input[placeholder="Enter email"], input[name="loginfmt"]', { visible: true, timeout: 40000 });
  const input = await page.$('input[type="email"]') || await page.$('input[placeholder="Enter email"]') || await page.$('input[name="loginfmt"]');
  await page.evaluate((el, val) => {
    el.focus(); el.value = '';
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    ns.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, input, CONFIG.pbiEmail);
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
  await page.evaluate((el, val) => {
    el.focus(); el.value = '';
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    ns.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, pwd, CONFIG.pbiPassword);
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
// 100% via page.evaluate — sin page.$$(), sin ElementHandles, sin DOM.describeNode.
// En Railway, cualquier llamada que pase por el protocolo CDP (page.$$, inp.click,
// inp.type) puede colgarse cuando Chrome está bajo presión de CPU/memoria.
// evaluate() corre directo en el motor JS del browser y no depende del protocolo.
// Helper JS inyectado en cada evaluate de fecha
const _fechaJS = `
  const _sels = [
    'input.date-slicer-input',
    'input[class*="date-slicer"]',
    'input[class*="dateSlicer"]',
    'input[type="text"][class*="slicer"]',
  ];
  function _buscar() {
    for (const s of _sels) {
      const ii = Array.from(document.querySelectorAll(s));
      if (ii.length >= 2) return { sel: s, inputs: ii };
    }
    return null;
  }
  function _setear(el, val) {
    el.focus(); el.click();
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    ns.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    ns.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    el.blur();
    return el.value;
  }
`;

async function setearFecha(page, fecha) {
  console.log(`  Seteando fecha: ${fecha}`);

  // Separado en 2 evaluate con sleep entre medio, porque setear HASTA
  // dispara un re-render síncrono en Power BI que puede bloquear el
  // evaluate >20s si ambos campos se hacen en la misma llamada.

  // ── HASTA (input derecho, idx 1) ──
  const resHasta = await conTimeout(page.evaluate(new Function('fecha', `
    ${_fechaJS}
    const f = _buscar();
    if (!f) return { ok: false, error: 'No se encontraron inputs de fecha' };
    const sorted = f.inputs.map(el => ({ el, x: el.getBoundingClientRect().x })).sort((a, b) => a.x - b.x);
    const idx = Math.min(1, sorted.length - 1);
    const val = _setear(sorted[idx].el, fecha);
    return { ok: true, sel: f.sel, count: f.inputs.length, val };
  `), fecha), 30000, 'setear HASTA').catch(e => ({ ok: false, error: e.message }));

  if (resHasta.ok) {
    console.log(`  ✅ Inputs encontrados (${resHasta.sel}): ${resHasta.count}`);
    console.log(`  ✅ HASTA = "${resHasta.val}"`);
  } else {
    console.log(`  ⚠️ HASTA: ${resHasta.error}`);
  }

  // Esperar re-render de Power BI entre campos
  await sleep(6000);

  // ── DESDE (input izquierdo, idx 0) ──
  const resDesde = await conTimeout(page.evaluate(new Function('fecha', `
    ${_fechaJS}
    const f = _buscar();
    if (!f) return { ok: false, error: 'Inputs no encontrados tras HASTA' };
    const sorted = f.inputs.map(el => ({ el, x: el.getBoundingClientRect().x })).sort((a, b) => a.x - b.x);
    const val = _setear(sorted[0].el, fecha);
    return { ok: true, val };
  `), fecha), 30000, 'setear DESDE').catch(e => ({ ok: false, error: e.message }));

  if (resDesde.ok) {
    console.log(`  ✅ DESDE = "${resDesde.val}"`);
  } else {
    console.log(`  ⚠️ DESDE: ${resDesde.error}`);
  }

  // Esperar a que Power BI aplique filtros y re-renderice la tabla
  await sleep(10000);
}

// ─── EXPORTAR TABLA ───────────────────────────────────────────────────────────
// Versión optimizada para Railway: interacciones via DOM directo (evaluate)
// en vez de page.mouse.move/click que se cuelgan en CPUs lentas compartidas.
async function exportarTabla(page) {
  console.log('  Exportando tabla de detalle...');
  await sleep(2000);

  const selectoresMenu = [
    'button.vcMenuBtn',
    '[aria-label="Más opciones"]',
    '[aria-label="More options"]',
    '[title="Más opciones"]',
    '[title="More options"]',
    'button[class*="vcMenu"]',
  ];

  // ── Paso 1: Encontrar el visual de la tabla y simular hover via JS ──
  // Reintentar porque después de cambiar fechas, Power BI re-renderiza la
  // tabla y puede tardar bastante en una CPU lenta (Railway).
  let tablaInfo = null;
  for (let intento = 0; intento < 12; intento++) {
    tablaInfo = await conTimeout(page.evaluate(() => {
      const claves = ['NOMBRE LOCAL', 'RUT PERSONA', 'NOMBRE CARGO'];
      const fallback = ['NOMBRE LOCAL', 'NOMBRE PERSONA', 'NOMBRE PROVEEDOR'];
      const todos = Array.from(document.querySelectorAll('div, section, article'));

      function buscar(textos, minY) {
        let mejor = null;
        for (const el of todos) {
          const r = el.getBoundingClientRect();
          if (r.width < 400 || r.height < 80 || r.y < minY) continue;
          const txt = el.textContent || '';
          const score = textos.filter(t => txt.includes(t)).length;
          if (score >= 2 && (!mejor || r.width * r.height < mejor.area)) {
            mejor = { el, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), area: r.width * r.height };
          }
        }
        return mejor;
      }

      const visual = buscar(claves, 300) || buscar(fallback, 300);
      if (!visual) return null;

      // Simular hover sobre el visual para que Power BI revele el botón "..."
      const cx = visual.x + visual.w / 2;
      const cyTop = visual.y + 10;
      for (const evType of ['mouseenter', 'mouseover', 'mousemove']) {
        visual.el.dispatchEvent(new MouseEvent(evType, {
          bubbles: true, clientX: cx, clientY: cyTop, view: window,
        }));
      }
      visual.el.dispatchEvent(new MouseEvent('click', {
        bubbles: true, clientX: cx, clientY: visual.y + visual.h / 2, view: window,
      }));

      return { x: visual.x, y: visual.y, w: visual.w, h: visual.h };
    }), 10000, 'buscar visual de tabla').catch(() => null);

    if (tablaInfo) break;
    if (intento % 3 === 0) console.log(`  ⌛ Tabla no visible aún, reintento ${intento + 1}/12...`);
    await sleep(5000);
  }

  if (!tablaInfo) throw new Error('No se encontró la tabla de detalle en la página');
  console.log(`  ✅ Visual encontrado en (${tablaInfo.x}, ${tablaInfo.y}) ${tablaInfo.w}x${tablaInfo.h}`);

  // Dar tiempo a que Power BI reaccione al hover
  await sleep(2500);

  // ── Paso 2: Buscar y clickear el botón "..." ──
  // Intentar varias veces: re-disparar hover + buscar botón
  let clickOk = false;
  for (let intento = 0; intento < 10; intento++) {
    const res = await conTimeout(page.evaluate((sels, tbl) => {
      // Re-hover para mantener el menú visible
      const cx = tbl.x + tbl.w / 2;
      const cyTop = tbl.y + 10;
      const elAtPoint = document.elementFromPoint(cx, cyTop);
      if (elAtPoint) {
        for (const evType of ['mousemove', 'mouseover', 'mouseenter']) {
          elAtPoint.dispatchEvent(new MouseEvent(evType, {
            bubbles: true, clientX: cx, clientY: cyTop, view: window,
          }));
        }
      }

      // Buscar botón visible
      for (const sel of sels) {
        for (const btn of document.querySelectorAll(sel)) {
          const r = btn.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            btn.click();
            return { ok: true, sel, x: Math.round(r.x), y: Math.round(r.y) };
          }
        }
      }
      return null;
    }, selectoresMenu, tablaInfo), 5000, 'click menú "..."').catch(() => null);

    if (res) {
      console.log(`  ✅ Menú "..." clickeado en (${res.x}, ${res.y})`);
      clickOk = true;
      break;
    }

    // Fallback: un solo movimiento de mouse real (no un loop de cientos)
    try {
      const yPos = tablaInfo.y + 5 + (intento * 3);
      await page.mouse.move(tablaInfo.x + tablaInfo.w / 2, yPos);
    } catch (_) {}
    await sleep(1500);
    if (intento % 3 === 0) console.log(`  ⌛ Buscando menú "..."... intento ${intento + 1}/10`);
  }

  if (!clickOk) throw new Error('No se encontró botón de menú "..." del visual');
  await sleep(2000);

  // ── Paso 3: Click en "Exportar datos" ──
  let exportado = null;
  for (let intento = 0; intento < 6; intento++) {
    exportado = await conTimeout(page.evaluate(() => {
      for (const txt of ['Exportar datos', 'Export data']) {
        for (const sel of ['button.pbi-menu-item', '[role="menuitem"]', 'button', 'div[role="menuitem"]', 'span']) {
          const items = Array.from(document.querySelectorAll(sel));
          const item = items.find(i => i.textContent.trim() === txt);
          if (item && item.getBoundingClientRect().width > 0) {
            item.click();
            return txt;
          }
        }
      }
      return null;
    }), 5000, 'click "Exportar datos"').catch(() => null);
    if (exportado) break;
    await sleep(1000);
  }
  if (!exportado) throw new Error('No se encontró "Exportar datos" en el menú');
  console.log(`  ✅ "${exportado}" clickeado`);
  await sleep(3000);

  // ── Paso 4: Confirmar diálogo de exportación ──
  let confirmado = false;
  for (let i = 0; i < 25; i++) {
    const ok = await conTimeout(page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button')).filter(b => {
        const r = b.getBoundingClientRect();
        return ['Exportar', 'Export'].includes(b.textContent.trim()) && r.width > 0;
      });
      if (btns.length === 0) return false;
      btns[btns.length - 1].click();
      return true;
    }), 5000, 'confirmar exportación').catch(() => false);
    if (ok) { console.log('  ✅ Diálogo confirmado'); confirmado = true; break; }
    if (i % 5 === 0) console.log(`  ⌛ Esperando diálogo... ${i + 1}/25`);
    await sleep(800);
  }
  if (!confirmado) console.log('  ⚠️ Diálogo no confirmado, la descarga podría haber iniciado igual');
}

// ─── ENVIAR EMAIL (nodemailer + Gmail App Password) ──────────────────────────
async function enviarEmail(archivoPath, fecha) {
  console.log(`\n📧 Enviando email a ${CONFIG.emailDestino}...`);

  const filename = path.basename(archivoPath);

  // Intentar con 3 configuraciones SMTP distintas (Railway puede bloquear
  // ciertos puertos o protocolos según su infra del momento):
  //   1. SMTP con STARTTLS en puerto 587 (el más compatible)
  //   2. SMTPS directo en puerto 465
  //   3. service: 'gmail' (auto-config de nodemailer)
  const configs = [
    { host: 'smtp.gmail.com', port: 587, secure: false, connectionTimeout: 15000, greetingTimeout: 10000 },
    { host: 'smtp.gmail.com', port: 465, secure: true, connectionTimeout: 15000, greetingTimeout: 10000 },
    { service: 'gmail', connectionTimeout: 15000, greetingTimeout: 10000 },
  ];

  for (let i = 0; i < configs.length; i++) {
    const cfg = configs[i];
    const label = cfg.port ? `puerto ${cfg.port}` : 'service:gmail';
    console.log(`  Intento ${i + 1}/3 (${label})...`);

    try {
      const transporter = nodemailer.createTransport({
        ...cfg,
        auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailAppPass },
      });

      await transporter.sendMail({
        from: `"Asistencia Power BI" <${CONFIG.gmailUser}>`,
        to: CONFIG.emailDestino,
        subject: `Asistencia Google_CO ${fecha}`,
        text: `Adjunto el reporte de asistencia del ${fecha}.`,
        attachments: [{ filename, path: archivoPath }],
      });

      console.log('  ✅ Email enviado');
      return;
    } catch (err) {
      console.log(`  ⚠️ Falló (${label}): ${err.message}`);
    }
  }

  throw new Error('No se pudo enviar email por ningún puerto SMTP');
}

// ─── LIMPIEZA AL DETENER ──────────────────────────────────────────────────────
// Cuando server.js detiene el job manda SIGTERM primero (3s) y luego SIGKILL.
// Capturamos SIGTERM para cerrar el browser de Chromium limpiamente antes de morir,
// evitando que queden procesos zombie en Railway.
let _browserActivo = null; // referencia global al browser en curso

process.on('SIGTERM', async () => {
  console.log('\n⏹  SIGTERM recibido — cerrando Chromium...');
  try {
    if (_browserActivo) await _browserActivo.close();
    console.log('  ✅ Chromium cerrado');
  } catch (e) {
    console.log(`  ⚠️  Error al cerrar Chromium: ${e.message}`);
  }
  process.exit(0);
});

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

  // Por si quedó un Chrome zombie de una corrida anterior que crasheó
  limpiarChromeHuerfano();

  const archivosAntes = new Set(fs.readdirSync(CONFIG.downloadPath));
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      slowMo: 30,
      protocolTimeout: 300000,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--lang=es-CL',
        '--accept-lang=es-CL,es,en',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--mute-audio',
      ],
      env: { ...process.env, LANG: 'es_CL.UTF-8', LANGUAGE: 'es_CL:es' },
      defaultViewport: { width: 1920, height: 1080 },
    });

    _browserActivo = browser; // exponer al handler SIGTERM
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

    // Navegar al reporte — Power BI redirige a singleSignOn, que luego redirige a Microsoft login
    console.log('📍 Navegando a Power BI...');
    await page.goto(CONFIG.powerBiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    let url = page.url();
    console.log(`  URL inicial: ${url.split('?')[0]}`);

    // Si está en singleSignOn, completar el formulario de email de Power BI
    if (url.includes('singleSignOn')) {
      console.log('  Formulario de email Power BI detectado...');
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 10000 }).catch(() => {});

      // Buscar cualquier input de email o texto
      const inputSelector = 'input[type="email"], input[type="text"], input[name="email"], input';
      await page.waitForSelector(inputSelector, { visible: true, timeout: 15000 });
      const emailInput = await page.$(inputSelector);
      await page.evaluate((el, val) => {
        el.focus(); el.value = '';
        const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        ns.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, emailInput, CONFIG.pbiEmail);
      console.log('  ✅ Email ingresado');

      // Click en "Enviar" / "Submit"
      const enviado = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
          .find(b => b.textContent.trim().match(/enviar|submit|next|siguiente/i) || b.type === 'submit');
        if (btn) { btn.click(); return btn.textContent.trim() || 'submit'; }
        return null;
      });
      if (enviado) {
        console.log(`  ✅ Botón "${enviado}" clickeado`);
      } else {
        await page.keyboard.press('Enter');
        console.log('  ✅ Enter presionado');
      }

      // Esperar redirect a Microsoft login
      await page.waitForFunction(
        () => window.location.href.includes('microsoftonline') || window.location.href.includes('login.microsoft') || window.location.href.includes('app.powerbi.com/groups'),
        { timeout: 30000 }
      );
      url = page.url();
      console.log(`  URL tras singleSignOn: ${url.split('?')[0]}`);
    }

    // Login Microsoft
    console.log('\n🔑 Login...');

    if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
      // Email
      const tieneEmail = await page.$('input[name="loginfmt"], input[type="email"]').catch(() => null);
      if (tieneEmail) {
        await loginPowerBI(page);
        await sleep(3000);
        url = page.url();
      }

      // Contraseña
      if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
        await loginMicrosoft(page);
        await sleep(3000);
        url = page.url();
      }

      // KMSI
      if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
        await manejarKMSI(page);
        await sleep(3000);
        url = page.url();
      }
    }

    // Esperar que Power BI cargue el reporte (singleSignOn se auto-completa tras el login)
    console.log('\n⏳ Esperando reporte...');
    await page.waitForFunction(
      () => window.location.href.includes('app.powerbi.com/groups'),
      { timeout: 120000 }
    );
    url = page.url();
    console.log(`  URL reporte: ${url.split('?')[0]}`);
    const esperaReporte = process.env.RAILWAY_ENVIRONMENT ? 40000 : 25000;
    await sleep(esperaReporte); // Railway necesita más tiempo para renderizar Power BI
    console.log('✅ Reporte cargado');

    // Fechas
    console.log(`\n📅 Seteando fecha: ${getFechaFiltro()}`);
    await setearFecha(page, getFechaFiltro());

    // Exportar
    console.log('\n📥 Exportando...');
    // Red de seguridad: si Chrome queda sin responder en CUALQUIER punto de
    // exportarTabla (incluidos los movimientos de mouse, que no tienen timeout
    // propio), esto corta a los 45s en vez de quedarse colgado para siempre.
    await conTimeout(exportarTabla(page), 90000, 'exportarTabla (posible Chrome colgado)');

    // Esperar descarga: eventos CDP si el navegador los dispara, pero también
    // se revisa la carpeta directamente — en algunos entornos (Chromium del
    // sistema en Railway, distinto al bundleado con Puppeteer) el evento
    // Browser.downloadWillBegin nunca llega aunque el archivo sí se escriba.
    console.log('\n⏳ Esperando descarga...');
    let rutaArchivo = null;
    for (let i = 0; i < 90; i++) {
      await sleep(1000);
      if (downloadInfo?.error) throw new Error('La descarga fue cancelada por Chrome');

      const nuevos = fs.readdirSync(CONFIG.downloadPath).filter(f =>
        !archivosAntes.has(f) && f.endsWith('.xlsx') && !f.endsWith('.crdownload') && !f.includes('.tmp')
      );
      if (nuevos.length > 0) {
        const reciente = nuevos
          .map(f => ({ f, mtime: fs.statSync(path.join(CONFIG.downloadPath, f)).mtime }))
          .sort((a, b) => b.mtime - a.mtime)[0].f;
        const stat = fs.statSync(path.join(CONFIG.downloadPath, reciente));
        if (stat.size > 1024) { rutaArchivo = path.join(CONFIG.downloadPath, reciente); break; }
      }
      if (downloadInfo?.done && !rutaArchivo) {
        // Chrome confirmó la descarga por evento — buscar por nombre sugerido o guid
        const posibles = [
          path.join(CONFIG.downloadPath, downloadInfo.name || ''),
          path.join(CONFIG.downloadPath, downloadInfo.guid || ''),
        ];
        rutaArchivo = posibles.find(p => fs.existsSync(p)) || rutaArchivo;
        if (rutaArchivo) break;
      }
      if (i % 10 === 0) console.log(`  ⌛ ${i + 1}/90 seg...`);
    }

    if (!rutaArchivo) throw new Error(`Archivo no encontrado en ${CONFIG.downloadPath} (timeout 90s)`);

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
    _browserActivo = null;
  }
}

// ─── MODO DE EJECUCIÓN ────────────────────────────────────────────────────────
// Si RAILWAY_ENVIRONMENT o HTTP_MODE están seteados → servidor HTTP (Railway/Cloud Run)
// Si no → corre directamente y sale (runner local / cron)

const HTTP_MODE = process.env.HTTP_MODE; // HTTP_MODE debe setearse explícitamente; RAILWAY_ENVIRONMENT solo no activa el servidor

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
