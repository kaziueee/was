'use strict';

// Podpięcie konta Allegro do repricera (device flow OAuth). Uruchamia się RAZ na konto (i ponownie po
// >3 miesiącach bez odświeżania tokenu):
//   node pricing/allegro-autoryzuj.js EKAJTEK
//   node pricing/allegro-autoryzuj.js NATROPIE
// Skrypt wypisuje link allegro.pl/skojarz-aplikacje?code=… — otwiera go człowiek, ZALOGOWANY na właściwe
// konto Allegro, i klika „Zezwól”. Skrypt czeka na zgodę, sprawdza w /me, że token jest od tego konta
// (inny login = nic nie zapisujemy) i zapisuje tokeny w pricing.db (tabela allegro_tokeny).
// Hasła nikt tu nie wpisuje — logowanie jest po stronie Allegro.

require('../config/env');
const allegro = require('./allegro');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(konto) {
  konto = String(konto || '').toUpperCase();
  const def = allegro.KONTA[konto];
  if (!def) throw new Error(`Użycie: node pricing/allegro-autoryzuj.js <${Object.keys(allegro.KONTA).join('|')}>`);
  if (!allegro.skonfigurowany()) throw new Error('Brak ALLEGRO_CLIENT_ID / ALLEGRO_CLIENT_SECRET w .env (aplikacja „WMS Pricing” z apps.developer.allegro.pl)');

  const d = await allegro.postAuth('device', { client_id: process.env.ALLEGRO_CLIENT_ID });
  if (d.status !== 200 || !d.j.device_code) throw new Error(`Allegro nie wydało kodu urządzenia: HTTP ${d.status} ${d.j.error || ''} ${d.j.error_description || ''}`);
  const { device_code: kod, user_code: kodUzytkownika, verification_uri_complete: link, expires_in: wazny } = d.j;
  let co = Math.max(5, Number(d.j.interval) || 5);
  console.log(`\nKonto: ${def.nazwa} (login Allegro: ${def.login})`);
  console.log('1. Zaloguj się w przeglądarce na TO konto Allegro (inne konto = autoryzacja zostanie odrzucona).');
  console.log(`2. Otwórz: ${link}`);
  console.log(`   (kod: ${String(kodUzytkownika).replace(/(...)(...)(...)/, '$1 $2 $3')}) i kliknij „Zezwól”.`);
  console.log(`Czekam na zgodę do ${Math.round((Number(wazny) || 3600) / 60)} min…\n`);

  const koniec = Date.now() + (Number(wazny) || 3600) * 1000;
  while (Date.now() < koniec) {
    await sleep(co * 1000);
    const t = await allegro.postAuth('token', { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: kod });
    if (t.status === 200 && t.j.access_token) return zapisz(konto, def, t.j);
    const blad = t.j.error;
    if (blad === 'authorization_pending') continue;
    if (blad === 'slow_down') { co += 5; continue; }
    if (blad === 'access_denied') throw new Error('Odmówiono zgody w Allegro — nic nie zapisano.');
    throw new Error(`Allegro odrzuciło kod: HTTP ${t.status} ${blad || ''} ${t.j.error_description || ''}`);
  }
  throw new Error('Kod wygasł bez zgody — uruchom skrypt jeszcze raz.');
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

main(process.argv[2]).then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
