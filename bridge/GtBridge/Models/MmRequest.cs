using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Zadanie wystawienia dokumentu MM (przesuniecie miedzymagazynowe) w GT
    public class MmRequest
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        // Symbole magazynow (K4/K4G/MAG/LS) - do logow/diagnostyki.
        [JsonPropertyName("magazyn_zrodlowy")]
        public string MagazynZrodlowy { get; set; } = "";

        [JsonPropertyName("magazyn_docelowy")]
        public string MagazynDocelowy { get; set; } = "";

        // Id magazynow GT (sl_Magazyn.mag_Id) - tym posluguje sie Sfera
        // (SuDokument.MagazynNadawczyId / MagazynOdbiorczyId). Node rozwiazuje
        // symbol -> id z sl_Magazyn (zob. config/magazyny.js).
        [JsonPropertyName("magazyn_zrodlowy_id")]
        public int MagazynZrodlowyId { get; set; }

        [JsonPropertyName("magazyn_docelowy_id")]
        public int MagazynDocelowyId { get; set; }

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; }

        [JsonPropertyName("operator")]
        public string? Operator { get; set; }
    }
}
