const express = require('express');
const path = require('path');

require('./db/database'); // inicjalizacja bazy przy starcie

const lokalizacjeRouter = require('./routes/lokalizacje');
const ruchyRouter = require('./routes/ruchy');
const magazynyRouter = require('./routes/magazyny');
const produktyRouter = require('./routes/produkty');
const rozjazdyRouter = require('./routes/rozjazdy');
const pulpitRouter = require('./routes/pulpit');
const uzupelnieniaRouter = require('./routes/uzupelnienia');
const sciezkiRouter = require('./routes/sciezki');
const zwrotyRouter = require('./routes/zwroty');
const dostawyRouter = require('./routes/dostawy');
const zestawieniaRouter = require('./routes/zestawienia');
const doSprawdzeniaRouter = require('./routes/do-sprawdzenia');
const audytRouter = require('./routes/audyt');
const statusRouter = require('./routes/status');
const uzytkownicyRouter = require('./routes/uzytkownicy');
const blokadyRouter = require('./routes/blokady');
const blokady = require('./services/blokady');
const auth = require('./services/auth');
const ruchyRetry = require('./services/ruchy-retry');
const rozjazdyJob = require('./services/rozjazdy');
const rozmontowaniaJob = require('./services/rozmontowania');
const backupJob = require('./services/backup');
const reconciliacjaMM = require('./services/reconciliacja-mm');
const pulpitSnapshot = require('./services/pulpit-snapshot');
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

// logowanie/uzytkownicy (obsluguje wlasny auth) + blokady edycji (wymagaja sesji w routerze)
app.use('/api/uzytkownicy', uzytkownicyRouter);
app.use('/api/blokady', blokadyRouter);

// Na zapisach (POST/PUT/DELETE) wymagamy sesji i WSTRZYKUJEMY operatora z tokenu do req.body
// (backend = zrodlo prawdy dla "kto"; handlery w routes/* nie musza byc zmieniane). GET otwarte.
// blokujUcznia(...) to FABRYKA - kazde uzycie musi byc wywolane. Podanie samej funkcji
// (bez nawiasow) przekazaloby Expressowi fabryke jako middleware i trasa sypalaby 500.
// Uczen ma dostep do Sciezek i zwrotow; ponizsze wyjatki to dokladnie to, czego wymaga
// ekran Zwrotow na Zebrze (public/zebra/zwroty.js) - nic ponadto:
//   /lokalizacje/kod/:kod - GET, rozwiazanie zeskanowanego kodu lokalizacji docelowej
//   /ruchy/rozloz         - samo odlozenie; handler dodatkowo zaweza ucznia do kubelka 'zwrot'
app.use('/api/lokalizacje', auth.wymagajSesjiNaZapisie, auth.blokujUcznia(['/kod']), lokalizacjeRouter);
app.use('/api/ruchy', auth.wymagajSesjiNaZapisie, auth.blokujUcznia(['/rozloz']), blokady.middlewareRuch, ruchyRouter);
app.use('/api/uzupelnienia', auth.wymagajSesjiNaZapisie, auth.blokujUcznia(), uzupelnieniaRouter);
app.use('/api/sciezki', auth.wymagajSesjiNaZapisie, sciezkiRouter);
app.use('/api/zwroty', auth.wymagajSesjiNaZapisie, zwrotyRouter);   // uczen: zwroty to jego robota
app.use('/api/dostawy', auth.wymagajSesjiNaZapisie, auth.blokujUcznia(), dostawyRouter);
app.use('/api/zestawienia', zestawieniaRouter);  // czysty odczyt z GT - bez sesji, jak /api/produkty
app.use('/api/do-sprawdzenia', doSprawdzeniaRouter);  // czysty odczyt (GT + kopia WMS), nie robi ruchow
app.use('/api/magazyny', magazynyRouter);
app.use('/api/status', statusRouter); // publiczny - pasek stanu na ekranie logowania
app.use('/api/produkty', produktyRouter);
app.use('/api/rozjazdy', rozjazdyRouter);
app.use('/api/pulpit', pulpitRouter);
app.use('/api/audyt', audytRouter);

// error-handling middleware MUSI byc po trasach (Express: 4 argumenty = handler bledow)
app.use(awarie.middleware);

app.listen(PORT, () => {
  console.log(`WMS nasluchuje na porcie ${PORT}`);
});

ruchyRetry.start();
rozjazdyJob.start();
rozmontowaniaJob.start();
backupJob.start();
reconciliacjaMM.start();
pulpitSnapshot.start();
