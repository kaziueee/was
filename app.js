const express = require('express');
const path = require('path');

require('./db/database'); // inicjalizacja bazy przy starcie

const lokalizacjeRouter = require('./routes/lokalizacje');
const ruchyRouter = require('./routes/ruchy');
const magazynyRouter = require('./routes/magazyny');
const produktyRouter = require('./routes/produkty');
const rozjazdyRouter = require('./routes/rozjazdy');
const ruchyRetry = require('./services/ruchy-retry');
const rozjazdyJob = require('./services/rozjazdy');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// goly host -> menu Zebry (public/ nie ma indexu w roocie)
app.get('/', (req, res) => res.redirect('/zebra/index.html'));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/lokalizacje', lokalizacjeRouter);
app.use('/api/ruchy', ruchyRouter);
app.use('/api/magazyny', magazynyRouter);
app.use('/api/produkty', produktyRouter);
app.use('/api/rozjazdy', rozjazdyRouter);

app.listen(PORT, () => {
  console.log(`WMS nasluchuje na porcie ${PORT}`);
});

ruchyRetry.start();
rozjazdyJob.start();
