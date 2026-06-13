namespace GtBridge.Services
{
    // Konfiguracja polaczenia z Subiekt GT przez Sfere - sekcja "Sfera" w appsettings.json
    public class SferaOptions
    {
        public const string Sekcja = "Sfera";

        // ProgID komponentu COM "InsERT GT dla aplikacji - Biblioteka obiektowa"
        // (do potwierdzenia na serwerze, np. przez OleView / rejestr HKCR)
        public string ProgId { get; set; } = "InsERT.Subiekt";

        public string Serwer { get; set; } = "";

        public string Baza { get; set; } = "";

        public string Operator { get; set; } = "";

        public string OperatorHaslo { get; set; } = "";
    }
}
