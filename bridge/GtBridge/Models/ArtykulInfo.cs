using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Dane artykulu z kartoteki towarowej GT
    public class ArtykulInfo
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        [JsonPropertyName("artykul_symbol")]
        public string ArtykulSymbol { get; set; } = "";

        [JsonPropertyName("artykul_nazwa")]
        public string ArtykulNazwa { get; set; } = "";

        [JsonPropertyName("artykul_ean")]
        public string? ArtykulEan { get; set; }
    }
}
