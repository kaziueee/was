using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Pojedyncza pozycja roznicy inwentaryzacyjnej (nadwyzka -> PW, niedobor -> RW)
    public class PozycjaRoznicy
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; }
    }

    // Zadanie wystawienia dokumentu RW/PW w GT na podstawie roznic z inwentaryzacji
    public class InwentaryzacjaDokumentRequest
    {
        [JsonPropertyName("magazyn")]
        public string Magazyn { get; set; } = "";

        [JsonPropertyName("pozycje")]
        public List<PozycjaRoznicy> Pozycje { get; set; } = new();

        [JsonPropertyName("operator")]
        public string? Operator { get; set; }
    }
}
