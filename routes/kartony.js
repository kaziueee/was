'use strict';

// Kartony wysylkowe - edytowalna lista referencyjna. Odczyt otwarty (czyta ja podglad
// magazyniera na ekranie Parametry), mutacje TYLKO dla admina (auth.wymagajAdmin), tak jak
// zarzadzanie uzytkownikami. Cala logika w services/kartony (DB + cache + walidacja).

const express = require('express');
const auth = require('../services/auth');
const audyt = require('../services/audyt');
const kartony = require('../services/kartony');

const router = express.Router();

// GET /api/kartony - pelna lista (aktywne i nieaktywne), wg id.
router.get('/', (req, res) => {
  res.json(kartony.wszystkieKartony());
});

// GET /api/kartony/dobierz?dlugosc=&szerokosc=&wysokosc= - "w co to zapakowac" + waga gabarytowa
// z kartonu dla podanych wymiarow. Podglad na Parametrach; bez admin-guardu (uzywa magazynier).
// zrodlo: 'karton' = zmiescil sie w kartonie; 'wymiar' = fallback na gola wage; null = brak wymiarow.
router.get('/dobierz', (req, res) => {
  const w = kartony.liczWageGabarytowaKarton({
    dlugosc: req.query.dlugosc,
    szerokosc: req.query.szerokosc,
    wysokosc: req.query.wysokosc,
  });
  res.json({
    waga_gabarytowa_karton: w?.waga ?? null,
    karton_kod: w?.karton_kod ?? null,
    zrodlo: w?.zrodlo ?? null,
  });
});

// POST /api/kartony { kod, wysokosc, szerokosc, dlugosc } - dodanie (admin)
router.post('/', auth.wymagajAdmin, (req, res) => {
  const wynik = kartony.dodaj(req.body ?? {});
  if (!wynik.ok) return res.status(wynik.status).json({ blad: wynik.blad });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'karton_dodany',
    po: wynik.karton,
    szczegoly: { kod: wynik.karton.kod },
    wynik: 'ok',
  });
  res.status(201).json(wynik.karton);
});

// PUT /api/kartony/kolejnosc { kolejnosc: [id, ...] } - reczne ulozenie listy (admin).
// MUSI byc przed PUT /:id, inaczej ":id" zlapie sciezke "kolejnosc".
router.put('/kolejnosc', auth.wymagajAdmin, (req, res) => {
  const wynik = kartony.ustawKolejnosc(req.body?.kolejnosc);
  if (!wynik.ok) return res.status(wynik.status).json({ blad: wynik.blad });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'karton_kolejnosc',
    po: { kolejnosc: req.body.kolejnosc },
    wynik: 'ok',
  });
  res.json({ ok: true });
});

// PUT /api/kartony/:id { kod?, wysokosc?, szerokosc?, dlugosc?, aktywny? } - edycja (admin)
router.put('/:id', auth.wymagajAdmin, (req, res) => {
  const wynik = kartony.edytuj(req.params.id, req.body ?? {});
  if (!wynik.ok) return res.status(wynik.status).json({ blad: wynik.blad });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'karton_zmieniony',
    przed: wynik.przed,
    po: wynik.karton,
    szczegoly: { kod: wynik.karton.kod },
    wynik: 'ok',
  });
  res.json(wynik.karton);
});

// DELETE /api/kartony/:id - usuniecie (admin). Twarde: karton nie ma FK-referencji.
router.delete('/:id', auth.wymagajAdmin, (req, res) => {
  const wynik = kartony.usun(req.params.id);
  if (!wynik.ok) return res.status(wynik.status).json({ blad: wynik.blad });
  audyt.zapisz({
    uzytkownik: req.uzytkownik?.imie ?? null,
    akcja: 'karton_usuniety',
    przed: wynik.karton,
    szczegoly: { kod: wynik.karton.kod },
    wynik: 'ok',
  });
  res.json({ usuniete: true, karton: wynik.karton });
});

module.exports = router;
