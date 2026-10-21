'use strict';

// Moduł analiz sprzedaży — czysta logika dat, porównań i flag (bez SQLite i GT). Testy: test/analiza-model.test.js.
// Projekt: docs/analiza-sprzedazy.md. Dni to napisy 'YYYY-MM-DD' (porównanie napisów = porównanie dat).

const ROK_TEMU_DNI = 364;   // ten sam dzień tygodnia rok wcześniej (decyzja usera 2026-10-20), jak widoki ERP Dashboard

function dodajDni(dzien, dni) {
  const d = new Date(dzien + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + dni);
  return d.toISOString().slice(0, 10);
}

const rokTemu = (dzien) => dodajDni(dzien, -ROK_TEMU_DNI);

// Zakresy ekranu „Dzień”: każdy jako { cur: [od, do], prev: [od, do] }, prev przesunięty o 364 dni.
// Miesiąc / rok do dziś liczone od 1. dnia kalendarzowego, a rok temu — te same dni przesunięte o 364 (czyli
// rok temu zaczyna się 2.01, nie 1.01) — tak samo długi zakres, te same dni tygodnia.
const ZAKRESY = ['dzien', 't7', 'mtd', 'ytd'];
// dzis: zakresy dłuższe niż dzień porównują tylko DNI ZAMKNIĘTE (decyzja usera 2026-10-21) — gdy wybrany dzień to
// dziś, 7 dni / miesiąc / rok kończą się na wczoraj, a miesiąc i rok liczą się od początku miesiąca/roku tego końca.
// Sam „Dzień” zostaje dniem wybranym, także dzisiejszym (dzień otwarty z ZK — user wie po fakturach, jak się zamknie).
function zakres(nazwa, dzien, { dzis = null } = {}) {
  const koniec = nazwa !== 'dzien' && dzis && dzien >= dzis ? dodajDni(dzis, -1) : dzien;
  let od;
  if (nazwa === 'dzien') od = koniec;
  else if (nazwa === 't7') od = dodajDni(koniec, -6);
  else if (nazwa === 'mtd') od = koniec.slice(0, 8) + '01';
  else if (nazwa === 'ytd') od = koniec.slice(0, 5) + '01-01';
  else return null;
  return { cur: [od, koniec], prev: [rokTemu(od), rokTemu(koniec)] };
}

// Kurs dokumentu GT (dok_WalutaKurs) na PLN za 1 jednostkę waluty. GT trzyma HUF za 100 Ft (sprawdzone
// 2026-10-20: dok_WalutaKurs 1,2008 przy 0,012 zł/Ft z pozycji); pozostałe waluty za 1.
function kursDokumentu(waluta, kurs) {
  const w = String(waluta || '').toUpperCase();
  if (!w || w === 'PLN') return 1;
  const k = +kurs || 0;
  return w === 'HUF' ? k / 100 : k;
}

// Czas utworzenia z UUID wersji 1 (Allegro: identyfikator zamówienia w ZK, pwd_Tekst05). Zwraca Date albo null.
// UUID v1 niesie liczbę 100-nanosekund od 15.10.1582 (RFC 4122): time_hi (12 bitów) . time_mid . time_low.
const UUID_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-1([0-9a-f]{3})-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GREGORIAN_MS = Date.UTC(1582, 9, 15);
function czasZUuidV1(uuid) {
  const m = UUID_RE.exec(String(uuid || '').trim());
  if (!m) return null;
  const t = (BigInt('0x' + m[3]) << 48n) | (BigInt('0x' + m[2]) << 32n) | BigInt('0x' + m[1]);
  return new Date(GREGORIAN_MS + Number(t / 10000n));
}

// Dzień i godzina w czasie polskim (magazyn żyje czasem lokalnym, zob. „Czas” w CLAUDE.md).
const FORMAT_PL = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
function dzienICzasPl(data) {
  if (!(data instanceof Date) || Number.isNaN(data.getTime())) return null;
  const s = FORMAT_PL.format(data);          // '2026-10-18 00:09'
  return { dzien: s.slice(0, 10), godz: s.slice(11, 16) };
}

// Data zamówienia: Allegro z UUID (prawdziwa data i godzina, także gdy integracja stała i ZK dostało datę
// wczytania), inaczej data ZK, a bez ZK — data FS. UUID dalej niż 10 dni przed ZK albo po nim = nie ufamy.
function dataZamowienia({ uuid, dataZk, dataFs }) {
  const z = dataZk || dataFs || null;
  const c = dzienICzasPl(czasZUuidV1(uuid));
  if (c && z && c.dzien <= z && c.dzien >= dodajDni(z, -10)) return { dzien: c.dzien, godz: c.godz, zrodlo: 'uuid' };
  return { dzien: z, godz: null, zrodlo: dataZk ? 'zk' : 'fs' };
}

// Flagi towaru (decyzje usera 2026-10-20). tempo = sztuk dziennie; zapas liczony ze stanu K4+K4G.
//   nowosc  — pierwsze przyjęcie (PZ/PW) mniej niż 30 dni temu
//   konczy  — zapas < 30 dni przy tempie z 30 dni
//   nadmiar — zapas > 730 dni nawet przy SZYBSZYM z temp 30 dni / rok (szybko rotujący towar to nie nadmiar)
//   zalega  — stan, zero sprzedaży w 180 dni, nie nowość
const PROGI = { nowoscDni: 30, konczyDni: 30, nadmiarDni: 730, zalegaDni: 180 };
function flagiTowaru({ stan = 0, szt30 = 0, szt180 = 0, szt365 = 0, pierwszePrzyjecie = null, dzis }) {
  const f = [];
  const t30 = szt30 / 30, t365 = szt365 / 365, szybsze = Math.max(t30, t365);
  const nowosc = !!(pierwszePrzyjecie && dzis && pierwszePrzyjecie > dodajDni(dzis, -PROGI.nowoscDni));
  if (nowosc) f.push('nowosc');
  if (stan > 0 && t30 > 0 && stan / t30 < PROGI.konczyDni) f.push('konczy');
  if (stan > 0 && szybsze > 0 && stan / szybsze > PROGI.nadmiarDni) f.push('nadmiar');
  if (stan > 0 && szt180 <= 0 && !nowosc) f.push('zalega');
  return f;
}
const dniZapasu = (stan, szt30) => (szt30 > 0 ? Math.round(stan / (szt30 / 30)) : null);

// Zwrot z pozycji KFS: GT zapisuje korektę jako różnicę — ob_Znak −1 z ilością = zmniejszenie (zwrot sztuki),
// ob_Znak +1 z ilością 0 i ujemną wartością = obniżka ceny. Wynik: zwrócone sztuki i wartość netto (dodatnie).
function zwrotZPozycji({ znak, ilosc, netto }) {
  const z = +znak || 0;
  return { szt: -(z * (+ilosc || 0)), netto: -(z * (+netto || 0)) };
}

// Dni nietypowe w zakresie porównania: liczba zamówień poniżej 45% albo powyżej 180% mediany SĄSIADÓW (±3 dni).
// Sąsiedzi, a nie ostatnie tygodnie: w sezonie zamówień przybywa 2–3× w miesiąc i porównanie z 4 tygodniami wstecz
// zapalało alarm w co trzecim dniu (223 z 718, sprawdzone 2026-10-20 na 2 latach), a przestój integracji to dzień
// wyraźnie niższy od sąsiadów, a nadrabianie — wyraźnie wyższy. Na 745 dniach reguła zapala się 13 razy: przestoje
// (17.05.2025, 27.09.2025), nadrabianie (29.09.2025, 20.10.2025: 612 ZK przy ~300 obok, 27.04 i 04.05.2026),
// Wigilia, Wielka Sobota. Dni od `dzis` (niepełne) nie są ani oceniane, ani sąsiadami. liczby: Map dzień → liczba.
const SASIEDZI = [-3, -2, -1, 1, 2, 3];
function dniNietypowe(liczby, dni, { dzis = null } = {}) {
  const wynik = [];
  const pelny = (d) => !dzis || d < dzis;
  for (const d of dni) {
    if (!pelny(d)) continue;
    const okno = SASIEDZI.map((i) => dodajDni(d, i)).filter(pelny).map((x) => liczby.get(x)).filter((x) => x != null);
    if (okno.length < 3) continue;                         // za mało sąsiadów, żeby cokolwiek twierdzić
    okno.sort((a, b) => a - b);
    const med = okno.length % 2 ? okno[(okno.length - 1) / 2] : (okno[okno.length / 2 - 1] + okno[okno.length / 2]) / 2;
    const n = liczby.get(d) || 0;
    if (med > 0 && (n < 0.45 * med || n > 1.8 * med)) wynik.push({ dzien: d, zamowien: n, mediana: med });
  }
  return wynik;
}
const dniZakresu = ([od, doDnia]) => { const w = []; for (let d = od; d <= doDnia; d = dodajDni(d, 1)) w.push(d); return w; };

module.exports = {
  dniNietypowe, dniZakresu,
  ROK_TEMU_DNI, ZAKRESY, PROGI, dodajDni, rokTemu, zakres, kursDokumentu, czasZUuidV1, dzienICzasPl, dataZamowienia,
  flagiTowaru, dniZapasu, zwrotZPozycji,
};
