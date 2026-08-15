/**
 * get-gmail-token.js
 * Genera un refresh_token de Gmail con el scope gmail.send.
 *
 * Uso:
 *   node scripts/get-gmail-token.js
 *
 * Necesitas tener en variables de entorno (o hardcodear abajo):
 *   GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET
 *
 * Sigue las instrucciones en pantalla.
 */

const http = require('http');
const { exec } = require('child_process');

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID     || 'PEGA_TU_CLIENT_ID_AQUI';
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'PEGA_TU_CLIENT_SECRET_AQUI';
const REDIRECT_URI  = 'http://localhost:4000/oauth2callback';
const SCOPE         = 'https://www.googleapis.com/auth/gmail.send';

const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
  `client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}` +
  `&access_type=offline` +
  `&prompt=consent`;   // ← fuerza nuevo refresh_token aunque ya existiera uno

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  Generador de Gmail Refresh Token');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
console.log('1. Se abrirá una ventana en el navegador.');
console.log('2. Inicia sesión con notificaciones.colgate@gmail.com');
console.log('3. Acepta el permiso "Enviar correo".');
console.log('4. El refresh_token se mostrará aquí automáticamente.\n');

// Abrir navegador
const start = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
exec(`${start} "${authUrl}"`);
console.log('Abriendo navegador...\n(Si no abre automáticamente, copia esta URL:)');
console.log(authUrl + '\n');

// Mini servidor HTTP para capturar el código de autorización
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4000');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`<h2>Error: ${error}</h2>`);
    console.error('\n❌ Error OAuth:', error);
    server.close();
    return;
  }

  if (!code) {
    res.end('<h2>Esperando código...</h2>');
    return;
  }

  res.end('<h2>✅ Código recibido. Puedes cerrar esta ventana.</h2><p>Revisa la terminal para el refresh_token.</p>');

  // Intercambiar código por tokens
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    'authorization_code',
      }),
    });
    const data = await tokenRes.json();

    if (data.error) throw new Error(data.error_description || data.error);

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ ¡LISTO! Copia este valor a Railway:\n');
    console.log(`  Variable:  GMAIL_REFRESH_TOKEN`);
    console.log(`  Valor:     ${data.refresh_token}`);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (!data.refresh_token) {
      console.log('⚠️  No se recibió refresh_token. Asegúrate de que el proyecto');
      console.log('   Google Cloud tenga la app en modo "Test" y tu cuenta agregada,');
      console.log('   o publica la app para producción.\n');
    }
  } catch (err) {
    console.error('\n❌ Error al obtener token:', err.message);
  }

  server.close();
});

server.listen(4000, () => {
  console.log('Escuchando en http://localhost:4000 ...\n');
});
