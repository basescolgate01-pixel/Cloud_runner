/**
 * descarga-asistencia-geovictoria.js
 *
 * Requiere Node.js 18+ (usa fetch nativo).
 *
 * Qué hace:
 *  1. Login en GeoVictoria (API v1) para obtener token
 *  2. Trae usuarios activos -> arma el "Range" (lista de identificadores)
 *  3. Firma OAuth 1.0 (HMAC-SHA1) para llamar a /Activity/GetActivities
 *  4. Trae catálogo de proyectos y hace el cruce por IdProject
 *  5. Formatea fechas (yyyyMMddHHmmss -> DD-MM-AAAA) y arma FechaMarca
 *  6. Genera un CSV
 *  7. Envía el CSV por correo usando nodemailer + Gmail App Password
 *
 * Variables de entorno esperadas:
 *   GV_CONSUMER_KEY, GV_CONSUMER_SECRET
 *   EMAIL_DESTINO
 *   GMAIL_USER, GMAIL_APP_PASS
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  consumerKey:    process.env.GV_CONSUMER_KEY    || '4b79f6',
  consumerSecret: process.env.GV_CONSUMER_SECRET || '0f1761f7',

  urlLogin:      'https://apiv3.geovictoria.com/api/v1/Login',
  urlUsers:      'https://customerapi.geovictoria.com/api/v1/User/List',
  urlActivities: 'https://apiv3.geovictoria.com/api/Activity/GetActivities',
  urlProjects:   'https://apiv3.geovictoria.com/api/Project/List',

  // Carpeta de salida del CSV
  outputPath: process.env.RAILWAY_ENVIRONMENT
    ? '/tmp/asistencia'
    : path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads', 'asistencia'),

  // Email de destino
  emailDestino: process.env.EMAIL_DESTINO || 'mriquelme@ecrgroup.cl',
  saludoNombre: process.env.SALUDO_NOMBRE || 'Marceloco',

  // Gmail remitente — App Password (nodemailer)
  gmailUser:    process.env.GMAIL_USER     || 'notificaciones.colgate@gmail.com',
  gmailAppPass: process.env.GMAIL_APP_PASS || '',
};

// Columnas que el M original elimina al final
const COLUMNAS_A_QUITAR = [
  'IdActivity', 'IdTask', 'IdProject', 'IdStartPunch', 'IdEndPunch',
  'ProjectDescription', 'TaskDescription', 'Commentary',
  'OriginStartPunch', 'OriginEndPunch', 'StartDateIsModified',
  'EndDateIsModified', 'ActivityEnabled', 'ProyectoDescripcionCatalogo',
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Encoding RFC3986 estricto (igual a Uri.EscapeDataString en Power Query M).
// encodeURIComponent de JS no encodea ! * ' ( ) — OAuth 1.0 lo requiere.
function rfc3986Encode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Fecha de HOY en horario de Santiago, independiente de dónde corra el servidor
// (igual que getFechaPartes()/getFechaActual() en descarga-asistencia-cloud.js).
// Esto evita desalinear el rango from/to cuando el servidor está en UTC u otro huso.
function getFechaHoy() {
  const partes = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(new Date());
  const dia = partes.find((p) => p.type === 'day').value;
  const mes = partes.find((p) => p.type === 'month').value;
  const anio = partes.find((p) => p.type === 'year').value;
  return `${anio}${mes}${dia}`;
}

// Hora actual HH:mm en horario de Santiago (para "hora de extracción")
function getHoraExtraccion() {
  const partes = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const hh = partes.find((p) => p.type === 'hour').value;
  const mm = partes.find((p) => p.type === 'minute').value;
  return `${hh}:${mm}`;
}

// yyyyMMddHHmmss -> DD-MM-AAAA (igual a fnFormatFecha del M)
function formatFecha(s) {
  if (!s || String(s).length < 8) return '';
  const str = String(s);
  const anio = str.substring(0, 4);
  const mes = str.substring(4, 6);
  const dia = str.substring(6, 8);
  return `${dia}-${mes}-${anio}`;
}

// ─── FIRMA OAuth 1.0 (HMAC-SHA1) ──────────────────────────────────────────────
function buildOAuthHeader(method, url) {
  const params = {
    oauth_consumer_key: CONFIG.consumerKey,
    oauth_nonce: crypto.randomUUID().replace(/-/g, ''),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_version: '1.0',
  };

  const orderedKeys = Object.keys(params).sort();
  const paramStr = orderedKeys
    .map((k) => `${rfc3986Encode(k)}=${rfc3986Encode(params[k])}`)
    .join('&');

  const baseString = `${method}&${rfc3986Encode(url)}&${rfc3986Encode(paramStr)}`;
  const signingKey = `${rfc3986Encode(CONFIG.consumerSecret)}&`;

  const signature = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  const allParams = { ...params, oauth_signature: signature };
  const headerStr =
    'OAuth ' +
    Object.keys(allParams)
      .map((k) => `${k}="${rfc3986Encode(allParams[k])}"`)
      .join(', ');

  return headerStr;
}

async function postJson(url, headers, bodyObj) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(bodyObj),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Error ${res.status} en ${url}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Respuesta no-JSON de ${url}: ${text.slice(0, 300)}`);
  }
}

// ─── 1. LOGIN ─────────────────────────────────────────────────────────────────
async function login() {
  console.log('  [1] Login GeoVictoria...');
  const resp = await postJson(CONFIG.urlLogin, {}, {
    User: CONFIG.consumerKey,
    Password: CONFIG.consumerSecret,
  });
  if (!resp.token) throw new Error('Login sin token en la respuesta');
  console.log('  ✅ Token obtenido');
  return resp.token;
}

// ─── 2. USUARIOS ACTIVOS -> RANGE ─────────────────────────────────────────────
async function getRangeUsuarios(token) {
  console.log('  [2] Usuarios activos...');
  const resp = await postJson(CONFIG.urlUsers, { Authorization: token }, {});
  const lista = Array.isArray(resp) ? resp : (resp.data || resp.Data || []);
  const activos = lista.filter((u) => String(u.Enabled ?? '0') === '1');
  const range = activos.map((u) => String(u.Identifier ?? u.Id)).join(',');
  console.log(`  ✅ ${activos.length} usuarios activos`);
  return range;
}

// ─── 3. ACTIVIDADES ───────────────────────────────────────────────────────────
async function getActividades(rangeStr) {
  console.log('  [3] Actividades...');
  const authHeader = buildOAuthHeader('POST', CONFIG.urlActivities);
  const hoy = getFechaHoy();
  const resp = await postJson(CONFIG.urlActivities, { Authorization: authHeader }, {
    Range: rangeStr,
    from: `${hoy}000000`,
    to: `${hoy}235959`,
    includeAll: '0',
  });
  const lista = Array.isArray(resp) ? resp : (resp.data || resp.Data || []);
  console.log(`  ✅ ${lista.length} actividades`);
  return lista;
}

// ─── 4. PROYECTOS ─────────────────────────────────────────────────────────────
async function getProyectos() {
  console.log('  [4] Catálogo de proyectos...');
  const authHeader = buildOAuthHeader('POST', CONFIG.urlProjects);
  const resp = await postJson(CONFIG.urlProjects, { Authorization: authHeader }, {});
  const lista = Array.isArray(resp) ? resp : (resp.data || resp.Data || []);
  console.log(`  ✅ ${lista.length} proyectos`);
  return lista;
}

// ─── 5. UNIR + FORMATEAR (equivalente a los pasos 5 y 6 del M) ───────────────
function armarTablaFinal(actividades, proyectos) {
  console.log('  [5] Cruzando actividades con proyectos y formateando fechas...');

  const proyectosPorId = new Map();
  for (const p of proyectos) {
    const id = p.ProjectHashedId ?? p.Id;
    if (id != null) proyectosPorId.set(String(id), p);
  }

  const filas = actividades.map((act) => {
    const idProy = act.IdProject != null ? String(act.IdProject) : null;
    const match = idProy ? proyectosPorId.get(idProy) : null;
    const descCatalogo = match ? (match.ProjectDescription ?? match.Description ?? null) : null;

    const d1 = act.ProjectDescription ?? null;
    const proyecto =
      d1 && d1 !== '' ? d1 : descCatalogo && descCatalogo !== '' ? descCatalogo : 'Sin proyecto';

    const startDate = formatFecha(act.StartDate);
    const endDate = formatFecha(act.EndDate);
    const fechaMarca = startDate && startDate !== '' ? startDate : endDate;

    const fila = {
      ...act,
      Proyecto: proyecto,
      StartDate: startDate,
      EndDate: endDate,
      FechaMarca: fechaMarca,
    };

    for (const col of COLUMNAS_A_QUITAR) delete fila[col];

    return fila;
  });

  return filas;
}

// ─── 6. CSV ────────────────────────────────────────────────────────────────────
function escaparCsv(valor) {
  if (valor === null || valor === undefined) return '';
  const s = String(valor);
  if (/[",\n;]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function filasACsv(filas) {
  if (filas.length === 0) return '';

  // Unión ordenada de todas las columnas presentes en las filas
  const columnas = [];
  const vistas = new Set();
  for (const fila of filas) {
    for (const key of Object.keys(fila)) {
      if (!vistas.has(key)) {
        vistas.add(key);
        columnas.push(key);
      }
    }
  }

  const lineas = [columnas.map(escaparCsv).join(',')];
  for (const fila of filas) {
    lineas.push(columnas.map((c) => escaparCsv(fila[c])).join(','));
  }
  return lineas.join('\r\n');
}

// ─── 7. ENVIAR EMAIL (nodemailer + Gmail App Password) ───────────────────────
async function enviarEmail({ archivoPath, fechaSlash, horaExtraccion, totalActividades }) {
  console.log(`\n📧 Enviando email a ${CONFIG.emailDestino}...`);

  const filename = path.basename(archivoPath);
  const subject = `GeoVictoria - Actividades ${fechaSlash} (${horaExtraccion} hrs)`;

  const htmlBody = [
    `<p>Hola ${CONFIG.saludoNombre},</p>`,
    `<p>Se adjunta el CSV con las actividades de GeoVictoria del día ${fechaSlash}.</p>`,
    `<p>📊 Resumen:</p>`,
    `<ul>`,
    `<li>Total actividades: ${totalActividades}</li>`,
    `<li>Fecha: ${fechaSlash}</li>`,
    `<li>Hora de extracción: ${horaExtraccion} hrs</li>`,
    `<li>Archivo: ${filename}</li>`,
    `</ul>`,
    `<p>Este correo fue generado automáticamente.</p>`,
  ].join('');

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: CONFIG.gmailUser, pass: CONFIG.gmailAppPass },
  });

  await transporter.sendMail({
    from: `"Asistencia GeoVictoria" <${CONFIG.gmailUser}>`,
    to: CONFIG.emailDestino,
    subject,
    html: htmlBody,
    attachments: [{ filename, path: archivoPath }],
  });

  console.log('  ✅ Email enviado');
}

function validarConfigGmail() {
  const faltantes = [];
  if (!CONFIG.gmailUser) faltantes.push('GMAIL_USER');
  if (!CONFIG.gmailAppPass) faltantes.push('GMAIL_APP_PASS');
  if (faltantes.length > 0) {
    throw new Error(
      `Faltan variables de entorno para enviar el email: ${faltantes.join(', ')}. ` +
      `Generá un App Password en https://myaccount.google.com/apppasswords y configuralo en .env`
    );
  }
}

// ─── FUNCIÓN PRINCIPAL ─────────────────────────────────────────────────────────
async function descargarAsistenciaGeoVictoria() {
  const fecha = getFechaHoy();
  const fechaLegible = formatFecha(`${fecha}000000`);

  console.log('═══════════════════════════════════════════');
  console.log('  Descarga Asistencia GeoVictoria');
  console.log(`  Fecha: ${fechaLegible}`);
  console.log('═══════════════════════════════════════════\n');

  fs.mkdirSync(CONFIG.outputPath, { recursive: true });

  try {
    validarConfigGmail();

    const token = await login();
    const rangeStr = await getRangeUsuarios(token);
    const actividades = await getActividades(rangeStr);
    const proyectos = await getProyectos();
    const tablaFinal = armarTablaFinal(actividades, proyectos);

    const csv = filasACsv(tablaFinal);
    const horaExtraccion = getHoraExtraccion(); // HH:mm, se usa en el asunto y cuerpo del correo
    const fechaSlash = fechaLegible.replace(/-/g, '/'); // DD-MM-AAAA -> DD/MM/AAAA
    const nombreArchivo = `actividades_geovictoria_${fecha}.csv`;
    const rutaArchivo = path.join(CONFIG.outputPath, nombreArchivo);
    fs.writeFileSync(rutaArchivo, '\uFEFF' + csv, 'utf8'); // BOM para que Excel abra bien los acentos

    console.log(`\n✅ CSV generado: ${rutaArchivo} (${tablaFinal.length} filas)`);

    await enviarEmail({
      archivoPath: rutaArchivo,
      fechaSlash,
      horaExtraccion,
      totalActividades: tablaFinal.length,
    });

    return { ok: true, archivo: nombreArchivo, filas: tablaFinal.length };
  } catch (err) {
    console.error(`\n❌ ERROR: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ─── EJECUCIÓN DIRECTA ──────────────────────────────────────────────────────────
if (require.main === module) {
  descargarAsistenciaGeoVictoria().then((resultado) => {
    console.log('\n📦 Resultado:', JSON.stringify(resultado));
    process.exit(resultado.ok ? 0 : 1);
  });
}

module.exports = { descargarAsistenciaGeoVictoria };
