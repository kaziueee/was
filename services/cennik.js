'use strict';

// Wycena towaru po SKU/EAN: koszt zakupu z GT (tw_Cena.tc_CenaNetto0, zlaczenie tc_IdTowar=tw_Id)
// + waga rozliczeniowa DHL z GT + reguly rynkow z config/rynki. Polaczenie read-only (gt-sql).
//
// Waga rozliczeniowa (DHL bierze wyzsza z: rzeczywista / gabarytowa):
//   rzeczywista     = pw_Dane.pwd_Tekst06 (kg, przecinek)
//   gab. z kartonu  = pw_Dane.pwd_Tekst10 (kg, kropka) - liczona przez WMS z najmniejszego kartonu
//   gab. goly wymiar= pw_Dane.pwd_Tekst09 (fallback, gdy brak kartonu)
// pw_Dane: wiersz towaru = (pwd_TypObiektu=-14, pwd_IdObiektu=tw_Id).

const { query } = require('./gt-sql');
const rynki = require('../config/rynki');

// tekst GT ("0,874" albo "1.31") -> liczba; 0 gdy brak/niepoprawne.
function liczba(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

async function wycenaPoSku(sku, nadpisz = {}) {
  const r = await query(
    `SELECT TOP 1 t.tw_Symbol, t.tw_Nazwa, c.tc_CenaNetto0 AS koszt,
            pw.pwd_Tekst06 AS wagaRzecz, pw.pwd_Tekst10 AS gabKarton, pw.pwd_Tekst09 AS gabDhl
       FROM tw__Towar t
       JOIN tw_Cena c ON c.tc_IdTowar = t.tw_Id
       LEFT JOIN pw_Dane pw ON pw.pwd_TypObiektu = -14 AND pw.pwd_IdObiektu = t.tw_Id
      WHERE t.tw_Symbol = @sku OR t.tw_PodstKodKresk = @sku`,
    { sku });
  const row = r.recordset[0];
  if (!row) return null;

  const koszt = Number(row.koszt) || 0;
  const rzecz = liczba(row.wagaRzecz);
  const gab = liczba(row.gabKarton) || liczba(row.gabDhl); // gab. z kartonu, fallback goly wymiar
  let wagaGT = Math.max(rzecz, gab);
  const wagaZnana = wagaGT > 0;
  if (!wagaZnana) wagaGT = rynki.DOMYSLNE.waga; // brak wymiarow w GT -> domyslna

  // waga reczna z panelu nadpisuje; inaczej waga rozliczeniowa z GT
  const waga = nadpisz.waga != null ? +nadpisz.waga : wagaGT;

  // tryb/bufor z panelu nadpisuja preset (DOMYSLNE) - np. tryb 'kotwica' + bufor zwrotow
  const over = { waga };
  if (nadpisz.tryb) over.tryb = nadpisz.tryb;
  if (nadpisz.bufor != null) over.bufor = +nadpisz.bufor;
  if (nadpisz.anchor && nadpisz.anchor.nazwa) over.anchor = nadpisz.anchor; // reczna cena na Allegro/Amazon DE

  return {
    sku: row.tw_Symbol,
    nazwa: row.tw_Nazwa,
    koszt,
    waga,
    wagaGT,
    wagaZnana,
    tryb: over.tryb || rynki.DOMYSLNE.tryb,
    bufor: over.bufor != null ? over.bufor : rynki.DOMYSLNE.bufor,
    rynki: rynki.policzWszystkie(koszt, over),
  };
}

module.exports = { wycenaPoSku };
