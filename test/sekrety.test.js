'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const s = require('../config/sekrety');

test('sekret rozpoznajemy po nazwie, nie po liscie kanalow', () => {
  for (const n of ['SPAPI_CLIENT_SECRET', 'SPAPI_REFRESH_TOKEN', 'SPAPI_CLIENT_ID', 'EMAG_RO_PASS', 'EMPIK_API_KEY',
    'KAUFLAND_SECRET_KEY', 'ALLEGRO_CLIENT_ID', 'SELLASIST_API_KEY', 'GT_SQL_PASSWORD']) {
    assert.ok(s.czySekret(n), n);
  }
  for (const n of ['GT_SQL_HOST', 'EMAG_RO_USER', 'SELLASIST_ACCOUNT', 'WMS_RCLONE_REMOTE', 'PRICING_ZAPIS', 'SPAPI_REGION']) {
    assert.ok(!s.czySekret(n), n);
  }
});

test('jawne sekrety = niepuste zmienne wygladajace na sekret', () => {
  const env = 'GT_SQL_HOST=srv\nGT_SQL_PASSWORD=\nEMAG_RO_USER=a@b\nEMAG_RO_PASS=xyz\n# EMPIK_API_KEY=stary\n';
  assert.deepStrictEqual(s.jawneSekrety(env), ['EMAG_RO_PASS']);
});

const ENV = [
  '# GT',
  'GT_SQL_HOST=192.168.0.200',
  'GT_SQL_PASSWORD=',
  '',
  '# Amazon',
  'SPAPI_REFRESH_TOKEN=Atzr|IwEB#nie-komentarz',
  "EMAG_RO_PASS='ma#hash i spacje'",
  'EMAG_RO_USER=sklep@example.com',
  'PRICING_ZAPIS=1',
].join('\r\n');

test('wydzielZEnv wycina tylko wskazane linie, reszta pliku bez zmian (z CRLF)', () => {
  const { tekst, wartosci } = s.wydzielZEnv(ENV, ['SPAPI_REFRESH_TOKEN', 'EMAG_RO_PASS']);
  const przed = dotenv.parse(ENV);
  assert.deepStrictEqual(wartosci, { SPAPI_REFRESH_TOKEN: przed.SPAPI_REFRESH_TOKEN, EMAG_RO_PASS: 'ma#hash i spacje' });
  assert.ok(tekst.includes('\r\n'), 'konce linii zachowane');
  const po = dotenv.parse(tekst);
  assert.strictEqual(po.SPAPI_REFRESH_TOKEN, undefined);
  assert.strictEqual(po.EMAG_RO_PASS, undefined);
  for (const k of ['GT_SQL_HOST', 'GT_SQL_PASSWORD', 'EMAG_RO_USER', 'PRICING_ZAPIS']) assert.strictEqual(po[k], przed[k], k);
  assert.match(tekst, /^# SPAPI_REFRESH_TOKEN -> \.env\.dpapi/m);
  assert.strictEqual(tekst.split('\r\n').length, ENV.split('\r\n').length, 'liczba linii ta sama');
});

test('wydzielZEnv odmawia, gdy wyciecie jednej linii zgubiloby dane albo zmiennej nie ma', () => {
  assert.throws(() => s.wydzielZEnv('A_KEY=1\nA_KEY=2\n', ['A_KEY']), /dwa razy/);
  assert.throws(() => s.wydzielZEnv('A_KEY="linia1\nlinia2"\n', ['A_KEY']), /kilka linii/);
  assert.throws(() => s.wydzielZEnv('B=1\n', ['A_KEY']), /nie ma w \.env/);
});

test('cytuj: dotenv odczytuje wartosc co do znaku', () => {
  for (const v of ['Atzr|IwEB-abc', 'z#hashem i spacja', "z'apostrofem", 'z"cudzyslowem\'i apostrofem', 'back\\slash\'x', '']) {
    assert.strictEqual(dotenv.parse(`X=${s.cytuj(v)}`).X, v, JSON.stringify(v));
  }
  assert.throws(() => s.cytuj('a\nb'), /wieloliniowa/);
});

test('przywrocDoEnv jest odwrotnoscia wydzielZEnv (sciezka awaryjna)', () => {
  const nazwy = ['SPAPI_REFRESH_TOKEN', 'EMAG_RO_PASS'];
  const { tekst, wartosci } = s.wydzielZEnv(ENV, nazwy);
  const z = s.przywrocDoEnv(tekst, { ...wartosci, NOWY_KEY: 'k#1' });
  assert.deepStrictEqual(dotenv.parse(z), { ...dotenv.parse(ENV), NOWY_KEY: 'k#1' });
  // wraca na swoje miejsce, nie na koniec
  assert.ok(z.indexOf('SPAPI_REFRESH_TOKEN=') < z.indexOf('EMAG_RO_USER='));
});

test('rotacja: nowy klucz dopisany do .env i zaszyfrowany ponownie nie mnozy znacznikow', () => {
  const po1 = s.wydzielZEnv(ENV, ['SPAPI_REFRESH_TOKEN']).tekst;
  const poRotacji = po1 + '\r\nSPAPI_REFRESH_TOKEN=Atzr|nowy';
  const { tekst, wartosci } = s.wydzielZEnv(poRotacji, ['SPAPI_REFRESH_TOKEN']);
  assert.deepStrictEqual(wartosci, { SPAPI_REFRESH_TOKEN: 'Atzr|nowy' });
  assert.strictEqual(tekst.match(/^# SPAPI_REFRESH_TOKEN -> /gm).length, 1);
  // a sciezka awaryjna sprzata nadmiarowy znacznik, gdyby ktos go wkleil recznie
  const zDwoma = tekst + '\r\n# SPAPI_REFRESH_TOKEN -> .env.dpapi (zaszyfrowane)';
  const z = s.przywrocDoEnv(zDwoma, wartosci);
  assert.strictEqual(dotenv.parse(z).SPAPI_REFRESH_TOKEN, 'Atzr|nowy');
  assert.ok(!/^# SPAPI_REFRESH_TOKEN -> /m.test(z));
});

test('uzupelnijEnv: jawne .env i srodowisko wygrywaja, puste NAZWA= nie zaslania sekretu', () => {
  const env = { USTAWIONE_KEY: 'z-env', PUSTE_KEY: '' };
  const ustawione = s.uzupelnijEnv(env, { USTAWIONE_KEY: 'z-dpapi', PUSTE_KEY: 'z-dpapi', NOWE_KEY: 'z-dpapi' });
  assert.deepStrictEqual(env, { USTAWIONE_KEY: 'z-env', PUSTE_KEY: 'z-dpapi', NOWE_KEY: 'z-dpapi' });
  assert.deepStrictEqual(ustawione.sort(), ['NOWE_KEY', 'PUSTE_KEY']);
});

// Straznik: skrypt, ktory wczyta dotenv sam, na produkcji nie zobaczy kluczy z .env.dpapi —
// a objawi sie to dopiero na SRV jako "brak kluczy". Wszystko ma isc przez config/env.
test('poza config/ nikt nie woła dotenv bezposrednio (tylko require config/env)', () => {
  const root = path.join(__dirname, '..');
  const winni = [];
  const przejdz = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.claude', 'db', 'logs', 'public', 'bridge', 'test'].includes(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) przejdz(p);
      else if (e.name.endsWith('.js') && /require\(\s*['"]dotenv['"]\s*\)/.test(fs.readFileSync(p, 'utf8'))) {
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (!rel.startsWith('config/')) winni.push(rel);
      }
    }
  };
  przejdz(root);
  assert.deepStrictEqual(winni, [], `zamien require('dotenv').config() na require('<..>/config/env') w: ${winni.join(', ')}`);
});
