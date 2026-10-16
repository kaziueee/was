'use strict';

// Sekrety w `.env.dpapi` (DPAPI, tylko Windows) — patrz `config/sekrety.js`.
// Uruchom z katalogu projektu (C:\was):
//
//   node scripts/sekrety.js lista               nazwy i długości (NIGDY wartości): co zaszyfrowane, co jawne
//   node scripts/sekrety.js zaszyfruj [NAZWA…]  przenosi z .env do .env.dpapi (bez nazw = wszystko, co
//                                                wygląda na sekret: *KEY, *SECRET, *TOKEN, *PASS, *CLIENT_ID)
//   node scripts/sekrety.js odszyfruj           ścieżka awaryjna: wszystko z powrotem jawnie do .env
//   node scripts/sekrety.js most                hasła Sfery w appsettings mostu C# -> pola *HasloDpapi
//                                                (najpierw nowa wersja mostu, potem to, potem restart mostu)
//
// Nowy klucz (np. Allegro, rotacja Amazon): dopisz go do .env jak dotąd — działa od razu, bo jawny
// .env wygrywa — a potem `zaszyfruj`. Działające procesy trzymają klucze w pamięci; przeniesienie
// do .env.dpapi niczego w nich nie zmienia, nowy plik czytają przy następnym starcie.

const fs = require('fs');
const path = require('path');
const sekrety = require('../config/sekrety');

const PLIK_ENV = '.env';
const plik = sekrety.sciezkaPliku();

// Zapis przez plik tymczasowy + rename: przerwany zapis nie zostawi połowy .env.
function zapiszAtomowo(sciezka, dane) {
  fs.writeFileSync(sciezka + '.nowy', dane);
  fs.renameSync(sciezka + '.nowy', sciezka);
}

function opis(obj) {
  return Object.keys(obj).sort().map((k) => `  ${k} (dł. ${String(obj[k]).length})`).join('\n') || '  (brak)';
}

function lista() {
  const zaszyfrowane = fs.existsSync(plik) ? sekrety.odszyfruj(plik) : {};
  console.log(`${plik}:\n${opis(zaszyfrowane)}`);
  const jawne = fs.existsSync(PLIK_ENV) ? sekrety.jawneSekrety(fs.readFileSync(PLIK_ENV, 'utf8')) : [];
  console.log(`\nJawnym tekstem w ${PLIK_ENV}: ${jawne.length ? jawne.join(', ') : 'nic'}`);
  listaMostu();
}

function zaszyfruj(nazwy) {
  const tekst = fs.readFileSync(PLIK_ENV, 'utf8');
  const doPrzeniesienia = nazwy.length ? nazwy : sekrety.jawneSekrety(tekst);
  if (!doPrzeniesienia.length) { console.log('Nic do zaszyfrowania.'); return; }

  const { tekst: nowyEnv, wartosci } = sekrety.wydzielZEnv(tekst, doPrzeniesienia);
  const obecne = fs.existsSync(plik) ? sekrety.odszyfruj(plik) : {};
  const razem = { ...obecne, ...wartosci };

  // Najpierw nowy plik obok i sprawdzenie, że odszyfrowuje się co do znaku — dopiero potem
  // podmiana i wycięcie z .env. Każdy błąd przed tym miejscem zostawia stan bez zmian.
  sekrety.zaszyfruj(razem, plik + '.nowy');
  const sprawdzenie = sekrety.odszyfruj(plik + '.nowy');
  for (const [k, v] of Object.entries(razem)) {
    if (sprawdzenie[k] !== v) throw new Error(`kontrola po zaszyfrowaniu nie zgadza się dla ${k} — nic nie zmieniono`);
  }
  if (fs.existsSync(plik)) fs.renameSync(plik, plik + '.poprzedni');
  fs.renameSync(plik + '.nowy', plik);
  zapiszAtomowo(PLIK_ENV, nowyEnv);

  console.log(`Zaszyfrowano do ${plik}:\n${opis(wartosci)}`);
  console.log(`W ${PLIK_ENV} w ich miejscu zostały komentarze. Razem w pliku zaszyfrowanym: ${Object.keys(razem).length}.`);
}

function odszyfruj() {
  if (!fs.existsSync(plik)) { console.log(`Brak ${plik} — nic do odszyfrowania.`); return; }
  const wartosci = sekrety.odszyfruj(plik);
  const tekst = fs.existsSync(PLIK_ENV) ? fs.readFileSync(PLIK_ENV, 'utf8') : '';
  zapiszAtomowo(PLIK_ENV, sekrety.przywrocDoEnv(tekst, wartosci));
  fs.renameSync(plik, plik + '.poprzedni');
  console.log(`Przywrócono jawnie do ${PLIK_ENV}:\n${opis(wartosci)}\n${plik} -> ${plik}.poprzedni`);
}

const MOST_DIR = path.join('bridge', 'GtBridge');
const MOST_DLL = path.join(MOST_DIR, 'bin', 'Release', 'net8.0-windows', 'win-x86', 'publish', 'GtBridge.dll');

// appsettings.json projektu + każda kopia w bin/ (publish i zwykły build) — każda trzyma to samo hasło.
function plikiAppsettingsMostu() {
  const wynik = [path.join(MOST_DIR, 'appsettings.json')];
  const przejdz = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) przejdz(p);
      else if (e.name === 'appsettings.json') wynik.push(p);
    }
  };
  if (fs.existsSync(path.join(MOST_DIR, 'bin'))) przejdz(path.join(MOST_DIR, 'bin'));
  return wynik.filter((p) => fs.existsSync(p));
}

const czytajJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));

function most() {
  // Bezpiecznik: stary most nie zna pól *HasloDpapi — po wyczyszczeniu jawnego hasła nie zalogowałby
  // się do Sfery, a wyszłoby to dopiero przy pierwszym MM magazyniera.
  const dll = fs.existsSync(MOST_DLL) ? fs.readFileSync(MOST_DLL) : null;
  if (!dll || !dll.includes(Buffer.from('OperatorHasloDpapi'))) {
    throw new Error(`${MOST_DLL} nie zna pól *HasloDpapi — najpierw zaktualizuj most (bridge\\aktualizuj-most.cmd), potem uruchom to ponownie`);
  }
  const zaszyfrowane = new Map(); // jawne hasło -> blob, żeby nie szyfrować tego samego kilka razy
  for (const plikJson of plikiAppsettingsMostu()) {
    const cfg = czytajJson(plikJson);
    const pary = sekrety.haslaMostuDoZaszyfrowania(cfg);
    if (!pary.length) { console.log(`${plikJson}: nic jawnego`); continue; }
    for (const [jawne, dpapi] of pary) {
      const haslo = cfg.Sfera[jawne];
      if (!zaszyfrowane.has(haslo)) {
        const blob = sekrety.zaszyfrujTekst(haslo);
        if (sekrety.odszyfrujTekst(blob) !== haslo) throw new Error(`kontrola po zaszyfrowaniu ${jawne} nie zgadza się — nic nie zmieniono w ${plikJson}`);
        zaszyfrowane.set(haslo, blob);
      }
      cfg.Sfera[dpapi] = zaszyfrowane.get(haslo);
      cfg.Sfera[jawne] = '';
    }
    zapiszAtomowo(plikJson, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`${plikJson}: zaszyfrowano ${pary.map(([j]) => j).join(', ')}`);
  }
  console.log('Teraz restart mostu (ikona w trayu -> Restart), potem w trayu "Testuj polaczenie".');
}

function listaMostu() {
  const p = path.join(MOST_DIR, 'appsettings.json');
  if (!fs.existsSync(p)) return;
  const sfera = czytajJson(p).Sfera || {};
  const stan = sekrety.POLA_MOSTU.map(([jawne, dpapi]) => `${jawne}: ${sfera[dpapi] ? 'zaszyfrowane' : sfera[jawne] ? 'JAWNE' : 'puste'}`);
  console.log(`\nMost (${p}): ${stan.join(', ')}`);
}

const [polecenie, ...argumenty] = process.argv.slice(2);
try {
  if (polecenie === 'lista') lista();
  else if (polecenie === 'zaszyfruj') zaszyfruj(argumenty);
  else if (polecenie === 'odszyfruj') odszyfruj();
  else if (polecenie === 'most') most();
  else {
    console.log('Użycie: node scripts/sekrety.js lista | zaszyfruj [NAZWA…] | odszyfruj | most');
    process.exit(polecenie ? 1 : 0);
  }
} catch (e) {
  console.error(`BŁĄD: ${e.message}`);
  process.exit(1);
}
