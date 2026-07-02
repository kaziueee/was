using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using GtBridge.Models;
using Microsoft.Extensions.Logging;

namespace GtBridge.Services
{
    // Implementacja do lokalnego developmentu - bez dostepu do Subiekt GT/Sfery.
    // Loguje wywolania i zwraca prawdopodobne odpowiedzi, zeby mozna bylo
    // przetestowac integracje po stronie Node (routes/ruchy.js) end-to-end.
    public class MockSferaGtService : ISferaGtService
    {
        private readonly ILogger<MockSferaGtService> _logger;
        private readonly StanMostu _stan;
        private int _licznikDokumentow = 1;

        public MockSferaGtService(ILogger<MockSferaGtService> logger, StanMostu stan)
        {
            _logger = logger;
            _stan = stan;
        }

        public Task<DokumentResponse> WystawMmAsync(MmRequest request)
        {
            _logger.LogInformation(
                "MOCK MM: artykul={ArtykulGtId} ilosc={Ilosc} {Zrodlo} -> {Cel} (operator={Operator}, uwagi={Uwagi})",
                request.ArtykulGtId, request.Ilosc, request.MagazynZrodlowy, request.MagazynDocelowy, request.Operator, request.Uwagi);

            var numer = $"MM {_licznikDokumentow++}/{DateTime.Now:yyyy}/MOCK";
            _stan.ZapiszOk($"MM {numer}");
            return Task.FromResult(new DokumentResponse { Sukces = true, NumerDokumentu = numer });
        }

        public Task<DokumentResponse> TestPolaczeniaAsync()
        {
            _logger.LogInformation("MOCK test polaczenia");
            _stan.ZapiszOk("Test polaczenia OK (mock)");
            return Task.FromResult(new DokumentResponse { Sukces = true });
        }

        public Task<DokumentResponse> ZapiszLokalizacjeAsync(LokRequest request)
        {
            _logger.LogInformation(
                "MOCK LOK: artykul={ArtykulGtId} miejsce='{Miejsce}' gorna='{Gorna}' zapas='{Zapas}'",
                request.ArtykulGtId, request.MiejsceNaMagazynie, request.LokalizacjaGorna, request.LokalizacjaZapas);

            return Task.FromResult(new DokumentResponse { Sukces = true });
        }

        public Task<List<StanPozycja>> PobierzStanyAsync(string magazynId)
        {
            _logger.LogInformation("MOCK stan: magazyn={MagazynId}", magazynId);
            return Task.FromResult(new List<StanPozycja>());
        }

        public Task<ArtykulInfo?> PobierzArtykulAsync(string artykulGtId)
        {
            _logger.LogInformation("MOCK artykul: id={ArtykulGtId}", artykulGtId);

            return Task.FromResult<ArtykulInfo?>(new ArtykulInfo
            {
                ArtykulGtId = artykulGtId,
                ArtykulSymbol = $"MOCK-{artykulGtId}",
                ArtykulNazwa = "Artykul testowy (mock)",
                ArtykulEan = null,
            });
        }

        public Task<DokumentResponse> WystawRwAsync(InwentaryzacjaDokumentRequest request)
        {
            _logger.LogInformation("MOCK RW: magazyn={Magazyn} pozycji={Liczba}", request.Magazyn, request.Pozycje.Count);
            var numer = $"RW {_licznikDokumentow++}/{DateTime.Now:yyyy}/MOCK";
            return Task.FromResult(new DokumentResponse { Sukces = true, NumerDokumentu = numer });
        }

        public Task<DokumentResponse> WystawPwAsync(InwentaryzacjaDokumentRequest request)
        {
            _logger.LogInformation("MOCK PW: magazyn={Magazyn} pozycji={Liczba}", request.Magazyn, request.Pozycje.Count);
            var numer = $"PW {_licznikDokumentow++}/{DateTime.Now:yyyy}/MOCK";
            return Task.FromResult(new DokumentResponse { Sukces = true, NumerDokumentu = numer });
        }
    }
}
