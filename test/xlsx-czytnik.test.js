'use strict';

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');

const { czytajXlsx, plikiZip, kolumna } = require('../services/xlsx-czytnik');

// Najprostszy ZIP (bez CRC — czytnik go nie sprawdza): nagłówki lokalne z bitem 3 i zerowymi rozmiarami,
// jak w eksportach z paneli — prawdziwe rozmiary tylko w katalogu centralnym.
function zip(pliki, { kompresja = 8 } = {}) {
  const lokalne = [], centralny = [];
  let off = 0;
  for (const [nazwa, tresc] of Object.entries(pliki)) {
    const n = Buffer.from(nazwa, 'utf8');
    const surowe = Buffer.from(tresc, 'utf8');
    const dane = kompresja === 8 ? zlib.deflateRawSync(surowe) : surowe;
    const lok = Buffer.alloc(30);
    lok.writeUInt32LE(0x04034b50, 0); lok.writeUInt16LE(8, 6); lok.writeUInt16LE(kompresja, 8);
    lok.writeUInt16LE(n.length, 26);
    lokalne.push(lok, n, dane);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(kompresja, 10);
    c.writeUInt32LE(dane.length, 20); c.writeUInt32LE(surowe.length, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(off, 42);
    centralny.push(c, n);
    off += 30 + n.length + dane.length;
  }
  const kat = Buffer.concat(centralny);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(pliki).length, 8); eocd.writeUInt16LE(Object.keys(pliki).length, 10);
  eocd.writeUInt32LE(kat.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...lokalne, kat, eocd]);
}

const arkusz = (wiersze) => `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${wiersze}</sheetData></worksheet>`;
const skoroszyt = (arkusze) => ({
  'xl/workbook.xml': `<workbook xmlns:r="x"><sheets>${arkusze.map((a, i) => `<sheet name="${a}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships>${arkusze.map((a, i) => `<Relationship Id="rId${i + 1}" Type="ws" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
});

test('xlsx: wspólne teksty, liczby, tekst w komórce, puste kolumny w środku wiersza, encje', () => {
  const buf = zip({
    ...skoroszyt(['Top oferta', 'Zakres danych']),
    'xl/sharedStrings.xml': '<sst><si><t>ID oferty</t></si><si><t>Różnica w cenie</t></si><si><r><t>za </t></r><r><t xml:space="preserve">wysoka</t></r></si><si><t>A &amp; B</t></si></sst>',
    'xl/worksheets/sheet1.xml': arkusz('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>17734419553</t></is></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>7.99</v></c><c r="D2" t="s"><v>3</v></c></row>'),
    'xl/worksheets/sheet2.xml': arkusz('<row r="1"><c r="A1" t="str"><v>Konto Allegro</v></c><c r="B1"/></row>'),
  });
  const a = czytajXlsx(buf);
  assert.deepStrictEqual(Object.keys(a), ['Top oferta', 'Zakres danych']);
  assert.deepStrictEqual(a['Top oferta'][0], ['ID oferty', null, 'Różnica w cenie']);
  assert.deepStrictEqual(a['Top oferta'][1], ['17734419553', 'za wysoka', 7.99, 'A & B']);
  assert.deepStrictEqual(a['Zakres danych'][0], ['Konto Allegro', null]);
});

test('xlsx: plik bez kompresji (metoda 0) też się czyta', () => {
  const p = plikiZip(zip({ 'a.txt': 'zażółć' }, { kompresja: 0 }));
  assert.strictEqual(p.get('a.txt').toString('utf8'), 'zażółć');
});

test('xlsx: nie-ZIP → czytelny błąd, nie wyjątek z bufora', () => {
  assert.throws(() => czytajXlsx(Buffer.from('to jest csv;a;b\n1;2;3\n'.repeat(5))), /nie jest plik xlsx/);
});

test('xlsx: litery kolumny → indeks', () => {
  assert.strictEqual(kolumna('A1'), 0);
  assert.strictEqual(kolumna('Z9'), 25);
  assert.strictEqual(kolumna('AB12'), 27);
});
