'use strict';

// Polaczenie do bazy SQL Server Subiekta GT - odczyt do testow / synchronizacji
// produktow. Dane polaczenia w .env (patrz .env.example), GT_SQL_PASSWORD nie jest
// w repo. To polaczenie jest tylko do odczytu - zapisy do GT ida przez Sfere (GtBridge).

require('dotenv').config();
const sql = require('mssql');

const config = {
  server: process.env.GT_SQL_HOST,
  port: Number(process.env.GT_SQL_PORT),
  database: process.env.GT_SQL_DATABASE,
  user: process.env.GT_SQL_USER,
  password: process.env.GT_SQL_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
};

let poolPromise;

function getPool() {
  if (!poolPromise) {
    // Gdy polaczenie sie nie uda, wyzeruj cache - inaczej odrzucona obietnica
    // zostaje w poolPromise na zawsze i kazde kolejne zapytanie pada az do restartu.
    poolPromise = sql.connect(config).catch((err) => {
      poolPromise = undefined;
      throw err;
    });
  }
  return poolPromise;
}

async function query(tekst, parametry = {}) {
  const pool = await getPool();
  const request = pool.request();
  for (const [nazwa, wartosc] of Object.entries(parametry)) {
    request.input(nazwa, wartosc);
  }
  return request.query(tekst);
}

// Dzieli tablice na paczki o podanym rozmiarze - SQL Server ma limit ~2100
// parametrow na zapytanie, wieksze listy IN (...) trzeba wykonywac w paczkach.
function naCzesci(tablica, rozmiar) {
  const wynik = [];
  for (let i = 0; i < tablica.length; i += rozmiar) {
    wynik.push(tablica.slice(i, i + rozmiar));
  }
  return wynik;
}

module.exports = { getPool, query, sql, naCzesci };
