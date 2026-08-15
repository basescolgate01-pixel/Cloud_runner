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
  const { dia, mes, anio } = getFechaPartes();
  return `${dia}-${mes}-${anio}`; // DD-MM-YYYY
}

// ─── LOGIN POWER BI ───────────────────────────────────────────────────────────
async function loginPowerBI(page) {
  console.log('  [1] Pantalla Power BI login...');

  // Timeout total para login: 2 minutos
  let loginTimeout;
  const loginPromise = new Promise((_, reject) => {
    loginTimeout = setTimeout(() => reject(new Error('Login tardó más de 4 minutos')), 240000);
  });

  try {
    await Promise.race([
      (async () => {
        // Manejar pantalla "Pick an account" / "Elegir cuenta"
        const pickAccount = await page.evaluate((email) => {
          // Buscar el email en la lista de cuentas
          const tiles = Array.from(document.querySelectorAll('[data-test-id], .tile, [role="button"], [role="listitem"]'));
          for (const t of tiles) {
            if ((t.textContent || '').includes(email)) { t.click(); return 'cuenta'; }
          }
          // Buscar "Usar otra cuenta" / "Use another account"
          const links = Array.from(document.querySelectorAll('a, button, [role="button"]'));
          for (const l of links) {
            const txt = (l.textContent || '').toLowerCase();
            if (txt.includes('otra cuenta') || txt.includes('another account') || txt.includes('use another')) {
              l.click(); return 'otra-cuenta';
            }
          }
          return null;
        }, CONFIG.pbiEmail);

        if (pickAccount) {
          console.log(`  ℹ️  Pick account: ${pickAccount}`);
          await sleep(2000);
        }

        // Selectores del input de email (en orden de fiabilidad)
        const EMAIL_SELECTORS = [
          '#i0116',                          // Microsoft SSO (ID más confiable)
          'input[name="loginfmt"]',          // Microsoft estándar histórico
          'input[type="email"]',
          'input[name="login"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="correo" i]',
          'input[placeholder*="Enter email" i]',
          'input[placeholder*="someone@example" i]',
        ];

        let input = null;
        for (let intento = 0; intento < 15; intento++) {
          for (const sel of EMAIL_SELECTORS) {
            try {
              const el = await page.$(sel);
              if (el) {
                const visible = await page.evaluate(e => {
                  const r = e.getBoundingClientRect();
                  return r.width > 0 && r.height > 0;
                }, el);
                if (visible) { input = el; console.log(`  ✅ Input email encontrado: ${sel}`); break; }
              }
            } catch (_) {}
          }
          if (input) break;
          await sleep(1000);
        }

        if (!input) throw new Error('No se encontró el input de email en la pantalla de login');

        await input.click({ clickCount: 3 });
        await input.type(CONFIG.pbiEmail, { delay: 80 });
        await sleep(500);

        const enviado = await page.evaluate(() => {
          const textos = ['Enviar', 'Submit', 'Next', 'Siguiente', 'Sign in'];
          const btn = Array.from(document.querySelectorAll('button, input[type="submit"]'))
            .find(b => textos.includes((b.textContent || b.value || '').trim()));
          if (btn) { btn.click(); return true; }
          return false;
        });
        if (!enviado) await page.keyboard.press('Enter');
        console.log('  ✅ Email enviado');
      })(),
      loginPromise
    ]);
  } finally {
    clearTimeout(loginTimeout);
  }
}

async function loginMicrosoft(page) {
  console.log('  [2] Pantalla Microsoft contraseña...');
  try {
    await page.waitForSelector('input[name="passwd"], input[type="password"]', { visible: true, timeout: 30000 });
  } catch (e) {
    console.log(`  ⚠️ Timeout esperando input de contraseña: ${e.message}, capturando screenshot...`);
    try { await page.screenshot({ path: path.join(CONFIG.downloadPath, 'debug-pwd-timeout.png') }); } catch (_) {}
    throw e;
  }
  const pwd = await page.$('input[name="passwd"]') || await page.$('input[type="password"]');
  if (!pwd) throw new Error('No se encontró input de contraseña');
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
  // Estrategia: navegar el calendario hasta el mes correcto y hacer click en el día.
  // El tipeo directo no funciona porque el calendario roba el foco del input.
  console.log(`  Seteando fecha: ${fecha}`);

  // fecha = "DD-MM-YYYY"
  const [dd, mm, yyyy] = fecha.split('-').map(Number);

  const MESES_ES = {
    'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
    'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
    'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12,
  };

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

    // Timeout de 3 minutos por cada input (180000ms)
    const timeoutMs = 180000;
    let timeoutHandle;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error(`Timeout en ${label}: operación tardó más de 3 minutos`)), timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          // 1. Click en el input para abrir el calendario
          await inp.click();
          await sleep(800);

          // 2. Navegar al mes/año correcto
          for (let intento = 0; intento < 24; intento++) {
            const info = await contexto.evaluate((mesMap) => {
              for (const el of document.querySelectorAll('*')) {
                if (el.children.length > 3) continue;
                const t = (el.textContent || '').trim().toLowerCase();
                const m = t.match(/^([a-záéíóúü]+)\s+(\d{4})$/);
                if (m && mesMap[m[1]]) {
                  return { mes: mesMap[m[1]], anio: parseInt(m[2]) };
                }
              }
              return null;
            }, MESES_ES);

            if (!info) { console.log('  ⚠️ No encontró header del calendario'); break; }

            const diff = (yyyy - info.anio) * 12 + (mm - info.mes);
            console.log(`  Calendario: ${info.mes}/${info.anio} → diff: ${diff}`);
            if (diff === 0) break;

            const navOk = await contexto.evaluate((avanzar) => {
              for (const btn of document.querySelectorAll('button')) {
                const r = btn.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const txt = btn.textContent.trim();
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                const title = (btn.getAttribute('title') || '').toLowerCase();
                const esAvanzar = txt === '↓' || aria.includes('siguiente') || title.includes('siguiente') || aria.includes('next') || title.includes('next');
                const esRetroceder = txt === '↑' || aria.includes('anterior') || title.includes('anterior') || aria.includes('prev') || title.includes('prev');
                if (avanzar && esAvanzar) { btn.click(); return true; }
                if (!avanzar && esRetroceder) { btn.click(); return true; }
              }
              return false;
            }, diff > 0);

            if (!navOk) { console.log('  ⚠️ No encontró botón de navegación'); break; }
            await sleep(500);
          }

          // 3. Click en el día correcto
          const diaOk = await contexto.evaluate((dia) => {
            const diaStr = String(dia);
            const diaStr2 = String(dia).padStart(2, '0');
            const candidatos = Array.from(document.querySelectorAll('button, td, [role="gridcell"]'))
              .filter(el => {
                const t = (el.textContent || '').trim();
                if (t !== diaStr && t !== diaStr2) return false;
                const r = el.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.width < 80 && r.height < 80 && r.y > 80;
              });
            if (candidatos.length === 0) return false;
            const cel = candidatos.find(e => e.tagName === 'BUTTON') || candidatos[0];
            cel.click();
            return true;
          }, dd);

          if (diaOk) {
            console.log(`  ✅ ${label}: click en día ${dd}`);
          } else {
            console.log(`  ⚠️ ${label}: no encontró día ${dd} en el calendario`);
          }

          // Esperar más tiempo a que Power BI procese el filtro
          await sleep(3000);

          const val = await contexto.evaluate(el => el.value, inp);
          console.log(`  ✅ ${label} = "${val}"`);
        })(),
        timeoutPromise
      ]);
    } catch (e) {
      console.log(`  ⚠️ Error en ${label}: ${e.message}`);
      try { await contexto.keyboard.press('Escape'); } catch (_) {}
      await sleep(1000);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  await sleep(15000); // más tiempo para que Power BI termine de re-renderizar con --single-process
}

// ─── EXPORTAR TABLA ───────────────────────────────────────────────────────────
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

  const cx    = tablaRect ? tablaRect.x + Math.round(tablaRect.w / 2) : 800;
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
        return ['Exportar', 'Export'].includes(b.textContent.trim()) && r.width > 0;
      });
      if (btns.length === 0) return false;
      btns[btns.length - 1].click();
      return true;
    });
    if (ok) { console.log(`  ✅ Diálogo confirmado`); break; }
    if (i % 4 === 0) console.log(`  ⌛ Esperando diálogo... ${i + 1}/20`);
    await sleep(500);
  }
}

// ─── ENVIAR EMAIL (nodemailer + Gmail App Password) ──────────────────────────
async function enviarEmail(archivoPath, fecha) {
  console.log(`\n📧 Enviando email a ${CONFIG.emailDestino}...`);

  const fileName = path.basename(archivoPath);
  const attachments = [{ filename: fileName, path: archivoPath }];

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailAppPass },
  });

  await transporter.sendMail({
    from: `"Asistencia Power BI" <${CONFIG.gmailUser}>`,
    to: CONFIG.emailDestino,
    subject: `Asistencia Google_CO ${fecha}`,
    text: `Adjunto el reporte de asistencia del ${fecha}.`,
    attachments,
  });

  console.log('  ✅ Email enviado');
}

// ─── FUNCIÓN PRINCIPAL ────────────────────────────────────────────────────────
let _corriendo = false;

async function descargarAsistencia() {
  if (_corriendo) {
    console.log('⚠️  Ya hay una ejecución en curso — ignorando solicitud duplicada');
    return { ok: false, error: 'Ejecución duplicada ignorada' };
  }
  _corriendo = true;
  const fecha = getFechaActual();
  console.log('═══════════════════════════════════════════');
  console.log('  Descarga Asistencia Power BI — CLOUD');
  console.log(`  Fecha: ${fecha}`);
  console.log('═══════════════════════════════════════════\n');

  if (!fs.existsSync(CONFIG.downloadPath)) {
    fs.mkdirSync(CONFIG.downloadPath, { recursive: true });
  }

  const archivosAntes = new Set(fs.readdirSync(CONFIG.downloadPath));

  // Reintento completo: si Chrome crashea a mitad del flujo, se relanza
  // un browser NUEVO desde cero (reintentar sobre la página muerta produce
  // "Requesting main frame too early!").
  const MAX_INTENTOS = 2;
  let ultimoError = null;

  try {
  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
  if (intento > 1) {
    console.log(`\n🔄 Reintento completo ${intento}/${MAX_INTENTOS} con browser nuevo...`);
    await sleep(10000);
  }
  let browser;

  try {
    // Limpiar instancias anteriores de Chrome que quedaron como zombie
    // (cross-platform: en Windows local esto antes no hacía nada)
    limpiarChromeHuerfano();
    await sleep(5000);

    browser = await puppeteer.launch({
      headless: 'new',
      protocolTimeout: 600000,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        // ⚠️ NO usar --single-process ni --no-zygote: con Power BI (página muy
        // pesada) el renderer crashea a mitad de la exportación
        // ("Session closed" / "Requesting main frame too early").
        '--window-size=1280,800',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--disable-images',
        '--disable-plugins',
        '--disable-translate',
        '--disable-sync',
        '--disable-background-networking',
        '--disable-default-apps',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-component-update',
        '--lang=es-CL',
        '--accept-lang=es-CL,es,en',
      ],
      env: { ...process.env, LANG: 'es_CL.UTF-8', LANGUAGE: 'es_CL:es' },
      defaultViewport: { width: 1280, height: 800 },
    });

    const page = await browser.newPage();
    page.on('error', err => console.log(`  💥 Página crasheó: ${err.message}`));
    browser.on('disconnected', () => console.log('  💥 Browser desconectado'));
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Configurar carpeta de descargas vía CDP (Page-level, con fallback Browser-level)
    const cdp = await page.createCDPSession();
    try {
      await cdp.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: CONFIG.downloadPath,
      });
      console.log('  ✅ Download behavior configurado (Page-level)');
    } catch (_) {
      try {
        const cdpBrowser = await page.target().createCDPSession();
        await cdpBrowser.send('Browser.setDownloadBehavior', {
          behavior: 'allow',
          downloadPath: CONFIG.downloadPath,
        });
        console.log('  ✅ Download behavior configurado (Browser-level)');
      } catch (e2) {
        console.log(`  ⚠️ No se pudo configurar download behavior: ${e2.message}`);
      }
    }

    // Navegar
    console.log('📍 Navegando a Power BI...');
    await page.goto(CONFIG.powerBiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);

    let url = page.url();

    // Login
    console.log(`\n🔑 Login... URL: ${url.substring(0, 80)}`);

    // Login con reintento: si falla, espera 15s y vuelve a intentar
    let loginOk = false;
    for (let loginIntento = 1; loginIntento <= 3 && !loginOk; loginIntento++) {
      try {
        if (loginIntento > 1) {
          console.log(`  🔄 Reintento de login #${loginIntento}...`);
          await page.goto(CONFIG.powerBiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await sleep(5000);
          url = page.url();
        }
        if (url.includes('singleSignOn') || url.includes('powerbi.com/signin') || url.includes('login.microsoftonline') || url.includes('login.microsoft')) {
          await loginPowerBI(page); await sleep(3000); url = page.url();
        }
        if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
          await loginMicrosoft(page); await sleep(3000); url = page.url();
        }
        if (url.includes('login.microsoftonline') || url.includes('login.microsoft')) {
          await manejarKMSI(page); await sleep(3000); url = page.url();
        }
        loginOk = true;
      } catch (e) {
        console.log(`  ⚠️ Error en login (intento ${loginIntento}/3): ${e.message}, capturando screenshot...`);
        try { await page.screenshot({ path: path.join(CONFIG.downloadPath, `debug-login-error-${loginIntento}.png`) }); } catch (_) {}
        console.log(`  URL actual después del error: ${page.url().split('?')[0]}`);
        if (loginIntento === 3) throw e;
        await sleep(15000);
      }
    }

    // Esperar reporte
    console.log('\n⏳ Esperando reporte...');
    try {
      await page.waitForFunction(
        () => window.location.href.includes('app.powerbi.com/groups'),
        { timeout: 120000 }
      );
    } catch (e) {
      // Si no llegó a /groups, capturar screenshot para debugging
      console.log('  ⚠️ No llegó a /groups, intentando verificar URL actual...');
      try { await page.screenshot({ path: path.join(CONFIG.downloadPath, 'debug-timeout.png') }); } catch (_) {}
      const currentUrl = await page.evaluate(() => window.location.href);
      console.log(`  URL actual: ${currentUrl.substring(0, 100)}`);

      // Reintentar esperando a que cargue el elemento visual principal
      console.log('  Esperando a que cargue el elemento visual...');
      await page.waitForSelector('.powerVisual, [data-visual-id], .vcContainer, .powerVisualsContainer',
        { timeout: 120000 }).catch(() => console.log('  ⚠️ Selector visual no encontrado'));
    }

    await sleep(15000); // Power BI tarda más en renderizar en headless
    console.log('✅ Reporte cargado o timeout manejado');

    // Fechas
    console.log(`\n📅 Seteando fecha: ${getFechaFiltro()}`);
    try {
      await setearFecha(page, getFechaFiltro());
    } catch (e) {
      console.log(`  ⚠️ Error en setearFecha (continuando): ${e.message}`);
    }

    // Validar que la página sigue viva antes de exportar
    console.log('\n🔍 Validando que la página siga respondiendo...');
    let paginaViva = false;
    for (let i = 0; i < 10; i++) {
      try {
        const isAlive = await page.evaluate(() => document.body !== null);
        if (isAlive) { paginaViva = true; console.log('  ✅ Página respondiendo'); break; }
      } catch (e) {
        console.log(`  ⌛ Esperando página (${i + 1}/10): ${e.message}`);
        await sleep(3000);
      }
    }
    if (!paginaViva) console.log('  ⚠️ Página no respondió, intentando exportar igual...');

    // Exportar
    console.log('\n📥 Exportando...');
    try {
      await exportarTabla(page);
    } catch (e) {
      console.log(`  ⚠️ Error en exportarTabla: ${e.message}`);
      // Si la página/browser crasheó, reintentar aquí no sirve
      // ("Requesting main frame too early!"). Lanzar el error para que
      // el reintento externo relance un browser completo.
      const patronCrash = /Session closed|Target closed|main frame too early|detached|Protocol error/i;
      let paginaOk = false;
      if (!patronCrash.test(e.message)) {
        try { paginaOk = await page.evaluate(() => document.body !== null); } catch (_) {}
      }
      if (!paginaOk) {
        throw new Error(`Página crasheada durante exportación: ${e.message}`);
      }
      // La página sigue viva: reintentar la exportación una sola vez
      await sleep(3000);
      await exportarTabla(page);
    }

    // Esperar descarga
    console.log('\n⏳ Esperando descarga...');
    let archivoDescargado = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      const nuevos = fs.readdirSync(CONFIG.downloadPath).filter(f =>
        !archivosAntes.has(f) && f.endsWith('.xlsx') && !f.endsWith('.crdownload') && !f.includes('.tmp')
      );
      if (nuevos.length > 0) {
        const reciente = nuevos.sort((a, b) =>
          fs.statSync(path.join(CONFIG.downloadPath, b)).mtime - fs.statSync(path.join(CONFIG.downloadPath, a)).mtime
        )[0];
        const stat = fs.statSync(path.join(CONFIG.downloadPath, reciente));
        if (stat.size > 1024) {
          archivoDescargado = reciente;
          console.log(`  ✅ ${reciente} (${Math.round(stat.size / 1024)} KB)`);
          break;
        }
      }
      if (i % 5 === 0) console.log(`  ⌛ ${i + 1}/60...`);
    }
    if (!archivoDescargado) throw new Error('No se descargó ningún archivo');

    // Renombrar
    const nombreFinal = `asistencia-${fecha}.xlsx`;
    const rutaVieja = path.join(CONFIG.downloadPath, archivoDescargado);
    const rutaNueva = path.join(CONFIG.downloadPath, nombreFinal);
    if (rutaVieja !== rutaNueva) {
      if (fs.existsSync(rutaNueva)) fs.unlinkSync(rutaNueva);
      fs.renameSync(rutaVieja, rutaNueva);
    }

    console.log('\n✅ ¡Descarga completada!');

    // Enviar email
    await enviarEmail(rutaNueva, fecha);

    return { ok: true, archivo: nombreFinal };

  } catch (err) {
    console.error(`\n❌ ERROR (intento ${intento}/${MAX_INTENTOS}): ${err.message}`);
    ultimoError = err;
  } finally {
    if (browser) {
      try { await sleep(1000); await browser.close(); } catch (_) {}
    }
  }
  } // fin for intentos

  return { ok: false, error: ultimoError ? ultimoError.message : 'Error desconocido' };
  } finally {
    _corriendo = false;
  }
}

// ─── SERVIDOR HTTP (requerido por Cloud Run) ──────────────────────────────────
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // El Cloud Runner ya ocupa el puerto — ejecutar descarga directamente
    descargarAsistencia().then(r => {
      console.log('Resultado:', JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    });
  } else {
    throw err;
  }
});

server.listen(CONFIG.port, () => {
  console.log(`🟢 Servidor escuchando en puerto ${CONFIG.port}`);
});
