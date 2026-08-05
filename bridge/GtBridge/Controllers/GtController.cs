using System.Collections.Generic;
using System.Threading.Tasks;
using GtBridge.Models;
using GtBridge.Services;
using Microsoft.AspNetCore.Mvc;

namespace GtBridge.Controllers
{
    // Endpointy z CLAUDE.md ("Most C# - endpointy localhost:5000"), wywolywane
    // przez services/gt-bridge.js po stronie Node.
    [ApiController]
    [Route("api")]
    public class GtController : ControllerBase
    {
        private readonly ISferaGtService _sfera;
        private readonly StanMostu _stan;

        public GtController(ISferaGtService sfera, StanMostu stan)
        {
            _sfera = sfera;
            _stan = stan;
        }

        // GET /api/zdrowie - stan mostu dla WMS (routes/status.js) i do diagnostyki z przegladarki.
        //
        // CELOWO nie dotyka Sfery: oddaje wylacznie to, co most JUZ wie (wynik ostatniej operacji
        // + czy watek STA jest czyms zajety i od kiedy). Health-check wolajacy Sfere dokladalby
        // zadania do tej samej kolejki STA, ktora przy awarii jest zaklinowana - czyli pogarszalby
        // stan, ktory ma mierzyc. Dlatego "zdrowie" = obserwacja, nie ping.
        //
        // Powod istnienia (incydent 2026-08-05): WMS pytal most zwyklym GET / i KAZDA odpowiedz
        // HTTP uznawal za "most dziala", wiec kropka byla zielona przez cala awarie Sfery.
        [HttpGet("zdrowie")]
        public ActionResult<ZdrowieResponse> Zdrowie()
        {
            var (stan, komunikat, czas, zajetyOd, operacja, wKolejce) = _stan.OdczytajPelny();
            return Ok(new ZdrowieResponse
            {
                Zyje = true,
                Sfera = stan switch
                {
                    StanPolaczenia.Ok => "ok",
                    StanPolaczenia.Blad => "blad",
                    _ => "nieznany",
                },
                Komunikat = komunikat,
                Czas = czas,
                ZajetyOd = zajetyOd,
                Operacja = operacja,
                WKolejce = wKolejce,
                StartProcesu = _stan.StartProcesu,
            });
        }

        [HttpPost("mm")]
        public async Task<ActionResult<DokumentResponse>> Mm([FromBody] MmRequest request)
        {
            var wynik = await _sfera.WystawMmAsync(request);
            return wynik.Sukces ? Ok(wynik) : StatusCode(502, wynik);
        }

        [HttpPost("lok")]
        public async Task<ActionResult<DokumentResponse>> Lok([FromBody] LokRequest request)
        {
            var wynik = await _sfera.ZapiszLokalizacjeAsync(request);
            return wynik.Sukces ? Ok(wynik) : StatusCode(502, wynik);
        }

        [HttpGet("stan/{magId}")]
        public async Task<ActionResult<List<StanPozycja>>> Stan(string magId)
        {
            return Ok(await _sfera.PobierzStanyAsync(magId));
        }

        [HttpGet("artykul/{id}")]
        public async Task<ActionResult<ArtykulInfo>> Artykul(string id)
        {
            var artykul = await _sfera.PobierzArtykulAsync(id);
            return artykul is null ? NotFound() : Ok(artykul);
        }

        [HttpPost("inwentaryzacja/rw")]
        public async Task<ActionResult<DokumentResponse>> Rw([FromBody] InwentaryzacjaDokumentRequest request)
        {
            var wynik = await _sfera.WystawRwAsync(request);
            return wynik.Sukces ? Ok(wynik) : StatusCode(502, wynik);
        }

        [HttpPost("inwentaryzacja/pw")]
        public async Task<ActionResult<DokumentResponse>> Pw([FromBody] InwentaryzacjaDokumentRequest request)
        {
            var wynik = await _sfera.WystawPwAsync(request);
            return wynik.Sukces ? Ok(wynik) : StatusCode(502, wynik);
        }
    }
}
