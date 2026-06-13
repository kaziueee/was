'use strict';

// Okresowy job ponawiania ruchow 'pending' - na wypadek gdy most C# / Sfera byly
// chwilowo niedostepne przy tworzeniu ruchu (POST /mm, /lok). Patrz CLAUDE.md
// "Kolejka": ruch zostaje 'pending', nie ginie - ten job probuje go dogonic
// bez udzialu magazyniera. Rowniez wywolywalne recznie przez POST /:id/retry.

const db = require('../db/database');
const { wykonajRuchGT } = require('./ruchy-gt');

const DOMYSLNY_INTERWAL_MS = 5 * 60 * 1000; // 5 minut

// Probuje ponowic kazdy ruch 'pending' (od najstarszego). Bledy pojedynczych
// ruchow nie przerywaja calosci - zostaja zapisane w blad_opis przez wykonajRuchGT.
async function ponowPendingRuchy() {
  const pending = db.prepare("SELECT id FROM ruchy WHERE status = 'pending' ORDER BY data_ruchu ASC").all();
  for (const { id } of pending) {
    try {
      await wykonajRuchGT(id);
    } catch (err) {
      console.error(`[ruchy-retry] Ruch ${id}:`, err.message);
    }
  }
  return pending.length;
}

// Uruchamia job w tle co interwalMs. Timer.unref(), zeby nie blokowal zamkniecia procesu.
function start(interwalMs = DOMYSLNY_INTERWAL_MS) {
  const timer = setInterval(() => {
    ponowPendingRuchy().catch((err) => console.error('[ruchy-retry]', err.message));
  }, interwalMs);
  timer.unref?.();
  return timer;
}

module.exports = { ponowPendingRuchy, start };
