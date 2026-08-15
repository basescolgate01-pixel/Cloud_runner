/**
 * _cleanup.js
 * Mata procesos de Chrome/Chromium huérfanos antes de lanzar Puppeteer.
 * Cross-platform: en Windows usa PowerShell filtrando por línea de comando,
 * en Linux/Mac usa pkill.
 *
 * ⚠️ IMPORTANTE: en Windows, Puppeteer lanza procesos llamados "chrome.exe",
 * el MISMO nombre que el Chrome normal que usa el usuario. Un `taskkill /IM
 * chrome.exe` a secas mata TODO Chrome abierto en la PC, ventanas del usuario
 * incluidas. Por eso acá filtramos por "--headless", una flag que solo llevan
 * los procesos que lanza Puppeteer, nunca una ventana normal de Chrome.
 */
const { execSync } = require('child_process');

function limpiarChromeHuerfano() {
  const esWindows = process.platform === 'win32';
  try {
    if (esWindows) {
      // Solo mata procesos chrome.exe / headless_shell.exe que tengan
      // "--headless" en su línea de comando (los de Puppeteer).
      const ps = `
        Get-CimInstance Win32_Process |
        Where-Object { $_.Name -match 'chrome\\.exe|headless_shell\\.exe' -and $_.CommandLine -match '--headless' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
      `.replace(/\s+/g, ' ').trim();
      execSync(`powershell -NoProfile -Command "${ps}"`, { stdio: 'ignore' });
    } else {
      execSync('pkill -9 -f "chrome.*--headless|chromium.*--headless|headless_shell" || true', { stdio: 'ignore' });
    }
  } catch (_) {
    // No hay procesos que matar — no es un error real.
  }
}

module.exports = { limpiarChromeHuerfano };
