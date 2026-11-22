'use strict';

// Czysta logika zakladania zamowienia od klienta (ZK) przez most - scripts/zk-zaloz.js.
// Bez SQL i bez mostu, zeby dalo sie ja testowac (test/zk-model.test.js).
//
// Zamowienie podaje sie plikiem JSON:
//   { "klucz": "K4ENERGY-2026-11-22", "nip": "6981850013", "magazyn_id": 4,
//     "waluta": "EUR", "vat": "ue", "poziom_ceny": 5, "rezerwacja": true,
//     "pozycje": [{ "ean": "194735188840", "ilosc": 12 }, { "symbol": "HASF5206BB", "ilosc": 2 }] }
// Pozycja wskazuje towar EAN-em ALBO symbolem (symbol wygrywa - czlowiek rozstrzygnal, ktory to
// towar). Cena = netto z poziomu `poziom_ceny` kartoteki (5 = Hurt EUR) - z GT, nie z pliku.

const { wariantyEan } = require('../pricing/konkurencja-allegro');

// "PL 698-185-00-13" -> "6981850013". Prefiks kraju i separatory nie sa czescia numeru.
function golyNip(nip) {
  return String(nip || '').toUpperCase().replace(/^[A-Z]{2}/, '').replace(/[^0-9A-Z]/g, '');
}

// Klucz w uwagach ZK - po nim skrypt sprawdza, czy to zamowienie juz powstalo (ponowienie po
// zerwanej odpowiedzi mostu nie moze zalozyc drugiego ZK).
function znacznikKlucza(klucz) {
  return `WMS-ZK:${klucz}`;
}

// Towary GT pasujace do pozycji: po symbolu albo po kazdym wariancie EAN (zera wiodace, zasada
// usera 2026-11-17). `towary` = wiersze { tw_Id, symbol, ean, kody[] }.
function dopasujPozycje(pozycja, towary) {
  if (pozycja.symbol) {
    const s = String(pozycja.symbol).trim().toUpperCase();
    return towary.filter((t) => String(t.symbol).trim().toUpperCase() === s);
  }
  const warianty = new Set(wariantyEan(pozycja.ean));
  const ids = new Set();
  return towary.filter((t) => {
    const kody = [t.ean, ...(t.kody || [])].filter(Boolean).map((k) => String(k).trim());
    if (!kody.some((k) => warianty.has(k)) || ids.has(t.tw_Id)) return false;
    ids.add(t.tw_Id);
    return true;
  });
}

// Waliduje specyfikacje wobec danych z GT i sklada zadanie dla mostu (POST /api/zk).
// gt = { kontrahenci[], vat: {vat_Id}|null, walutaPoziomu, towary[], kluczZajety: numer|null }
// Zwraca { bledy[], ostrzezenia[], wiersze[], zadanie|null }.
function zbudujZk(spec, gt, { podglad }) {
  const bledy = [];
  const ostrzezenia = [];
  if (!spec.klucz) bledy.push('Brak "klucz" (np. K4ENERGY-2026-11-22).');
  if (gt.kluczZajety) bledy.push(`ZK z kluczem ${znacznikKlucza(spec.klucz)} juz istnieje: ${gt.kluczZajety}.`);
  if (gt.kontrahenci.length !== 1) {
    bledy.push(`NIP ${spec.nip}: ${gt.kontrahenci.length} kontrahentow w GT (musi byc dokladnie 1).`);
  }
  if (spec.vat && !gt.vat) bledy.push(`Stawka VAT "${spec.vat}" nie istnieje w sl_StawkaVAT.`);
  const waluta = spec.waluta || 'PLN';
  if (gt.walutaPoziomu && gt.walutaPoziomu !== waluta) {
    bledy.push(`Poziom cen ${spec.poziom_ceny} jest w ${gt.walutaPoziomu}, a ZK w ${waluta}.`);
  }
  if (!Array.isArray(spec.pozycje) || !spec.pozycje.length) bledy.push('ZK bez pozycji.');

  const wiersze = [];
  for (const [i, p] of (spec.pozycje || []).entries()) {
    const opis = p.symbol ? `symbol ${p.symbol}` : `EAN ${p.ean}`;
    if (!(Number(p.ilosc) > 0) || !Number.isInteger(Number(p.ilosc))) {
      bledy.push(`Pozycja ${i + 1} (${opis}): ilosc ${p.ilosc} - musi byc liczba calkowita > 0.`);
      continue;
    }
    const trafienia = dopasujPozycje(p, gt.towary);
    if (trafienia.length !== 1) {
      bledy.push(`Pozycja ${i + 1} (${opis}): ${trafienia.length} towarow w GT`
        + (trafienia.length ? ` (${trafienia.map((t) => t.symbol).join(', ')})` : '') + ' - musi byc dokladnie 1.');
      continue;
    }
    const t = trafienia[0];
    if (t.usuniety) bledy.push(`Pozycja ${i + 1} (${t.symbol}): towar usuniety w GT.`);
    if (!(Number(t.cena) > 0)) bledy.push(`Pozycja ${i + 1} (${t.symbol}): cena z poziomu ${spec.poziom_ceny} = ${t.cena}.`);
    const ilosc = Number(p.ilosc);
    const stan = Number(t.stan_mag) || 0;
    const rez = Number(t.rez_mag) || 0;
    if (ilosc > stan - rez) {
      ostrzezenia.push(`${t.symbol}: zamawiane ${ilosc}, na magazynie ${spec.magazyn_id} dostepne ${stan - rez}`
        + ` (stan ${stan}, rez. ${rez}) - rezerwacja przekroczy stan.`);
    }
    wiersze.push({ ...t, ilosc, wartosc: Math.round(ilosc * Number(t.cena) * 100) / 100 });
  }
  const powtorzone = wiersze.filter((w, i) => wiersze.findIndex((x) => x.tw_Id === w.tw_Id) !== i);
  for (const w of powtorzone) bledy.push(`Towar ${w.symbol} wystepuje w zamowieniu wiecej niz raz.`);

  if (bledy.length) return { bledy, ostrzezenia, wiersze, zadanie: null };
  return {
    bledy,
    ostrzezenia,
    wiersze,
    zadanie: {
      kontrahent_id: gt.kontrahenci[0].kh_Id,
      magazyn_id: Number(spec.magazyn_id),
      waluta,
      vat_id: gt.vat ? gt.vat.vat_Id : null,
      rezerwacja: spec.rezerwacja !== false,
      uwagi: [spec.uwagi, znacznikKlucza(spec.klucz)].filter(Boolean).join('\n'),
      pozycje: wiersze.map((w) => ({ tw_id: w.tw_Id, ilosc: w.ilosc, cena_netto: Number(w.cena) })),
      podglad: !!podglad,
    },
  };
}

// Porownuje to, co most odczytal z obiektu Sfery, z zadaniem: ceny, ilosci i VAT na kazdej
// pozycji + suma netto. Rozjazd = Sfera zrobila cos innego, niz chcielismy (np. przeliczyla
// cene na PLN albo nadpisala VAT z kartoteki) - wtedy nie zapisujemy.
function sprawdzPodglad(zadanie, odp) {
  const roznice = [];
  const poz = odp?.pozycje || [];
  if (poz.length !== zadanie.pozycje.length) {
    roznice.push(`pozycji: Sfera ${poz.length}, zadanie ${zadanie.pozycje.length}`);
  }
  const blisko = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;
  zadanie.pozycje.forEach((z, i) => {
    const p = poz[i];
    if (!p) return;
    if (Number(p.tw_id) !== z.tw_id) roznice.push(`poz. ${i + 1}: tw_id ${p.tw_id} zamiast ${z.tw_id}`);
    if (!blisko(p.ilosc, z.ilosc)) roznice.push(`poz. ${i + 1}: ilosc ${p.ilosc} zamiast ${z.ilosc}`);
    if (!blisko(p.cena_netto, z.cena_netto)) roznice.push(`poz. ${i + 1}: cena ${p.cena_netto} zamiast ${z.cena_netto}`);
    if (zadanie.vat_id != null && Number(p.vat_id) !== zadanie.vat_id) roznice.push(`poz. ${i + 1}: VAT ${p.vat_id} zamiast ${zadanie.vat_id}`);
  });
  const suma = Math.round(zadanie.pozycje.reduce((s, z) => s + z.ilosc * z.cena_netto, 0) * 100) / 100;
  const netto = odp?.naglowek?.wartosc_netto;
  if (!blisko(netto, suma)) roznice.push(`wartosc netto ${netto} zamiast ${suma}`);
  if (zadanie.waluta !== 'PLN' && odp?.naglowek?.waluta !== zadanie.waluta) {
    roznice.push(`waluta ${odp?.naglowek?.waluta} zamiast ${zadanie.waluta}`);
  }
  if (Number(odp?.naglowek?.kontrahent_id) !== zadanie.kontrahent_id) {
    roznice.push(`kontrahent ${odp?.naglowek?.kontrahent_id} zamiast ${zadanie.kontrahent_id}`);
  }
  return roznice;
}

module.exports = { golyNip, znacznikKlucza, dopasujPozycje, zbudujZk, sprawdzPodglad };
