using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
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
    // dziala wylacznie na serwerze (Windows), gdzie biblioteka Sfery jest zarejestrowana.
    //
    // Logowanie i WystawMmAsync zaimplementowane wg modelu obiektowego z gta.chm
    // (obiekt GT, Uruchom, Dodatki.Szyfruj, SuDokumentyManager.DodajMM, SuDokument,
    // SuPozycje.Dodaj). Pozostale metody (lokalizacje/stany/inwentaryzacja) - patrz nizej.
    public sealed class SferaGtService : ISferaGtService, IDisposable
    {
        private readonly SferaOptions _opcje;
        private readonly StanMostu _stan;
        private dynamic? _subiekt;

        // Sfera (COM automation InsERT GT) wymaga apartamentu STA. Watki ASP.NET Core
        // sa MTA, wiec utworzenie obiektu COM wprost konczy sie 0x8000FFFF (E_UNEXPECTED,
        // "katastrofalny blad"). Dlatego CALA praca z COM (tworzenie i uzycie obiektu)
        // idzie na jeden dedykowany watek STA - on tez naturalnie serializuje wywolania
        // (Sfera nie jest watkowo-bezpieczna).
        private readonly BlockingCollection<Action> _zadania = new();
        private readonly Thread _watekSta;

        public SferaGtService(IOptions<SferaOptions> opcje, StanMostu stan)
        {
            _opcje = opcje.Value;
            _stan = stan;
            _watekSta = new Thread(PetlaSta) { IsBackground = true, Name = "SferaSTA" };
            _watekSta.SetApartmentState(ApartmentState.STA);
            _watekSta.Start();
        }

        // Petla watku STA - wykonuje kolejno zadania z kolejki. Kazde zadanie ma
        // wlasny try/catch (w NaWatkuSta), wiec petla nie umiera na bledzie.
        private void PetlaSta()
        {
            foreach (var zadanie in _zadania.GetConsumingEnumerable())
            {
                zadanie();
            }
        }

        // Wykonuje funkcje na watku STA i czeka na wynik (lub propaguje wyjatek).
        private T NaWatkuSta<T>(Func<T> funkcja)
        {
            Exception? blad = null;
            T wynik = default!;
            using var gotowe = new ManualResetEventSlim(false);
            _zadania.Add(() =>
            {
                try { wynik = funkcja(); }
                catch (Exception e) { blad = e; }
                finally { gotowe.Set(); }
            });
            gotowe.Wait();
            if (blad != null) throw blad;
            return wynik;
        }

        // Wartosci enumow Sfery (gta.chm) - uzywamy ich liczbowo, bo late-bound COM
        // nie zna stalych InsERT.* z type library.
        private const int ProduktSubiekt = 1;            // ProduktEnum.gtaProduktSubiekt
        private const int AutentykacjaMieszana = 0;      // AutentykacjaEnum.gtaAutentykacjaMieszana
        private const int UruchomDopasujOperatora = 2;   // UruchomDopasujEnum.gtaUruchomDopasujOperatora
        private const int UruchomNowy = 2;               // UruchomEnum.gtaUruchomNowy
        private const int UruchomWTle = 4;               // UruchomEnum.gtaUruchomWTle
        private const int DokumentStatusWywolany = 1;    // SubiektDokumentStatusEnum.gtaSubiektDokumentStatusWywolany
        private const int SubiektDokumentMM = -27;       // SubiektDokumentEnum.gtaSubiektDokumentMM (0xFFFFFFE5)

        // Laczy sie z Subiektem GT przez Sfere (obiekt InsERT.GT -> Subiekt). Uruchamia
        // dedykowana instancje w tle (gtaUruchomNowy | gtaUruchomWTle) - bez okna UI.
        // Polaczenie jest cache'owane (_subiekt). Hasla szyfrujemy w runtime przez
        // InsERT.Dodatki.Szyfruj - Sfera nie przyjmuje hasel jawnych. Zob. gta.chm >
        // obiekt GT, metoda Uruchom, Dodatki.Szyfruj.
        // Wolane wylacznie z watku STA (przez NaWatkuSta) - obiekt COM tworzony i
        // uzywany na tym samym watku STA, czego wymaga Sfera.
        private dynamic Polacz()
        {
            if (_subiekt != null)
            {
                return _subiekt;
            }

            var typGt = Type.GetTypeFromProgID(_opcje.ProgId)
                ?? throw new InvalidOperationException(
                    $"Nie znaleziono zarejestrowanego komponentu COM '{_opcje.ProgId}'. " +
                    "Sprawdz, czy Subiekt GT wraz z Sfera sa zainstalowane na tym serwerze " +
                    "(Pomoc > gta.chm > Sfera dla aplikacji > Pierwsze kroki).");

            var typDodatki = Type.GetTypeFromProgID("InsERT.Dodatki")
                ?? throw new InvalidOperationException(
                    "Nie znaleziono komponentu COM 'InsERT.Dodatki' (potrzebny do szyfrowania hasel Sfery).");

            dynamic gt = Activator.CreateInstance(typGt)
                ?? throw new InvalidOperationException($"Nie udalo sie utworzyc instancji '{_opcje.ProgId}'.");
            dynamic dodatki = Activator.CreateInstance(typDodatki)
                ?? throw new InvalidOperationException("Nie udalo sie utworzyc instancji 'InsERT.Dodatki'.");

            gt.Produkt = ProduktSubiekt;
            gt.Autentykacja = AutentykacjaMieszana;
            gt.Serwer = _opcje.Serwer;
            gt.Uzytkownik = _opcje.Uzytkownik;
            gt.UzytkownikHaslo = dodatki.Szyfruj(_opcje.UzytkownikHaslo ?? "");
            gt.Baza = _opcje.Baza;
            gt.Operator = _opcje.Operator;
            if (!string.IsNullOrEmpty(_opcje.OperatorHaslo))
            {
                gt.OperatorHaslo = dodatki.Szyfruj(_opcje.OperatorHaslo);
            }

            _subiekt = gt.Uruchom(UruchomDopasujOperatora, UruchomNowy | UruchomWTle);
            return _subiekt;
        }

        // Wystawia dokument MM (przesuniecie miedzymagazynowe) w GT przez Sfere.
        // Dziala dla dowolnego kierunku miedzy magazynami GT (K4/K4G/MAG/LS) - kierunek
        // okreslaja MagazynNadawczyId (zrodlo) i MagazynOdbiorczyId (cel) z request.
        // StatusDokumentu = Wywolany => realny skutek magazynowy (przerzuca stany).
        // Nie rzuca - bledy (w tym brak towaru na magazynie, brak licencji Sfery) zwraca
        // w DokumentResponse.Blad, zeby Node mogl zostawic ruch jako 'pending'.
        public Task<DokumentResponse> WystawMmAsync(MmRequest request)
        {
            try
            {
                var odpowiedz = NaWatkuSta(() =>
                {
                    dynamic subiekt = Polacz();

                    dynamic dok = subiekt.Dokumenty.Dodaj(SubiektDokumentMM);
                    dok.MagazynNadawczyId = request.MagazynZrodlowyId;
                    dok.MagazynOdbiorczyId = request.MagazynDocelowyId;

                    long towarId = long.Parse(request.ArtykulGtId);
                    dynamic pozycja = dok.Pozycje.Dodaj(towarId);
                    pozycja.IloscJm = request.Ilosc;

                    // Uwagi dokumentu (Faza A#3): gotowy tekst z Node ("WMS-RUCH:<id> | kto | kiedy").
                    // Zawiera klucz idempotencji (jesli odpowiedz HTTP zaginie, ponowienie odnajdzie
                    // ten dokument po kluczu - services/gt-dokumenty.js znajdzMMpoKluczu - zamiast
                    // wystawic drugi MM) oraz slad kto/kiedy zrobil przesuniecie.
                    // UWAGA: nazwa wlasciwosci Uwagi wg gta.chm > SuDokument - zweryfikowac na
                    // serwerze przy pierwszym tescie MM (gdyby COM rzucil "brak skladowej Uwagi").
                    if (!string.IsNullOrEmpty(request.Uwagi))
                    {
                        dok.Uwagi = request.Uwagi;
                    }

                    dok.StatusDokumentu = DokumentStatusWywolany;
                    dok.Zapisz();

                    string numer = dok.NumerPelny;
                    return new DokumentResponse { Sukces = true, NumerDokumentu = numer };
                });
                _stan.ZapiszOk($"MM {odpowiedz.NumerDokumentu}");
                return Task.FromResult(odpowiedz);
            }
            catch (Exception ex)
            {
                var blad = OpisBledu(ex);
                _stan.ZapiszBlad($"MM: {blad}");
                return Task.FromResult(new DokumentResponse { Sukces = false, Blad = blad });
            }
        }

        // Lekki test polaczenia: loguje sie do Sfery (Polacz na watku STA) i nic nie wystawia.
        // Aktualizuje StanMostu, zeby ikona od razu pokazala wynik. Nie rzuca.
        public Task<DokumentResponse> TestPolaczeniaAsync()
        {
            try
            {
                NaWatkuSta<object?>(() => { Polacz(); return null; });
                _stan.ZapiszOk("Test polaczenia OK");
                return Task.FromResult(new DokumentResponse { Sukces = true });
            }
            catch (Exception ex)
            {
                var blad = OpisBledu(ex);
                _stan.ZapiszBlad($"Test: {blad}");
                return Task.FromResult(new DokumentResponse { Sukces = false, Blad = blad });
            }
        }

        // Tlumaczy wyjatki COM Sfery na czytelny komunikat (HRESULT-y z gta.chm).
        private static string OpisBledu(Exception ex)
        {
            string opis = ex switch
            {
                COMException com => (uint)com.ErrorCode switch
                {
                    0x80040F60 => "Brak towaru na magazynie zrodlowym (za malo sztuk do przesuniecia).",
                    0x80040F62 => "Dokument zostal usuniety z danych.",
                    0x800411F2 => "Brak waznej licencji Sfery w podmiocie GT.",
                    0x80041248 => "Licencja Sfery wygasla.",
                    0x80041797 => "Uzytkownik SQL nie ma uprawnienia VIEW SERVER STATE.",
                    0x800414F6 => "Zla strona kodowa w systemie Windows (wymagana 1250 ANSI - Europa Srodkowa).",
                    0x800414F7 => "Zle ustawienia regionalne (wymagany jezyk polski).",
                    _ => $"Blad Sfery 0x{(uint)com.ErrorCode:X8}: {com.Message}",
                },
                _ => ex.Message,
            };
            return opis;
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
            // Zamkniecie Subiekta musi sie odbyc na tym samym watku STA, ktory go utworzyl.
            try
            {
                NaWatkuSta<object?>(() =>
                {
                    if (_subiekt != null)
                    {
                        try { _subiekt.Zakoncz(); } catch { /* zamykamy mimo bledu */ }
                        Marshal.ReleaseComObject(_subiekt);
                        _subiekt = null;
                    }
                    return null;
                });
            }
            catch { /* zamykamy mimo bledu */ }
            _zadania.CompleteAdding();
        }
    }
}
