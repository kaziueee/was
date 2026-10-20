'use strict';

// Jednorazowa zgoda Gmail na WYSYŁANIE raportu sprzedaży (services/gmail-wysylka.js, zakres gmail.send).
//   node scripts/gmail-zgoda.js --klient "<ścieżka do pliku klienta OAuth .json>"
//
// Uruchamiasz na komputerze z przeglądarką (Mac). Skrypt otwiera stronę zgody Google, Ty logujesz się kontem, z którego
// mają wychodzić raporty, i zatwierdzasz wyłącznie „Wysyłanie e-maili w Twoim imieniu” — bez czytania i kasowania.
// Klient OAuth typu „Desktop” można wziąć z projektu Rozliczenia (.gmail-credentials.json — ten sam projekt Google
// Cloud, Gmail API już włączone; tam jest zgoda tylko do odczytu, tu osobna tylko do wysyłki).
//
// Wynik NIE jest wypisywany na ekran: trafia do pliku gmail-wysylka.env (uprawnienia 600, ignorowany przez git).
// Na serwer przenosi się go dwiema komendami, które skrypt wypisuje na końcu — potem `scripts/sekrety.js zaszyfruj`
// chowa klucze w .env.dpapi, a lokalny plik trzeba skasować.

const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { SCOPE } = require('../services/gmail-wysylka');

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };
const KLIENT = arg('--klient');
const PORT = Number(arg('--port')) || 8732;
const WYNIK = 'gmail-wysylka.env';

if (!KLIENT || !fs.existsSync(KLIENT)) {
  console.error('Podaj plik klienta OAuth: --klient "/Users/mati/Documents/Projekty AI/Rozliczenia/.gmail-credentials.json"');
  process.exit(1);
}
const d = JSON.parse(fs.readFileSync(KLIENT, 'utf8'));
const k = d.installed || d.web || d;
if (!k.client_id) { console.error('W pliku klienta nie ma client_id'); process.exit(1); }

const verifier = crypto.randomBytes(48).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const stan = crypto.randomBytes(16).toString('hex');
const redirect = `http://127.0.0.1:${PORT}`;
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: k.client_id, redirect_uri: redirect, response_type: 'code', scope: SCOPE, access_type: 'offline',
  prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state: stan,
});

const serwer = http.createServer(async (req, res) => {
  const u = new URL(req.url, redirect);
  if (!u.searchParams.has('code') && !u.searchParams.has('error')) { res.writeHead(404); res.end(); return; }
  const zamknij = (kod, tekst) => { res.writeHead(kod, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<p style="font:16px sans-serif">${tekst}</p>`); serwer.close(); };
  if (u.searchParams.get('state') !== stan) return zamknij(400, 'Niezgodny stan żądania — uruchom skrypt jeszcze raz.');
  if (u.searchParams.has('error')) { zamknij(400, 'Zgoda odrzucona.'); console.error('Zgoda odrzucona:', u.searchParams.get('error')); process.exit(1); }
  try {
    const odp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: k.client_id, client_secret: k.client_secret || '', code: u.searchParams.get('code'),
        grant_type: 'authorization_code', redirect_uri: redirect, code_verifier: verifier }),
    });
    const j = await odp.json();
    if (!odp.ok || !j.refresh_token) throw new Error(`${odp.status} ${j.error || ''} ${j.error_description || ''} (brak refresh_token?)`);
    if (!String(j.scope || '').split(' ').includes(SCOPE)) throw new Error(`Google przyznał inny zakres: ${j.scope}`);
    fs.writeFileSync(WYNIK, `GMAIL_CLIENT_ID=${k.client_id}\nGMAIL_CLIENT_SECRET=${k.client_secret || ''}\nGMAIL_REFRESH_TOKEN=${j.refresh_token}\n`, { mode: 0o600 });
    zamknij(200, 'Gotowe — zgoda na wysyłanie zapisana. Możesz zamknąć tę kartę.');
    console.log(`\nZapisane do ${WYNIK} (uprawnienia 600; wartości nie wypisuję). Zakres: tylko wysyłanie.`);
    console.log('Przeniesienie na serwer i zaszyfrowanie (potem lokalny plik jest kasowany):');
    console.log(`  scp ${WYNIK} Adm@100.107.156.67:C:/was/${WYNIK}`);
    console.log(`  ssh Adm@100.107.156.67 "cd C:\\was; Get-Content ${WYNIK} | Add-Content .env; Remove-Item ${WYNIK}; node scripts/sekrety.js zaszyfruj"`);
    console.log(`  rm ${WYNIK}`);
    process.exit(0);
  } catch (e) {
    zamknij(500, 'Nie udało się wymienić kodu na token — szczegóły w terminalu.');
    console.error('Błąd wymiany kodu:', e.message);
    process.exit(1);
  }
});

serwer.listen(PORT, '127.0.0.1', () => {
  console.log('Otwieram stronę zgody Google (zakres: tylko wysyłanie maili). Jeśli przeglądarka się nie otworzy, wejdź na:\n' + url);
  execFile(process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open', [url], () => {});
});
