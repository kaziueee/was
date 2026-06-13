using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Wspolna odpowiedz dla operacji wystawiajacych/aktualizujacych dane w GT (MM, LOK, RW, PW)
    public class DokumentResponse
    {
        [JsonPropertyName("sukces")]
        public bool Sukces { get; set; }

        [JsonPropertyName("numer_dokumentu")]
        public string? NumerDokumentu { get; set; }

        [JsonPropertyName("blad")]
        public string? Blad { get; set; }
    }
}
