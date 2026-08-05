using System;
using System.IO;
using System.Linq;

namespace GtBridge.Services
{
    // Log mostu do PLIKU - logs/most-YYYY-MM-DD.log obok exe, rotacja dzienna, retencja 90 dni
    // (te same zasady co services/awarie.js po stronie Node).
    //
    // POWOD ISTNIENIA (incydent 2026-08-05): most nie zapisywal NICZEGO. Jego stan zyl wylacznie
    // w ikonie w trayu, wiec po restarcie nie zostawal zaden slad - ani tresc bledu Sfery, ani
    // godzina, ani to, czy wywolanie w ogole doszlo. Tamtego dnia MM przez ~45 minut wpadaly
    // w 'pending' z bledem Sfery i po fakcie nie bylo czego przeczytac: `ruchy.blad_opis` jest
    // czyszczony przy udanym ponowieniu, a Node tej sciezki nie logowal. Zgadywanie przyczyny
    // bez logu = zgadywanie, wiec najpierw log.
    //
    // Log jest CELOWO glupi: append do pliku, bez bufora i bez zadnej biblioteki. Ma dzialac
    // takze wtedy, gdy Sfera wisi, a proces jest w polowie zamykany.
    public static class Dziennik
    {
        private static readonly object Blokada = new();
        private static readonly string Katalog = Path.Combine(AppContext.BaseDirectory, "logs");
        private const int RetencjaDni = 90;

        public static void Zapisz(string zrodlo, string wiadomosc)
        {
            var linia = $"{DateTime.Now:yyyy-MM-ddTHH:mm:ss.fff} [{zrodlo}] {wiadomosc}";
            try
            {
                lock (Blokada)
                {
                    Directory.CreateDirectory(Katalog);
                    File.AppendAllText(Sciezka(DateTime.Now), linia + Environment.NewLine);
                }
            }
            catch
            {
                // Log nie moze wywrocic mostu - jesli dysk odmawia, trudno.
            }
        }

        // Kasuje most-*.log starsze niz RetencjaDni. Wolane raz przy starcie procesu.
        public static void Rotuj()
        {
            try
            {
                if (!Directory.Exists(Katalog)) return;
                var prog = DateTime.Now.AddDays(-RetencjaDni);
                foreach (var plik in Directory.GetFiles(Katalog, "most-*.log"))
                {
                    var nazwa = Path.GetFileNameWithoutExtension(plik); // most-YYYY-MM-DD
                    var czesc = nazwa.Length > 5 ? nazwa.Substring(5) : "";
                    if (DateTime.TryParse(czesc, out var data) && data < prog)
                    {
                        try { File.Delete(plik); } catch { /* zajety/brak praw - trudno */ }
                    }
                }
            }
            catch { /* rotacja jest best-effort */ }
        }

        private static string Sciezka(DateTime dzien) => Path.Combine(Katalog, $"most-{dzien:yyyy-MM-dd}.log");
    }
}
