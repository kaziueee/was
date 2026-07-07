const express = require('express');
const db = require('../db/database');
const auth = require('../services/auth');

const router = express.Router();

// bez haszy PIN na zewnatrz
function publiczny(u) {
  return { id: u.id, imie: u.imie, rola: u.rola, aktywny: u.aktywny, maPin: !!u.pin_hash };
}

function liczbaAdminow() {
  return db.prepare("SELECT COUNT(*) AS c FROM uzytkownicy WHERE rola='admin' AND aktywny=1").get().c;
}

// GET /api/uzytkownicy/profile - lista AKTYWNYCH do wyboru profilu (Zebra/desktop). Bez auth.
router.get('/profile', (req, res) => {
  const lista = db.prepare('SELECT * FROM uzytkownicy WHERE aktywny=1 ORDER BY imie').all();
  res.json(lista.map(publiczny));
});

// POST /api/uzytkownicy/login { id | imie, pin? } -> { token, uzytkownik }
router.post('/login', (req, res) => {
  const { id, imie, pin } = req.body ?? {};
  const u = id != null
    ? db.prepare('SELECT * FROM uzytkownicy WHERE id=? AND aktywny=1').get(id)
    : db.prepare('SELECT * FROM uzytkownicy WHERE imie=? AND aktywny=1').get(imie);
  if (!u) return res.status(404).json({ blad: 'Nie ma takiego profilu (lub nieaktywny)' });

  if (u.pin_hash) {
    if (!pin) return res.status(401).json({ blad: 'Ten profil wymaga PIN', wymaga_pin: true });
    if (!auth.sprawdzPin(pin, u.pin_hash, u.pin_salt)) return res.status(401).json({ blad: 'Zły PIN', wymaga_pin: true });
  }

  const token = auth.utworzSesje(u);
  res.json({ token, uzytkownik: publiczny(u) });
});

// POST /api/uzytkownicy/logout - konczy sesje biezacego tokenu
router.post('/logout', (req, res) => {
  const token = auth.tokenZadania(req);
  if (token) auth.usunSesje(token);
  res.json({ ok: true });
});

// GET /api/uzytkownicy/ja - kim jestem wg tokenu (do odtworzenia sesji po odswiezeniu strony)
router.get('/ja', auth.opcjonalnaSesja, (req, res) => {
  if (!req.uzytkownik) return res.status(401).json({ blad: 'Brak sesji' });
  res.json({ id: req.uzytkownik.uzytkownik_id, imie: req.uzytkownik.imie, rola: req.uzytkownik.rola });
});

// --- zarzadzanie (tylko admin) ---

// GET /api/uzytkownicy - pelna lista (z nieaktywnymi)
router.get('/', auth.wymagajAdmin, (req, res) => {
  const lista = db.prepare('SELECT * FROM uzytkownicy ORDER BY aktywny DESC, imie').all();
  res.json(lista.map(publiczny));
});

// POST /api/uzytkownicy { imie, pin?, rola? }
router.post('/', auth.wymagajAdmin, (req, res) => {
  const imie = (req.body?.imie ?? '').trim();
  const rola = ['admin', 'magazynier', 'uczen'].includes(req.body?.rola) ? req.body.rola : 'magazynier';
  const pin = req.body?.pin ? String(req.body.pin).trim() : null;
  if (!imie) return res.status(400).json({ blad: 'Pole "imie" jest wymagane' });
  if (pin && !/^\d{4,8}$/.test(pin)) return res.status(400).json({ blad: 'PIN musi miec 4-8 cyfr' });
  if (db.prepare('SELECT 1 FROM uzytkownicy WHERE imie=?').get(imie)) {
    return res.status(409).json({ blad: `Uzytkownik "${imie}" juz istnieje` });
  }
  const h = pin ? auth.hashPin(pin) : { hash: null, salt: null };
  const r = db.prepare('INSERT INTO uzytkownicy (imie, pin_hash, pin_salt, rola) VALUES (?, ?, ?, ?)')
    .run(imie, h.hash, h.salt, rola);
  res.status(201).json(publiczny(db.prepare('SELECT * FROM uzytkownicy WHERE id=?').get(r.lastInsertRowid)));
});

// PUT /api/uzytkownicy/:id { imie?, rola?, aktywny?, pin? (ustaw), usunPin? (wyczysc) }
router.put('/:id', auth.wymagajAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM uzytkownicy WHERE id=?').get(id);
  if (!u) return res.status(404).json({ blad: 'Uzytkownik nie istnieje' });

  const imie = req.body?.imie !== undefined ? String(req.body.imie).trim() : u.imie;
  const rola = req.body?.rola !== undefined ? (['admin', 'magazynier', 'uczen'].includes(req.body.rola) ? req.body.rola : 'magazynier') : u.rola;
  const aktywny = req.body?.aktywny !== undefined ? (req.body.aktywny ? 1 : 0) : u.aktywny;
  if (!imie) return res.status(400).json({ blad: 'Pole "imie" nie moze byc puste' });
  const kolizja = db.prepare('SELECT 1 FROM uzytkownicy WHERE imie=? AND id<>?').get(imie, id);
  if (kolizja) return res.status(409).json({ blad: `Uzytkownik "${imie}" juz istnieje` });

  // nie odbieraj ostatniego admina (zmiana roli / dezaktywacja)
  const traciAdmina = u.rola === 'admin' && u.aktywny === 1 && (rola !== 'admin' || aktywny === 0);
  if (traciAdmina && liczbaAdminow() <= 1) {
    return res.status(409).json({ blad: 'To ostatni aktywny administrator - nie mozna go zdegradowac ani dezaktywowac' });
  }

  let pin_hash = u.pin_hash, pin_salt = u.pin_salt;
  if (req.body?.usunPin) { pin_hash = null; pin_salt = null; }
  else if (req.body?.pin) {
    const pin = String(req.body.pin).trim();
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ blad: 'PIN musi miec 4-8 cyfr' });
    const h = auth.hashPin(pin); pin_hash = h.hash; pin_salt = h.salt;
  }

  db.prepare('UPDATE uzytkownicy SET imie=?, rola=?, aktywny=?, pin_hash=?, pin_salt=? WHERE id=?')
    .run(imie, rola, aktywny, pin_hash, pin_salt, id);
  res.json(publiczny(db.prepare('SELECT * FROM uzytkownicy WHERE id=?').get(id)));
});

// DELETE /api/uzytkownicy/:id - dezaktywacja (nie usuwamy - slad "kto" w audycie zostaje)
router.delete('/:id', auth.wymagajAdmin, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM uzytkownicy WHERE id=?').get(id);
  if (!u) return res.status(404).json({ blad: 'Uzytkownik nie istnieje' });
  if (u.rola === 'admin' && u.aktywny === 1 && liczbaAdminow() <= 1) {
    return res.status(409).json({ blad: 'To ostatni aktywny administrator - nie mozna go dezaktywowac' });
  }
  db.prepare('UPDATE uzytkownicy SET aktywny=0 WHERE id=?').run(id);
  db.prepare('DELETE FROM sesje WHERE uzytkownik_id=?').run(id); // wyloguj dezaktywowanego
  res.json({ ok: true, dezaktywowany: id });
});

module.exports = router;
