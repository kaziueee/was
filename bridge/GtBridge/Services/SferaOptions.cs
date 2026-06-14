namespace GtBridge.Services
{
    // Konfiguracja polaczenia z Subiekt GT przez Sfere - sekcja "Sfera" w appsettings.json.
    // Hasla podajemy JAWNIE - Sfera wymaga ich w postaci zaszyfrowanej, ale szyfrowanie
    // robimy w runtime przez InsERT.Dodatki.Szyfruj (zob. SferaGtService.Polacz).
    public class SferaOptions
    {
        public const string Sekcja = "Sfera";

        // ProgID "launchera" Sfery (obiekt GT). Tworzy obiekty Aplikacja/Subiekt.
        // Zob. gta.chm > obiekt GT. NIE jest to "InsERT.Subiekt".
        public string ProgId { get; set; } = "InsERT.GT";

        // Instancja SQL Server z baza GT, np. "SERWER\\InsERTGT" albo "192.168.0.200,49951".
        public string Serwer { get; set; } = "";

        // Nazwa bazy (podmiotu) GT, np. "Z_KAJTEK_IdeaERP".
        public string Baza { get; set; } = "";

        // Uzytkownik SQL Servera (autentykacja mieszana), np. "sa".
        public string Uzytkownik { get; set; } = "sa";

        // Haslo uzytkownika SQL (jawne - szyfrowane w runtime).
        public string UzytkownikHaslo { get; set; } = "";

        // Operator (uzytkownik) GT, np. "Szef".
        public string Operator { get; set; } = "";

        // Haslo operatora GT (jawne - szyfrowane w runtime). Puste = operator bez hasla.
        public string OperatorHaslo { get; set; } = "";
    }
}
