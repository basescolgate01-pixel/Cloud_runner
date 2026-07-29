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

  // Gmail remitente — OAuth2
  gmailUser:          process.env.GMAIL_USER          || 'notificaciones.colgate@gmail.com',
  gmailClientId:      process.env.GMAIL_CLIENT_ID     || '',
  gmailClientSecret:  process.env.GMAIL_CLIENT_SECRET || '',
  gmailRefreshToken:  process.env.GMAIL_REFRESH_TOKEN || '',

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
  console.log(`  URL actual: ${page.url()}`);
  const screenshotPath = process.env.RAILWAY_ENVIRONMENT ? '/data/debug-login.png' : '/tmp/debug-login.png';
  await page.screenshot({ path: screenshotPath }).catch(() => {});
  console.log(`  Screenshot guardado en ${screenshotPath}`);

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
      await Promise.race([
        contexto.evaluate(el => {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(el, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, inp),
        sleep(10000), // máx 10s para esta operación
      ]);
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
      await Promise.race([
        contexto.evaluate(el => {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        }, inp),
        sleep(10000), // máx 10s para esta operación
      ]);
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

// ─── ENVIAR EMAIL (Gmail API + OAuth2) ───────────────────────────────────────
async function enviarEmail(archivoPath, fecha) {
  console.log(`\n📧 Enviando email a ${CONFIG.emailDestino}...`);

  // 1. Obtener access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CONFIG.gmailClientId,
      client_secret: CONFIG.gmailClientSecret,
      refresh_token: CONFIG.gmailRefreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!tokenRes.ok) throw new Error(`Token error: ${await tokenRes.text()}`);
  const { access_token } = await tokenRes.json();

  // 2. Construir MIME manualmente
  const boundary = 'boundary_' + Date.now();
  const fileBytes = fs.readFileSync(archivoPath);
  const fileB64   = fileBytes.toString('base64');
  const filename  = path.basename(archivoPath);

  const mime = [
    `MIME-Version: 1.0`,
    `From: "Asistencia Power BI" <${CONFIG.gmailUser}>`,
    `To: ${CONFIG.emailDestino}`,
    `Subject: Asistencia Google_CO ${fecha}`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    ``,
    `Adjunto el reporte de asistencia del ${fecha}.`,
    ``,
    `--${boundary}`,
    `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${filename}"`,
    ``,
    fileB64,
    `--${boundary}--`,
  ].join('\r\n');

  const raw = Buffer.from(mime).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // 3. Enviar via Gmail API
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (!sendRes.ok) throw new Error(`Gmail API error: ${await sendRes.text()}`);

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
      protocolTimeout: 300000,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
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

    // Ir directo al login de Microsoft (evita el SSO automático que se cuelga)
    console.log('📍 Navegando al login de Microsoft...');
    const loginUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=871c010f-5e61-4fb1-83ac-98610a7e9110&response_type=code&redirect_uri=https://app.powerbi.com/signin/index.html&scope=openid&login_hint=${encodeURIComponent(CONFIG.pbiEmail)}`;
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
    let url = page.url();
    console.log(`  URL: ${url}`);

    // Login
    console.log('\n🔑 Login...');

    // Pantalla pick-account (varias cuentas)
    if (url.includes('microsoftonline') && await page.$('[data-test-id="tiles-user-row"], div[role="option"]').catch(() => null)) {
      console.log('  Pick-account detectado...');
      const clickeado = await page.evaluate((email) => {
        const els = Array.from(document.querySelectorAll('[data-test-id="tiles-user-row"], div[role="option"]'));
        const match = els.find(e => e.textContent.includes(email));
        if (match) { match.click(); return true; }
        return false;
      }, CONFIG.pbiEmail);
      console.log(clickeado ? '  ✅ Cuenta seleccionada' : '  ⚠ No se encontró la cuenta');
      await sleep(3000); url = page.url();
    }

    // Pantalla de email
    if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
      const tieneEmail = await page.$('input[name="loginfmt"], input[type="email"]').catch(() => null);
      if (tieneEmail) { await loginPowerBI(page); await sleep(3000); url = page.url(); }
    }

    // Pantalla de contraseña
    if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
      await loginMicrosoft(page); await sleep(3000); url = page.url();
    }

    // KMSI
    if (url.includes('microsoftonline') || url.includes('login.microsoft')) {
      await manejarKMSI(page); await sleep(3000); url = page.url();
    }

    // Si aún no llegamos al reporte, navegar a él
    if (!url.includes('app.powerbi.com/groups')) {
      console.log('📍 Navegando al reporte...');
      await page.goto(CONFIG.powerBiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(3000);
    }

    // Esperar reporte
    console.log('\n⏳ Esperando reporte...');
    await page.waitForFunction(
      () => window.location.href.includes('app.powerbi.com/groups'),
      { timeout: 60000 }
    );
    await sleep(25000); // Power BI tarda más en renderizar en headless (25s para notebooks lentos)
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
