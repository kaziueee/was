'use strict';

// Dostep do EDYTOWALNEJ listy kartonow (tabela `kartony`) + dobor kartonu i waga gabarytowa
// "z kartonu". To jedyny punkt, przez ktory backend czyta liste - dzieki temu edycja z panelu
// admina od razu wplywa na dobor (przez inwalidacje cache). Czysta logika dopasowania/wagi
// siedzi w config/kartony.js (testowalna bez DB); tutaj tylko dokladamy zrodlo danych (DB) i cache.

const db = require('../db/database');
const {
  dobierzKartonZListy, liczWageKartonZListy, sprawdzKarton,
} = require('../config/kartony');

// Cache listy w pamieci: lista zmienia sie rzadko (recznie, z panelu admina), a czyta ja
// kazdy zapis parametrow produktu i job wagi gabarytowej. Inwalidowana przy KAZDEJ mutacji.
let cache = null;

// ORDER BY kolejnosc = RECZNE ulozenie admina (drag&drop), id jako tiebreak. Ta kolejnosc
// jest tez remisem objetosci w dobierzKartonZListy (stabilny sort zostawia wczesniejszy) -
// wiec przeciagniecie kartonu wyzej daje mu pierwszenstwo przy rownej objetosci.
function wczytaj() {
  return db
    .prepare('SELECT id, kod, wysokosc, szerokosc, dlugosc, kolejnosc, aktywny FROM kartony ORDER BY kolejnosc, id')
    .all();
}

function wszystkieKartony() {
  if (!cache) cache = wczytaj();
  return cache;
}

function inwaliduj() {
  cache = null;
}

// Tylko aktywne ida do dopasowania - dezaktywowany karton znika z doboru, ale zostaje w bazie
// (mozna go wlaczyc z powrotem bez ponownego wpisywania wymiarow).
function aktywneKartony() {
  return wszystkieKartony().filter((k) => k.aktywny);
}

// Najmniejszy pasujacy AKTYWNY karton dla wymiarow produktu (albo null). Patrz config/kartony.
function dobierzKarton(wymiary) {
  return dobierzKartonZListy(aktywneKartony(), wymiary);
}

// { waga, karton_kod, zrodlo } dla wymiarow produktu; fallback na gola wage gdy nic nie pasuje;
// null gdy brak wymiarow. Patrz config/kartony.liczWageKartonZListy.
function liczWageGabarytowaKarton(wymiary) {
  return liczWageKartonZListy(aktywneKartony(), wymiary);
}

function pobierz(id) {
  return db
    .prepare('SELECT id, kod, wysokosc, szerokosc, dlugosc, kolejnosc, aktywny FROM kartony WHERE id = ?')
    .get(Number(id));
}

// --- Mutacje. Kazda zwraca {ok, karton} albo {ok:false, status, blad}; NIE rzuca (jak gt-fields). ---

function dodaj(dane) {
  const spr = sprawdzKarton(dane);
  if (spr.blad) return { ok: false, status: 400, blad: spr.blad };
  const k = spr.karton;
  // Nowy karton na KONIEC listy (max kolejnosc + 1) - admin przeciagnie go potem miedzy podobne.
  const nastepna = (db.prepare('SELECT MAX(kolejnosc) AS m FROM kartony').get().m || 0) + 1;
  try {
    const info = db
      .prepare('INSERT INTO kartony (kod, wysokosc, szerokosc, dlugosc, kolejnosc) VALUES (?, ?, ?, ?, ?)')
      .run(k.kod, k.wysokosc, k.szerokosc, k.dlugosc, nastepna);
    inwaliduj();
    return { ok: true, karton: pobierz(info.lastInsertRowid) };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { ok: false, status: 409, blad: `Karton „${k.kod}” już istnieje.` };
    }
    return { ok: false, status: 500, blad: `Zapis kartonu: ${err.message}` };
  }
}

// Edycja czesciowa: brak klucza w `dane` = zostaw dotychczasowa wartosc. Kod, wymiary i/lub
// `aktywny` (wlacz/wylacz karton bez kasowania). Wymiary walidowane razem (sprawdzKarton).
function edytuj(id, dane) {
  const istn = pobierz(id);
  if (!istn) return { ok: false, status: 404, blad: 'Nie ma takiego kartonu.' };
  const scalony = {
    kod: dane.kod ?? istn.kod,
    wysokosc: dane.wysokosc ?? istn.wysokosc,
    szerokosc: dane.szerokosc ?? istn.szerokosc,
    dlugosc: dane.dlugosc ?? istn.dlugosc,
  };
  const spr = sprawdzKarton(scalony);
  if (spr.blad) return { ok: false, status: 400, blad: spr.blad };
  const k = spr.karton;
  const aktywny = dane.aktywny === undefined ? istn.aktywny : dane.aktywny ? 1 : 0;
  try {
    db.prepare('UPDATE kartony SET kod = ?, wysokosc = ?, szerokosc = ?, dlugosc = ?, aktywny = ? WHERE id = ?')
      .run(k.kod, k.wysokosc, k.szerokosc, k.dlugosc, aktywny, Number(id));
    inwaliduj();
    return { ok: true, karton: pobierz(id), przed: istn };
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { ok: false, status: 409, blad: `Karton „${k.kod}” już istnieje.` };
    }
    return { ok: false, status: 500, blad: `Zapis kartonu: ${err.message}` };
  }
}

// Twarde usuniecie - karton nie ma zadnych FK-referencji (waga liczona na zywo, nie trzyma
// id kartonu), wiec kasowanie jest bezpieczne. Do czasowego wylaczenia sluzy `aktywny` (PUT).
function usun(id) {
  const istn = pobierz(id);
  if (!istn) return { ok: false, status: 404, blad: 'Nie ma takiego kartonu.' };
  db.prepare('DELETE FROM kartony WHERE id = ?').run(Number(id));
  inwaliduj();
  return { ok: true, karton: istn };
}

// Reczne ulozenie listy (drag&drop w panelu admina). `idy` = PELNA lista id kartonow w zadanej
// kolejnosci; zapisujemy kolejnosc = pozycja (1..N) w jednej transakcji. Wszystkie id musza istniec
// (front zawsze wysyla komplet z tabeli). Nie rzuca - {ok} albo {ok:false, status, blad}.
function ustawKolejnosc(idy) {
  if (!Array.isArray(idy) || idy.length === 0) return { ok: false, status: 400, blad: 'Brak kolejności.' };
  const ids = idy.map(Number);
  if (ids.some((n) => !Number.isInteger(n))) return { ok: false, status: 400, blad: 'Kolejność zawiera niepoprawne id.' };
  const istniejace = new Set(db.prepare('SELECT id FROM kartony').all().map((r) => r.id));
  if (ids.some((id) => !istniejace.has(id))) return { ok: false, status: 400, blad: 'Kolejność wskazuje nieistniejący karton.' };
  const upd = db.prepare('UPDATE kartony SET kolejnosc = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    ids.forEach((id, i) => upd.run(i + 1, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { ok: false, status: 500, blad: `Zapis kolejności: ${e.message}` };
  }
  inwaliduj();
  return { ok: true };
}

module.exports = {
  wszystkieKartony,
  aktywneKartony,
  dobierzKarton,
  liczWageGabarytowaKarton,
  pobierz,
  dodaj,
  edytuj,
  usun,
  ustawKolejnosc,
  inwaliduj,
};
