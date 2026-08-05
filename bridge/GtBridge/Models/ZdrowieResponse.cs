using System;
using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Odpowiedz GET /api/zdrowie - obraz stanu mostu BEZ dotykania Sfery (zob. GtController).
    // Czyta to routes/status.js w WMS: "zyje" mowi, ze proces odpowiada, a "sfera" - jak
    // skonczyla sie OSTATNIA realna operacja. Rozdzial jest tu sednem: przy zawieszonej Sferze
    // proces zyje i odpowiada, wiec samo "odpowiada na HTTP" nie znaczy "most dziala".
    public class ZdrowieResponse
    {
        [JsonPropertyName("zyje")]
        public bool Zyje { get; set; }

        // "ok" | "blad" | "nieznany" (nieznany = od startu procesu nie bylo zadnej operacji)
        [JsonPropertyName("sfera")]
        public string Sfera { get; set; } = "nieznany";

        // Komunikat ostatniej operacji (np. "MM 1634/2026" albo tresc bledu Sfery)
        [JsonPropertyName("komunikat")]
        public string Komunikat { get; set; } = "";

        [JsonPropertyName("czas")]
        public DateTime? Czas { get; set; }

        // Niepuste = watek STA JEST w trakcie wywolania od tego czasu. Dlugo niepuste = wisi.
        [JsonPropertyName("zajety_od")]
        public DateTime? ZajetyOd { get; set; }

        [JsonPropertyName("operacja")]
        public string? Operacja { get; set; }

        // Ile zadan czeka na watek STA (rosnie, gdy biezace wywolanie sie nie konczy)
        [JsonPropertyName("w_kolejce")]
        public int WKolejce { get; set; }

        [JsonPropertyName("start_procesu")]
        public DateTime StartProcesu { get; set; }
    }
}
