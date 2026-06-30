const express = require('express');
const path = require('path');

require('./db/database'); // inicjalizacja bazy przy starcie

const lokalizacjeRouter = require('./routes/lokalizacje');
const ruchyRouter = require('./routes/ruchy');
const magazynyRouter = require('./routes/magazyny');
const produktyRouter = require('./routes/produkty');
const rozjazdyRouter = require('./routes/rozjazdy');
const uzupelnieniaRouter = require('./routes/uzupelnienia');
const audytRouter = require('./routes/audyt');
const ruchyRetry = require('./services/ruchy-retry');
const rozjazdyJob = require('./services/rozjazdy');
const backupJob = require('./services/backup');
const awarie = require('./services/awarie');

// globalne lapanie wyjatkow/odrzuconych obietnic + rotacja logu awarii - jak najwczesniej
awarie.start();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// goly host -> aplikacja Zebry (SPA: menu + Ruch w ruch.html)
app.get('/', (req, res) => res.redirect('/zebra/ruch.html'));

// Cache-Control: no-cache => przegladarka (Chrome na Zebrze) ZAWSZE rewaliduje
// statyki (CSS/JS/HTML). Pliki sa male, siec to LAN, a dzieki temu po edycji
// terminal od razu dostaje swieza wersje - bez tego Chrome serwuje stary app.css
// (tak powstal "duch" kroku wybor na ekranie start po zmianie CSS).
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.use('/api/lokalizacje', lokalizacjeRouter);
app.use('/api/ruchy', ruchyRouter);
app.use('/api/magazyny', magazynyRouter);
app.use('/api/produkty', produktyRouter);
app.use('/api/rozjazdy', rozjazdyRouter);
app.use('/api/uzupelnienia', uzupelnieniaRouter);
app.use('/api/audyt', audytRouter);

// error-handling middleware MUSI byc po trasach (Express: 4 argumenty = handler bledow)
app.use(awarie.middleware);

app.listen(PORT, () => {
  console.log(`WMS nasluchuje na porcie ${PORT}`);
});

ruchyRetry.start();
rozjazdyJob.start();
backupJob.start();
