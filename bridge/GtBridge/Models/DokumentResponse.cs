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

        // Rodzaj bledu: "biznesowy" = Sfera odpowiedziala merytorycznie i odmowila (brak towaru
        // na magazynie zrodlowym) - dokument nie powstal, ale GT dziala normalnie. "techniczny" =
        // Sfera/COM sie wywrocilo (blad zapisu, licencja, zawieszona sesja).
        //
        // Rozdzial jest po to, zeby kropka "Most" w WMS nie swiecila na czerwono z powodu odmowy
        // biznesowej. Kropka odpowiada na pytanie "czy MM przejdzie" - przy braku towaru MM innych
        // towarow przechodza bez problemu, wiec czerwien byla falszywym alarmem (incydent
        // NERG0319, 2026-08-28: 17 kolejnych "Brak towaru" trzymalo alarm przez pol dnia).
        // Czyta to services/ruchy-kolejka.js po stronie Node. Null przy sukcesie.
        [JsonPropertyName("rodzaj")]
        public string? Rodzaj { get; set; }
    }
}
