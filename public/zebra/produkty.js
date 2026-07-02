// el, pokazKomunikat, ukryjKomunikat - z kreator.js (ladowany przed tym plikiem)

const inputSzukaj = el('input-szukaj');
const wynik = el('wynik');
const wynikiWiele = el('wyniki-wiele');
const checkboxUkryjZero = el('checkbox-ukryj-zero');

// stan ostatniego wyszukiwania (do ponownego renderowania po zmianie checkboxa)
let ostatnieWyniki = null;
let ostatnieObciete = false;

function pokazWynik(dane) {
  ostatnieWyniki = null;
  wynikiWiele.classList.add('hidden');

  el('wynik-nazwa').textContent = dane.nazwa;
  el('wynik-symbol').textContent = `Symbol: ${dane.symbol}`;
  el('wynik-ean').textContent = `EAN: ${dane.ean ?? '—'}`;
  el('wynik-id').textContent = `tw_Id: ${dane.artykul_gt_id}`;

  const stanyEl = el('wynik-stany');
  stanyEl.innerHTML = '';
  for (const [magazyn, w] of Object.entries(dane.stany_gt)) {
    if (w.ilosc === 0) continue;
    const rezerwacja = w.rezerwacja ? ` (rezerwacja: ${w.rezerwacja})` : '';
    const wiersz = document.createElement('div');
    wiersz.textContent = `${magazyn}: ${w.ilosc}${rezerwacja}`;
    stanyEl.appendChild(wiersz);
  }
  if (!stanyEl.children.length) {
    stanyEl.textContent = 'Brak stanu w żadnym magazynie';
  }

  el('wynik-lokalizacja').textContent = formatLokalizacjaGt(dane.lokalizacja_gt) || 'brak danych z GT';

  wynik.classList.remove('hidden');
}

function pokazListeWynikow(wyniki, obciete) {
  ostatnieWyniki = wyniki;
  ostatnieObciete = obciete;
  renderujListeWynikow();
}

function renderujListeWynikow() {
  if (!ostatnieWyniki) return;
  ukryjKomunikat();
  wynik.classList.add('hidden');

  renderujListeProduktow(el('lista-wyboru'), ostatnieWyniki, checkboxUkryjZero, pokazWynik);

  wynikiWiele.classList.remove('hidden');

  if (ostatnieObciete) {
    pokazKomunikat(`Pokazano pierwsze ${ostatnieWyniki.length} wyników — zawęź wyszukiwanie`, 'info');
  }
}

checkboxUkryjZero.addEventListener('change', renderujListeWynikow);

inputSzukaj.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const wartosc = inputSzukaj.value.trim();
  inputSzukaj.value = '';
  if (!wartosc) return;

  ukryjKomunikat();
  wynik.classList.add('hidden');
  wynikiWiele.classList.add('hidden');
  ostatnieWyniki = null;

  try {
    const res = await fetch(`/api/produkty/${encodeURIComponent(wartosc)}`);
    const dane = await res.json();

    if (!res.ok) {
      // zostaw slad czego szukano: wpisany/zeskanowany kod wraca do pola (zaznaczony) + w komunikacie
      inputSzukaj.value = wartosc;
      try { inputSzukaj.select(); } catch { /* pole moze nie wspierac select() */ }
      pokazKomunikat(res.status === 404 ? `Nie znaleziono: „${wartosc}”` : (dane.blad || `Blad ${res.status}`), 'blad');
      return;
    }

    if (dane.wyniki) {
      pokazListeWynikow(dane.wyniki, dane.obciete);
    } else {
      pokazWynik(dane);
    }
  } catch (err) {
    pokazKomunikat(`Blad polaczenia: ${err.message}`, 'blad');
  }
});
