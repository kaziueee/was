using System;

namespace GtBridge.Services
{
    public enum StanPolaczenia { Nieznany, Ok, Blad }

    // Wspoldzielony, watkowo-bezpieczny stan mostu dla ikony w trayu (Faza C#9).
    // SferaGtService aktualizuje po kazdym MM oraz przy tescie polaczenia; ikona (watek UI)
    // odczytuje co ~2s i ustawia kolor + dymek. Trzymamy tylko "ostatnia operacja" - bez
    // aktywnego odpytywania Sfery (zgodnie z wyborem: test na zadanie, nie polling).
    public sealed class StanMostu
    {
        private readonly object _blokada = new();
        private StanPolaczenia _stan = StanPolaczenia.Nieznany;
        private string _komunikat = "start";
        private DateTime? _czas;

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

        public (StanPolaczenia Stan, string Komunikat, DateTime? Czas) Odczytaj()
        {
            lock (_blokada)
            {
                return (_stan, _komunikat, _czas);
            }
        }
    }
}
