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

        public GtController(ISferaGtService sfera)
        {
            _sfera = sfera;
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
