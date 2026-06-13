using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using GtBridge.Models;
using Microsoft.Extensions.Options;

namespace GtBridge.Services
{
    // Docelowa integracja z Subiekt GT przez Sfere (COM / OLE Automation),
    // biblioteka "InsERT GT dla aplikacji - Biblioteka obiektowa".
    //
    // Uzywamy late-bound COM (Type.GetTypeFromProgID + dynamic), zeby projekt
    // dalo sie zbudowac rowniez na maszynie bez zainstalowanego Subiekta GT -
    // dziala wylacznie na serwerze, gdzie biblioteka Sfery jest zarejestrowana.
    //
    // Szczegoly metod (nazwy obiektow/wlasciwosci) do uzupelnienia na podstawie
    // Pomoc > gta.chm > "Model obiektowy - Subiekt Sfera" oraz przykladow logowania.
    public sealed class SferaGtService : ISferaGtService, IDisposable
    {
        private readonly SferaOptions _opcje;
        private readonly object _lock = new();
        private dynamic? _subiekt;

        public SferaGtService(IOptions<SferaOptions> opcje)
        {
            _opcje = opcje.Value;
        }

        private dynamic Polacz()
        {
            lock (_lock)
            {
                if (_subiekt != null)
                {
                    return _subiekt;
                }

                var typ = Type.GetTypeFromProgID(_opcje.ProgId)
                    ?? throw new InvalidOperationException(
                        $"Nie znaleziono zarejestrowanego komponentu COM '{_opcje.ProgId}'. " +
                        "Sprawdz, czy Subiekt GT wraz z Sfera sa zainstalowane na tym serwerze " +
                        "(Pomoc > gta.chm > Sfera dla aplikacji > Pierwsze kroki).");

                _subiekt = Activator.CreateInstance(typ)
                    ?? throw new InvalidOperationException($"Nie udalo sie utworzyc instancji '{_opcje.ProgId}'.");

                // TODO: uzupelnic logowanie wedlug przykladu z gta.chm, np.:
                // _subiekt.Serwer = _opcje.Serwer;
                // _subiekt.Baza = _opcje.Baza;
                // _subiekt.Operator = _opcje.Operator;
                // _subiekt.OperatorHaslo = _opcje.OperatorHaslo;
                // _subiekt.Zaloguj();

                return _subiekt;
            }
        }

        public Task<DokumentResponse> WystawMmAsync(MmRequest request)
        {
            // TODO: Polacz().SuDokumentyManager - utworzyc SuDokument typu MM:
            // - magazyn zrodlowy/docelowy: request.MagazynZrodlowy / MagazynDocelowy
            // - znalezc towar przez TowaryManager po request.ArtykulGtId
            // - dodac SuPozycja z iloscia request.Ilosc
            // - zapisac/zatwierdzic dokument i zwrocic jego numer (SuDokument.Numer)
            throw new NotImplementedException(
                "WystawMmAsync wymaga implementacji na serwerze z dostepem do Sfery. " +
                "Zob. Pomoc > gta.chm > Model obiektowy > SuDokumentyManager / SuDokument / SuPozycja.");
        }

        public Task<DokumentResponse> ZapiszLokalizacjeAsync(LokRequest request)
        {
            // TODO: Polacz().TowaryManager - znalezc Towar po request.ArtykulGtId i zapisac:
            //   request.MiejsceNaMagazynie -> Towar.Pole1 (tw__Towar.tw_Pole1, standardowe pole dodatkowe)
            //   request.LokalizacjaGorna   -> Towar.Pole8 (tw__Towar.tw_Pole8, standardowe pole dodatkowe)
            //   request.LokalizacjaZapas   -> dynamiczne pole wlasne nr 9 (pwd_Tekst09, przez TwCechy/PolaDynamiczne)
            // null = nie zmieniaj danego pola, "" = wyczysc. Na koniec zapisac towar.
            throw new NotImplementedException(
                "ZapiszLokalizacjeAsync wymaga implementacji na serwerze z dostepem do Sfery. " +
                "Zob. Pomoc > gta.chm > Model obiektowy > Towar > Pole1..Pole8, TwCechy.");
        }

        public Task<List<StanPozycja>> PobierzStanyAsync(string magazynId)
        {
            // TODO: Polacz().TowaryManager - przejsc po towarach i odczytac stan
            // dla magazynu magazynId (wlasciwosc stanu per magazyn).
            throw new NotImplementedException(
                "PobierzStanyAsync wymaga implementacji na serwerze z dostepem do Sfery. " +
                "Zob. Pomoc > gta.chm > Model obiektowy > TowaryManager / Towar.");
        }

        public Task<ArtykulInfo?> PobierzArtykulAsync(string artykulGtId)
        {
            // TODO: Polacz().TowaryManager - znalezc towar po Id == artykulGtId,
            // odczytac Symbol, Nazwa oraz kod EAN (TwKodyKreskowe).
            throw new NotImplementedException(
                "PobierzArtykulAsync wymaga implementacji na serwerze z dostepem do Sfery. " +
                "Zob. Pomoc > gta.chm > Model obiektowy > TowaryManager / Towar.");
        }

        public Task<DokumentResponse> WystawRwAsync(InwentaryzacjaDokumentRequest request)
            => WystawDokumentInwentaryzacyjny("RW", request);

        public Task<DokumentResponse> WystawPwAsync(InwentaryzacjaDokumentRequest request)
            => WystawDokumentInwentaryzacyjny("PW", request);

        private Task<DokumentResponse> WystawDokumentInwentaryzacyjny(string rodzaj, InwentaryzacjaDokumentRequest request)
        {
            // TODO: Polacz().SuDokumentyManager - utworzyc SuDokument typu RW/PW dla
            // request.Magazyn, dodac SuPozycja dla kazdej pozycji z request.Pozycje
            // (artykul + ilosc roznicy), zapisac/zatwierdzic i zwrocic numer dokumentu.
            throw new NotImplementedException(
                $"Wystaw{rodzaj}Async wymaga implementacji na serwerze z dostepem do Sfery. " +
                "Zob. Pomoc > gta.chm > Model obiektowy > SuDokumentyManager / SuDokument / SuPozycja.");
        }

        public void Dispose()
        {
            if (_subiekt != null)
            {
                // TODO: _subiekt.Wyloguj();
                Marshal.ReleaseComObject(_subiekt);
                _subiekt = null;
            }
        }
    }
}
