using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Zadanie wystawienia dokumentu MM (przesuniecie miedzymagazynowe) w GT
    public class MmRequest
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        [JsonPropertyName("magazyn_zrodlowy")]
        public string MagazynZrodlowy { get; set; } = "";

        [JsonPropertyName("magazyn_docelowy")]
        public string MagazynDocelowy { get; set; } = "";

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; }

        [JsonPropertyName("operator")]
        public string? Operator { get; set; }
    }
}
