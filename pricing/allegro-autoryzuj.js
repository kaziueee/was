'use strict';

// Podpięcie konta Allegro do repricera. Uruchamia się RAZ na konto (i ponownie po >3 miesiącach bez
// odświeżania tokenu). Dwie drogi — zależnie od TYPU aplikacji w apps.developer.allegro.pl (typu nie da
// się zmienić po rejestracji):
//
//   node pricing/allegro-autoryzuj.js EKAJTEK                 — aplikacja „bez dostępu do przeglądarki”
//        (device flow): link allegro.pl/skojarz-aplikacje?code=…, skrypt sam czeka na zgodę.
//   node pricing/allegro-autoryzuj.js EKAJTEK --przegladarka  — aplikacja „z dostępem do przeglądarki”
//        (authorization code): link allegro.pl/auth/oauth/authorize…, po „Zezwól” Allegro przekierowuje
//        przeglądarkę na ALLEGRO_REDIRECT_URI (domyślnie http://localhost:8765/allegro/callback — ten adres
//        musi być wpisany w aplikacji jako adres przekierowania), a skrypt odbiera kod na tym porcie.
//        Kod jest ważny 10 s, więc wymieniamy go od razu. Skrypt na SRV + przeglądarka na Macu = tunel:
//        ssh -L 8765:127.0.0.1:8765 Adm@<SRV> "cd C:\was; node pricing\allegro-autoryzuj.js EKAJTEK --przegladarka"
//
// Link otwiera człowiek ZALOGOWANY na właściwe konto Allegro i klika „Zezwól”. Skrypt sprawdza w /me, że
// token jest od tego konta (inny login = nic nie zapisujemy) i zapisuje tokeny w pricing.db (allegro_tokeny).
// Hasła nikt tu nie wpisuje — logowanie jest po stronie Allegro.

require('../config/env');
const http = require('http');
const crypto = require('crypto');
const allegro = require('./allegro');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REDIRECT = () => process.env.ALLEGRO_REDIRECT_URI || 'http://localhost:8765/allegro/callback';

async function main(argv) {
  const konto = String(argv.find((x) => !x.startsWith('--')) || '').toUpperCase();
  const def = allegro.KONTA[konto];
  if (!def) throw new Error(`Użycie: node pricing/allegro-autoryzuj.js <${Object.keys(allegro.KONTA).join('|')}> [--przegladarka]`);
  if (!allegro.skonfigurowany()) throw new Error('Brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET w .env (aplikacja „WMS Price” z apps.developer.allegro.pl)');
  console.log(`\nKonto: ${def.nazwa} (login Allegro: ${def.login})`);
  console.log('1. Zaloguj się w przeglądarce na TO konto Allegro (inne konto = autoryzacja zostanie odrzucona).');
  const t = argv.includes('--przegladarka') ? await przezPrzegladarke() : await przezUrzadzenie();
  return zapisz(konto, def, t);
}

// Device flow — aplikacja typu „bez dostępu do przeglądarki”.
async function przezUrzadzenie() {
  const d = await allegro.postAuth('device', { client_id: process.env.ALLEGRO_CLIENT_ID });
  if (d.status !== 200 || !d.j.device_code) throw new Error(`Allegro nie wydało kodu urządzenia: HTTP ${d.status} ${d.j.error || ''} ${d.j.error_description || ''}`
    + (d.j.error === 'unauthorized_client' ? ' — aplikacja jest typu „z przeglądarką”? Uruchom z --przegladarka.' : ''));
  const { device_code: kod, user_code: kodUzytkownika, verification_uri_complete: link, expires_in: wazny } = d.j;
  let co = Math.max(5, Number(d.j.interval) || 5);
  console.log(`2. Otwórz: ${link}`);
  console.log(`   (kod: ${String(kodUzytkownika).replace(/(...)(...)(...)/, '$1 $2 $3')}) i kliknij „Zezwól”.`);
  console.log(`Czekam na zgodę do ${Math.round((Number(wazny) || 3600) / 60)} min…\n`);

  const koniec = Date.now() + (Number(wazny) || 3600) * 1000;
  while (Date.now() < koniec) {
    await sleep(co * 1000);
    const t = await allegro.postAuth('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: kod });
    if (t.status === 200 && t.j.access_token) return t.j;
    const blad = t.j.error;
    if (blad === 'authorization_pending') continue;
    if (blad === 'slow_down') { co += 5; continue; }
    if (blad === 'access_denied') throw new Error('Odmówiono zgody w Allegro — nic nie zapisano.');
    throw new Error(`Allegro odrzuciło kod: HTTP ${t.status} ${blad || ''} ${t.j.error_description || ''}`);
  }
  throw new Error('Kod wygasł bez zgody — uruchom skrypt jeszcze raz.');
}

// Authorization code — aplikacja typu „z dostępem do przeglądarki”. Lokalny serwer tylko na 127.0.0.1,
// tylko na czas autoryzacji (najwyżej 10 min); `state` odrzuca odpowiedź, która nie jest na nasz link.
function przezPrzegladarke() {
  const redirect = new URL(REDIRECT());
  const state = crypto.randomBytes(16).toString('hex');
  const link = 'https://allegro.pl/auth/oauth/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: process.env.ALLEGRO_CLIENT_ID, redirect_uri: redirect.href, state,
    prompt: 'confirm',              // Allegro pokaże, NA JAKIE konto dajemy zgodę — zanim klikniemy „Zezwól”
  });
  return new Promise((resolve, reject) => {
    let gotowe = false;
    const koniec = (blad, wynik) => { if (gotowe) return; gotowe = true; clearTimeout(limit); serwer.close(); blad ? reject(blad) : resolve(wynik); };
    const odpowiedz = (res, kod, tekst) => { res.writeHead(kod, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><meta charset="utf-8"><p style="font:16px sans-serif">${tekst}</p>`); };
    const serwer = http.createServer(async (req, res) => {
      const u = new URL(req.url, redirect.origin);
      if (u.pathname !== redirect.pathname) return odpowiedz(res, 404, 'Nie ten adres.');
      if (u.searchParams.get('state') !== state) return odpowiedz(res, 400, 'Ten link nie pochodzi z bieżącej autoryzacji — uruchom skrypt ponownie.');
      if (u.searchParams.get('error')) {
        odpowiedz(res, 200, 'Zgoda nie została udzielona. Możesz zamknąć tę kartę.');
        return koniec(new Error(`Allegro: ${u.searchParams.get('error')} — nic nie zapisano.`));
      }
      const code = u.searchParams.get('code');
      if (!code) return odpowiedz(res, 400, 'Brak kodu autoryzacji w adresie.');
      try {
        // Kod żyje 10 s — wymiana od razu, w tym samym żądaniu.
        const t = await allegro.postAuth('token', { grant_type: 'authorization_code', code, redirect_uri: redirect.href });
        if (t.status !== 200 || !t.j.access_token) throw new Error(`wymiana kodu odrzucona: HTTP ${t.status} ${t.j.error || ''} ${t.j.error_description || ''}`);
        odpowiedz(res, 200, 'Gotowe — WMS dostał zgodę. Możesz zamknąć tę kartę; wynik jest w terminalu.');
        koniec(null, t.j);
      } catch (e) {
        odpowiedz(res, 500, `Błąd: ${e.message}`);
        koniec(e);
      }
    });
    const limit = setTimeout(() => koniec(new Error('Brak zgody w 10 min — uruchom skrypt jeszcze raz.')), 10 * 60_000);
    serwer.on('error', (e) => koniec(new Error(`Nie da się nasłuchiwać na ${redirect.host}: ${e.message}`)));
    serwer.listen(Number(redirect.port) || 80, '127.0.0.1', () => {
      console.log(`2. Otwórz: ${link}`);
      console.log(`   i kliknij „Zezwól”. Allegro przekieruje na ${redirect.href} — ten adres musi być wpisany w aplikacji.`);
      console.log('Czekam na zgodę do 10 min…\n');
    });
  });
}

async function zapisz(konto, def, t) {
  // Login sprawdzamy, ZANIM cokolwiek zapiszemy — tym samym linkiem da się zalogować na dowolne konto.
  const r = await fetch('https://api.allegro.pl/me', {
    headers: { Authorization: `Bearer ${t.access_token}`, Accept: 'application/vnd.allegro.public.v1+json', 'User-Agent': allegro.USER_AGENT() },
    signal: AbortSignal.timeout(30_000),
  });
  const me = await r.json().catch(() => ({}));
  if (!r.ok || !me.login) throw new Error(`Nie udało się odczytać konta (/me HTTP ${r.status}) — nic nie zapisano.`);
  if (String(me.login).toLowerCase() !== def.login.toLowerCase()) {
    throw new Error(`Zgodę dało konto „${me.login}”, a to miało być „${def.login}” — nic nie zapisano. Wyloguj się z Allegro, zaloguj na ${def.login} i uruchom skrypt ponownie.`);
  }
  let scope = t.scope || '';
  try { scope = scope || JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url').toString()).scope.join(' '); } catch { /* bez scope w odpowiedzi */ }
  allegro.zapiszTokeny(konto, t, { login: me.login, uzytkownik: me.id });
  console.log(`Zapisano: ${def.nazwa} = ${me.login} (id ${me.id}).`);
  console.log(`Uprawnienia: ${scope || '?'}`);
  if (!/sale:offers:write/.test(scope)) console.log('UWAGA: brak allegro:api:sale:offers:write — odczyt zadziała, zmiana ceny nie. Dodaj uprawnienie w aplikacji i podepnij konto ponownie.');
}

main(process.argv.slice(2)).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
