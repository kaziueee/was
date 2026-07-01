'use strict';

// Logowanie/sesje (Faza A#4). PIN opcjonalny (hasz scrypt + sol). "Kto" wyprowadzany
// z tokenu sesji, nie z pola tekstowego (backend = zrodlo prawdy, CLAUDE.md zasada 5).

const crypto = require('crypto');
const db = require('../db/database');
const awarie = require('./awarie');

const WAZNOSC_MS = 12 * 60 * 60 * 1000; // sesja wygasa po 12h bezczynnosci

// --- PIN ---

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return { hash, salt };
}

function sprawdzPin(pin, hash, salt) {
  if (!hash || !salt) return false;
  const wyliczony = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  const a = Buffer.from(wyliczony, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- sesje ---

function utworzSesje(uzytkownik) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sesje (token, uzytkownik_id, imie, rola) VALUES (?, ?, ?, ?)')
    .run(token, uzytkownik.id, uzytkownik.imie, uzytkownik.rola);
  return token;
}

function usunSesje(token) {
  db.prepare('DELETE FROM sesje WHERE token = ?').run(token);
}

// Zwraca sesje dla tokenu albo null. Odswieza ostatnia_aktywnosc; wygasa po WAZNOSC_MS.
function sesjaZTokenu(token) {
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sesje WHERE token = ?').get(token);
  if (!s) return null;
  if (Date.now() - new Date(s.ostatnia_aktywnosc + 'Z').getTime() > WAZNOSC_MS) {
    db.prepare('DELETE FROM sesje WHERE token = ?').run(token);
    return null;
  }
  db.prepare("UPDATE sesje SET ostatnia_aktywnosc = CURRENT_TIMESTAMP WHERE token = ?").run(token);
  return s;
}

function tokenZadania(req) {
  return req.get('x-wms-token') || (req.body && req.body.token) || null;
}

// --- middleware ---

// Rozwiazuje sesje (jesli jest) i dokleja req.uzytkownik. Nie blokuje.
function opcjonalnaSesja(req, res, next) {
  req.uzytkownik = sesjaZTokenu(tokenZadania(req)) || null;
  next();
}

// Wymaga zalogowania. Dla metod zmieniajacych dane WSTRZYKUJE operatora z sesji do
// req.body.operator (nadpisuje to, co przyslal klient) - dzieki temu "kto" jest
// wiarygodne, a istniejace handlery (routes/*) nie musza byc zmieniane.
function wymagajSesji(req, res, next) {
  const s = sesjaZTokenu(tokenZadania(req));
  if (!s) return res.status(401).json({ blad: 'Wymagane logowanie (wybierz profil)' });
  req.uzytkownik = s;
  if (req.body && typeof req.body === 'object') req.body.operator = s.imie;
  next();
}

// Jak wyzej, ale tylko dla metod zmieniajacych stan (POST/PUT/DELETE/PATCH); GET przepuszcza.
function wymagajSesjiNaZapisie(req, res, next) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return wymagajSesji(req, res, next);
  return opcjonalnaSesja(req, res, next);
}

function wymagajAdmin(req, res, next) {
  const s = sesjaZTokenu(tokenZadania(req));
  if (!s) return res.status(401).json({ blad: 'Wymagane logowanie' });
  if (s.rola !== 'admin') return res.status(403).json({ blad: 'Tylko administrator moze zarzadzac uzytkownikami' });
  req.uzytkownik = s;
  next();
}

// sprzatanie wygaslych sesji (wolane z joba)
function sprzatnijSesje() {
  try {
    const prog = new Date(Date.now() - WAZNOSC_MS).toISOString().slice(0, 19).replace('T', ' ');
    db.prepare('DELETE FROM sesje WHERE ostatnia_aktywnosc < ?').run(prog);
  } catch (e) {
    awarie.blad('auth', `sprzatanie sesji: ${e.message}`);
  }
}

module.exports = {
  hashPin, sprawdzPin, utworzSesje, usunSesje, sesjaZTokenu, tokenZadania,
  opcjonalnaSesja, wymagajSesji, wymagajSesjiNaZapisie, wymagajAdmin, sprzatnijSesje,
};
