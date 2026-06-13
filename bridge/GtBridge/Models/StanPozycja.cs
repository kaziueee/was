using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Pojedyncza pozycja stanu magazynowego z GT (do joba rozjazdow)
    public class StanPozycja
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        [JsonPropertyName("artykul_symbol")]
        public string ArtykulSymbol { get; set; } = "";

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; }
    }
}
