using System;
using System.Threading;

namespace GtBridge.Services
{
    public enum StanPolaczenia { Nieznany, Ok, Blad }

    // Wspoldzielony, watkowo-bezpieczny stan mostu (Faza C#9): dla ikony w trayu ORAZ dla
    // endpointu /api/zdrowie, ktory czyta go Node (routes/status.js).
    //
    // Trzymamy dwie rzeczy:
    //  1. WYNIK ostatniej operacji Sfery (ok/blad + komunikat + czas) - to widzi ikona,
    //  2. czy wlasnie TRWA operacja na watku STA i od kiedy (+ ile zadan czeka w kolejce).
    //
    // Punkt 2 dolozony po incydencie 2026-08-05: Sfera zaklinowala sie na ~45 minut, a z zewnatrz
    // nie dalo sie odroznic "most nic nie robi" od "most stoi w wywolaniu COM, ktore nie wraca".
    // Kestrel odpowiadal normalnie (kropka "Most" w WMS byla zielona), bo HTTP zyje niezaleznie od
    // watku STA. `ZajetyOd` to jedyny tani sygnal, ze cos wisi - odczyt zmiennej, ZERO wywolan COM
    // (health-check pukajacy w Sfere dokladalby zadan do tej samej zaklinowanej kolejki).
    public sealed class StanMostu
    {
        private readonly object _blokada = new();
        private StanPolaczenia _stan = StanPolaczenia.Nieznany;
        private string _komunikat = "start";
        private DateTime? _czas;

        private DateTime? _zajetyOd;
        private string? _operacja;
        private int _wKolejce;

        public DateTime StartProcesu { get; } = DateTime.Now;

        public void ZapiszOk(string komunikat) => Ustaw(StanPolaczenia.Ok, komunikat);
        public void ZapiszBlad(string komunikat) => Ustaw(StanPolaczenia.Blad, komunikat);

        private void Ustaw(StanPolaczenia stan, string komunikat)
        {
            lock (_blokada)
            {
                _stan = stan;
                _komunikat = komunikat ?? "";
                _czas = DateTime.Now;
            }
        }

        // Zadanie trafilo do kolejki watku STA (jeszcze przed uruchomieniem).
        public void ZadanieWKolejce() => Interlocked.Increment(ref _wKolejce);

        // Zadanie ruszylo na watku STA - od tej chwili wiemy, CO most robi i OD KIEDY.
        public void ZadanieStart(string operacja)
        {
            Interlocked.Decrement(ref _wKolejce);
            lock (_blokada)
            {
                _zajetyOd = DateTime.Now;
                _operacja = operacja;
            }
        }

        public void ZadanieKoniec()
        {
            lock (_blokada)
            {
                _zajetyOd = null;
                _operacja = null;
            }
        }

        public (StanPolaczenia Stan, string Komunikat, DateTime? Czas) Odczytaj()
        {
            lock (_blokada)
            {
                return (_stan, _komunikat, _czas);
            }
        }

        // Pelny obraz dla /api/zdrowie. Nie dotyka COM - same pola w pamieci.
        public (StanPolaczenia Stan, string Komunikat, DateTime? Czas, DateTime? ZajetyOd, string? Operacja, int WKolejce) OdczytajPelny()
        {
            lock (_blokada)
            {
                return (_stan, _komunikat, _czas, _zajetyOd, _operacja, Volatile.Read(ref _wKolejce));
            }
        }
    }
}
