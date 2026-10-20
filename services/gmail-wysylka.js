'use strict';

// Wysyłka maili przez Gmail API z uprawnieniem WYŁĄCZNIE do wysyłania (scope gmail.send) — raport sprzedaży
// (services/analiza-raport.js). Bez hasła do skrzynki i bez nowych bibliotek (fetch z Node): token z tym zakresem
// nie przeczyta ani nie skasuje niczego w skrzynce. Ten sam wzorzec co Rozliczenia (scripts/gmail_api.py), tam z
// zakresem tylko do odczytu. Zgodę daje się raz: `node scripts/gmail-zgoda.js` (przeglądarka, klika właściciel konta).
//
// Konfiguracja (.env → `node scripts/sekrety.js zaszyfruj` przenosi je do .env.dpapi):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET — klient OAuth typu „Desktop” z Google Cloud Console
//   GMAIL_REFRESH_TOKEN                  — z gmail-zgoda.js
// budujMime() jest czysta (testy w test/gmail-wysylka.test.js).

const crypto = require('crypto');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const SCOPE = 'https://www.googleapis.com/auth/gmail.send';

const skonfigurowane = () => !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);

// Nagłówek z polskimi znakami: RFC 2047, UTF-8 base64 (tak robi każdy klient poczty).
const naglowek = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(String(s), 'utf8').toString('base64')}?=`);
const base64Linie = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n');
const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// MIME: multipart/related — HTML + obrazki inline (cid:), żeby zdjęcia były w treści, a nie załącznikiem obok.
function budujMime({ od = null, do: adresaci, temat, html, obrazy = [] }) {
  const lista = (Array.isArray(adresaci) ? adresaci : String(adresaci || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!lista.length) throw new Error('Brak adresatów');
  const granica = 'wms-' + crypto.randomBytes(12).toString('hex');
  const linie = [
    ...(od ? [`From: ${od}`] : []),
    `To: ${lista.join(', ')}`,
    `Subject: ${naglowek(temat)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${granica}"`,
    '',
    `--${granica}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    base64Linie(Buffer.from(html, 'utf8')),
  ];
  for (const o of obrazy) {
    linie.push(`--${granica}`, `Content-Type: ${o.typ || 'image/jpeg'}`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${o.cid}>`, `Content-Disposition: inline; filename="${o.cid.replace(/[^\w.-]/g, '_')}.jpg"`, '', base64Linie(o.bufor));
  }
  linie.push(`--${granica}--`, '');
  return linie.join('\r\n');
}

let token = null;   // { wartosc, wygasa }
async function tokenDostepu() {
  if (token && Date.now() < token.wygasa - 60_000) return token.wartosc;
  const odp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: process.env.GMAIL_CLIENT_ID, client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }),
  });
  const j = await odp.json().catch(() => ({}));
  if (!odp.ok || !j.access_token) throw new Error(`Gmail: odświeżenie tokenu nie powiodło się (${odp.status} ${j.error || ''}) — zgoda wygasła albo odwołana? node scripts/gmail-zgoda.js`);
  token = { wartosc: j.access_token, wygasa: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return token.wartosc;
}

async function wyslij(wiadomosc) {
  if (!skonfigurowane()) throw new Error('Gmail nieskonfigurowany (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN)');
  const raw = base64url(Buffer.from(budujMime(wiadomosc), 'utf8'));
  const odp = await fetch(SEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await tokenDostepu()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  const j = await odp.json().catch(() => ({}));
  if (!odp.ok) throw new Error(`Gmail: wysyłka nie powiodła się (${odp.status} ${j.error?.message || ''})`);
  return { id: j.id };
}

module.exports = { SCOPE, skonfigurowane, budujMime, wyslij, naglowek };
