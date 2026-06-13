using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Zadanie aktualizacji pol wlasnych artykulu (lokalizacje WMS) w kartotece GT.
    // Brak pola = nie zmieniaj (null != "" - puste oznacza wyczysc pole).
    //
    // Mapowanie na kolumny w bazie GT (potwierdzone na danych Z_KAJTEK_IdeaERP):
    //   MiejsceNaMagazynie -> tw__Towar.tw_Pole1   (standardowe pole dodatkowe, varchar(50))
    //   LokalizacjaGorna   -> tw__Towar.tw_Pole8   (standardowe pole dodatkowe, varchar(50))
    //   LokalizacjaZapas   -> vwPolaWlasne_Towar.pwd_Tekst09 (dynamiczne pole wlasne, wolne)
    public class LokRequest
    {
        [JsonPropertyName("artykul_gt_id")]
        public string ArtykulGtId { get; set; } = "";

        [JsonPropertyName("miejsce_na_magazynie")]
        public string? MiejsceNaMagazynie { get; set; }

        [JsonPropertyName("lokalizacja_gorna")]
        public string? LokalizacjaGorna { get; set; }

        [JsonPropertyName("lokalizacja_zapas")]
        public string? LokalizacjaZapas { get; set; }
    }
}
