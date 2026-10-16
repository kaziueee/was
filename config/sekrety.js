'use strict';

// Sekrety (klucze API, hasła) w pliku `.env.dpapi` obok `.env`, zaszyfrowane DPAPI Windows —
// na produkcji zamiast jawnego tekstu w `.env`.
//
// POWÓD (audyt 2026-10-16): `C:\was\.env` trzymał klucze Amazon SP-API, eMAG, Empik, Kaufland
// i Sellasist jawnym tekstem, a SRV to serwer terminalowy z ~30 kontami (biuro, kasy, magazyn),
// z których każde mogło ten plik przeczytać. Uprawnienia do `C:\was` są już zawężone do
// Adm/SYSTEM/Administratorów; szyfrowanie dokłada drugą warstwę: plik skopiowany poza tę maszynę
// (kopia zapasowa, commit, Dropbox, mail, zrzut ekranu z `type .env`) jest bezużyteczny, bo
// odszyfruje go wyłącznie ten Windows.
//
// Zakres DPAPI = MASZYNA (`LocalMachine`), nie użytkownik — świadomie. WMS-Node i WMS-Pricing
// startują z Harmonogramu bez zapisanego hasła (S4U), także po restarcie serwera, zanim ktokolwiek
// się zaloguje. Zakres użytkownika zadziałał w teście z sesji SSH (2026-10-16), ale Adm był wtedy
// zalogowany przez RDP — nie uzależniamy startu WMS od czegoś, czego nie umiemy wykluczyć. Przed
// innymi kontami chroni ACL pliku (nie przeczytają go, więc nie mają czego odszyfrować);
// przed administratorami serwera nie chroni żaden zakres.
//
// SKUTEK UBOCZNY: pliku nie odszyfruje inny komputer ani ten sam po reinstalacji Windows.
// Utrata = wygenerowanie kluczy od nowa w panelach platform (wszystkie to umożliwiają).
//
// Treść po odszyfrowaniu = JSON `{NAZWA: wartość}`, nie format dotenv — tokeny zawierają `|`, `#`
// i cudzysłowy, a JSON nie ma z nimi problemu. Entropia DPAPI jest jawna (to repo) — rozdziela
// tylko nasze dane od innych blobów DPAPI na tej maszynie, nie jest sekretem.
//
// Czyste funkcje (testy w `test/sekrety.test.js`, bez Windows) + cienka warstwa DPAPI przez
// PowerShell (Node nie ma DPAPI w standardzie, a moduł natywny to kłopot przy wdrożeniu).

const path = require('path');
const { execFileSync } = require('child_process');
const dotenv = require('dotenv');

const PLIK_DOMYSLNY = '.env.dpapi';
const ENTROPIA = 'WMS-sekrety-v1';

// Nazwa wygląda na sekret = ją szyfrujemy domyślnie (`zaszyfruj` bez listy nazw). Po nazwie,
// nie po liście kanałów — nowy kanał repricera (`ALLEGRO_CLIENT_SECRET`, `KAUFLAND_SECRET_KEY`)
// wpada sam, bez dopisywania go tutaj. Login (`EMAG_RO_USER`) zostaje jawny: sam nic nie otwiera.
const SEKRET_RE = /(KEY|SECRET|TOKEN|PASS|PASSWORD|CLIENT_ID)$/;

// Komentarz zostawiany w `.env` w miejscu zaszyfrowanej zmiennej.
const ZNACZNIK_RE = /^# ([A-Za-z_][A-Za-z0-9_]*) -> \.env\.dpapi\b/;

function czySekret(nazwa) {
  return SEKRET_RE.test(String(nazwa));
}

function sciezkaPliku(env = process.env) {
  return path.resolve(env.WMS_SEKRETY_PLIK || PLIK_DOMYSLNY);
}

// Niepuste zmienne z tekstu `.env`, które wyglądają na sekret — do ostrzeżenia przy starcie
// i do domyślnego `zaszyfruj`.
function jawneSekrety(tekstEnv) {
  const env = dotenv.parse(tekstEnv);
  return Object.keys(env).filter((k) => czySekret(k) && env[k] !== '');
}

// Wycina z tekstu `.env` linie podanych zmiennych. Zwraca nowy tekst (komentarze i reszta
// zmiennych bez zmian, w miejscu wyciętej linii znacznik) i wartości do zaszyfrowania.
// Odmawia, gdy wartość z pojedynczej linii nie zgadza się z wartością z całego pliku (wieloliniowa
// wartość w cudzysłowie albo zmienna zdefiniowana dwa razy) — wtedy wycięcie linii zgubiłoby dane.
function wydzielZEnv(tekstEnv, nazwy) {
  const calosc = dotenv.parse(tekstEnv);
  const szukane = new Set(nazwy);
  const wartosci = {};
  const linie = tekstEnv.split(/\r?\n/);
  const eol = tekstEnv.includes('\r\n') ? '\r\n' : '\n';
  // Po rotacji znacznik z poprzedniego szyfrowania już stoi w pliku — drugiego nie dokładamy.
  const zeZnacznikiem = new Set(linie.map((l) => (l.match(ZNACZNIK_RE) || [])[1]).filter(Boolean));
  const wynik = linie.map((linia) => {
    const m = linia.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !szukane.has(m[1])) return linia;
    const nazwa = m[1];
    const zLinii = dotenv.parse(linia)[nazwa];
    if (zLinii !== calosc[nazwa] || nazwa in wartosci) {
      throw new Error(`${nazwa}: wartość zajmuje kilka linii albo zmienna jest w .env dwa razy — popraw ręcznie`);
    }
    wartosci[nazwa] = zLinii;
    return zeZnacznikiem.has(nazwa) ? null : `# ${nazwa} -> ${PLIK_DOMYSLNY} (zaszyfrowane, node scripts/sekrety.js lista)`;
  }).filter((l) => l !== null);
  for (const n of szukane) {
    if (!(n in wartosci)) throw new Error(`${n}: nie ma w .env`);
  }
  return { tekst: wynik.join(eol), wartosci };
}

// Wartość w zapisie dotenv, który `dotenv.parse` odczyta co do znaku. Pojedyncze cudzysłowy
// = dosłownie (bez `\n` i bez ucinania na `#`); gdy wartość sama ma `'`, próbujemy `"` i backtick.
function cytuj(wartosc) {
  const v = String(wartosc);
  if (/[\r\n]/.test(v)) throw new Error('wartość wieloliniowa — nie zapisujemy jej do .env');
  for (const q of ["'", '"', '`']) {
    if (!v.includes(q) && (q !== '"' || !v.includes('\\'))) return q + v + q;
  }
  throw new Error('wartość zawiera wszystkie rodzaje cudzysłowów — wpisz ją ręcznie');
}

// Odwrotność `wydzielZEnv` (ścieżka awaryjna `odszyfruj`): wstawia `NAZWA='wartość'` w miejsce
// znacznika po zaszyfrowaniu, a gdy znacznika nie ma — dopisuje na końcu.
function przywrocDoEnv(tekstEnv, wartosci) {
  const eol = tekstEnv.includes('\r\n') ? '\r\n' : '\n';
  const zostalo = new Map(Object.entries(wartosci));
  const linie = tekstEnv.split(/\r?\n/).map((linia) => {
    const m = linia.match(ZNACZNIK_RE);
    if (!m || !(m[1] in wartosci)) return linia;
    if (!zostalo.has(m[1])) return null; // nadmiarowy znacznik tej samej zmiennej
    const v = zostalo.get(m[1]);
    zostalo.delete(m[1]);
    return `${m[1]}=${cytuj(v)}`;
  }).filter((l) => l !== null);
  while (linie.length && linie[linie.length - 1] === '') linie.pop();
  for (const [k, v] of zostalo) linie.push(`${k}=${cytuj(v)}`);
  return linie.join(eol) + eol;
}

// Dokłada sekrety do środowiska. Wartość już ustawiona (środowisko procesu albo jawny `.env`)
// wygrywa — tak działa rotacja: nowy klucz wpisany do `.env` działa od razu, zanim ktoś go
// zaszyfruje. Puste `NAZWA=` w `.env` nie zasłania sekretu. Zwraca nazwy, które ustawiono.
function uzupelnijEnv(env, sekrety) {
  const ustawione = [];
  for (const [k, v] of Object.entries(sekrety || {})) {
    if (env[k] === undefined || env[k] === '') {
      env[k] = String(v);
      ustawione.push(k);
    }
  }
  return ustawione;
}

// --- DPAPI (tylko Windows) ---

function powershell(skrypt, opcje) {
  if (process.platform !== 'win32') throw new Error('DPAPI działa tylko na Windows');
  // Pełna ścieżka zamiast PATH: zadanie S4U ma okrojone środowisko, a PATH da się podmienić.
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const zakodowany = Buffer.from(`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; ${skrypt}`, 'utf16le').toString('base64');
  try {
    return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', zakodowany], {
      encoding: 'utf8', windowsHide: true, timeout: 60 * 1000, stdio: ['pipe', 'pipe', 'pipe'], ...opcje,
    });
  } catch (e) {
    // stderr PowerShella bywa CLIXML-em na kilka ekranów — do komunikatu bierzemy pierwszą treść
    const opis = String(e.stderr || '').replace(/<[^>]+>/g, ' ').replace(/_x000D__x000A_/g, ' ').replace(/\s+/g, ' ').trim();
    throw new Error(opis.slice(0, 300) || e.message);
  }
}

// Wartości sekretów idą przez stdin, nie przez linię poleceń — tej nie widać na liście procesów.
function zaszyfruj(sekrety, plik) {
  const dane = Buffer.from(JSON.stringify(sekrety), 'utf8').toString('base64');
  powershell(
    `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `$c=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPIA}'),'LocalMachine'); ` +
    `[IO.File]::WriteAllBytes($env:WMS_SEKRETY_ZAPIS,$c)`,
    { input: dane, env: { ...process.env, WMS_SEKRETY_ZAPIS: plik } },
  );
}

function odszyfruj(plik) {
  const out = powershell(
    `$b=[IO.File]::ReadAllBytes($env:WMS_SEKRETY_ODCZYT); ` +
    `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPIA}'),'LocalMachine'); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($p))`,
    { env: { ...process.env, WMS_SEKRETY_ODCZYT: plik } },
  );
  const obj = JSON.parse(Buffer.from(out.trim(), 'base64').toString('utf8'));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('nieprawidłowa treść pliku sekretów');
  return obj;
}

// Pojedyncze hasło -> base64 blobu DPAPI (do pól `*HasloDpapi` w appsettings mostu C#, który
// odszyfrowuje je tym samym zakresem i entropią — bridge/GtBridge/Services/Sekrety.cs).
// Tekst i blob idą przez stdin/stdout, nie przez linię poleceń ani plik.
function zaszyfrujTekst(tekst) {
  return powershell(
    `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `$c=[Security.Cryptography.ProtectedData]::Protect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPIA}'),'LocalMachine'); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($c))`,
    { input: Buffer.from(String(tekst), 'utf8').toString('base64') },
  ).trim();
}

function odszyfrujTekst(blobBase64) {
  const out = powershell(
    `$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ` +
    `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,[Text.Encoding]::UTF8.GetBytes('${ENTROPIA}'),'LocalMachine'); ` +
    `[Console]::Out.Write([Convert]::ToBase64String($p))`,
    { input: String(blobBase64) },
  );
  return Buffer.from(out.trim(), 'base64').toString('utf8');
}

// Pary pól hasła w sekcji "Sfera" appsettings mostu: jawne -> zaszyfrowane.
const POLA_MOSTU = [['UzytkownikHaslo', 'UzytkownikHasloDpapi'], ['OperatorHaslo', 'OperatorHasloDpapi']];

// Czysta część polecenia `most`: które jawne hasła trzeba przenieść. Puste jawne pole = nic
// do zrobienia (puste hasło SQL `sa` to osobny problem, nie sekret do ukrycia).
function haslaMostuDoZaszyfrowania(appsettings) {
  const sfera = (appsettings && appsettings.Sfera) || {};
  return POLA_MOSTU.filter(([jawne]) => typeof sfera[jawne] === 'string' && sfera[jawne] !== '');
}

module.exports = {
  PLIK_DOMYSLNY, POLA_MOSTU, czySekret, sciezkaPliku, jawneSekrety, wydzielZEnv, cytuj, przywrocDoEnv, uzupelnijEnv,
  haslaMostuDoZaszyfrowania, zaszyfruj, odszyfruj, zaszyfrujTekst, odszyfrujTekst,
};
