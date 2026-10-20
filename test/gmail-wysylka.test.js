'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { budujMime, naglowek, SCOPE } = require('../services/gmail-wysylka');

test('Gmail: zakres tylko do wysyłania — nie czyta i nie kasuje skrzynki', () => {
  assert.strictEqual(SCOPE, 'https://www.googleapis.com/auth/gmail.send');
});

test('MIME: temat z polskimi znakami w RFC 2047, adresaci, HTML i obrazek inline z Content-ID', () => {
  const m = budujMime({ do: 'a@x.pl, b@y.pl', temat: 'Sprzedaż pon. 19.10: 41 294 zł', html: '<p>Zażółć</p>',
    obrazy: [{ cid: 'tw89641@wms', typ: 'image/jpeg', bufor: Buffer.from([1, 2, 3]) }] });
  assert.match(m, /^To: a@x\.pl, b@y\.pl\r\n/m);
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  const temat = /^Subject: =\?UTF-8\?B\?([^?]+)\?=/m.exec(m)[1];
  assert.strictEqual(Buffer.from(temat, 'base64').toString('utf8'), 'Sprzedaż pon. 19.10: 41 294 zł');
  assert.match(m, /Content-Type: multipart\/related; boundary="wms-[0-9a-f]+"/);
  assert.match(m, /Content-ID: <tw89641@wms>/);
  const html = /Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(m)[1];
  assert.strictEqual(Buffer.from(html.replace(/\r\n/g, ''), 'base64').toString('utf8'), '<p>Zażółć</p>');
  assert.strictEqual(naglowek('Raport'), 'Raport');                 // ASCII bez kodowania
});

test('MIME: bez adresata — błąd, nie wysyłka w próżnię', () => {
  assert.throws(() => budujMime({ do: ' , ', temat: 'x', html: 'x' }), /Brak adresatów/);
});
