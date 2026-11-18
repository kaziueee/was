using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Zadanie zalozenia nowego kompletu (towar rodzaj 8) w GT przez Sfere - POST /api/komplet.
    // Walidacje biznesowe (symbol/EAN wolny, skladniki istnieja, cyfra kontrolna EAN) robi Node
    // (scripts/zestaw-zaloz.js) PRZED wywolaniem mostu; most sprawdza jeszcze raz symbol
    // (Towary.Istnieje), bo to jedyna rzecz, ktorej dubel Sfera moglaby przepuscic po cichu.
    public class KompletRequest
    {
        [JsonPropertyName("symbol")]
        public string Symbol { get; set; } = "";

        // tw_Nazwa ma 50 znakow - dluzsza nazwa = odmowa (nie ucinamy po cichu).
        [JsonPropertyName("nazwa")]
        public string Nazwa { get; set; } = "";

        // sl_GrupaTw.grt_Id; null = domyslna grupa Subiekta.
        [JsonPropertyName("grupa_id")]
        public int? GrupaId { get; set; }

        // Podstawowy kod kreskowy (EAN z puli firmy). Puste = bez kodu.
        [JsonPropertyName("ean")]
        public string? Ean { get; set; }

        // tw_SklepInternet - "do sprzedazy w sklepie internetowym".
        [JsonPropertyName("sklep_internetowy")]
        public bool SklepInternetowy { get; set; }

        [JsonPropertyName("skladniki")]
        public List<KompletSkladnik> Skladniki { get; set; } = new();

        // Cena kartotekowa = tc_CenaNetto0 (koszt). Istniejace komplety maja tu sume kosztow
        // skladnikow x ilosc (NERG1132Z4: 42,25), a Sfera sama jej nie liczy (test Z_KAJTEK
        // 2026-11-18: 0). Ustawiana PRZED cenami sprzedazy - na nowym towarze przelicza wszystkie
        // poziomy wg narzutow, wiec dopiero potem nadpisujemy je cenami z zadania.
        [JsonPropertyName("cena_kartotekowa")]
        public decimal? CenaKartotekowa { get; set; }

        // Ceny sprzedazy per poziom (1..10 jak w tw_Cena). Na pozycji podajemy brutto ALBO netto.
        // Mapowanie potwierdzone podgladem 2026-11-18: Ceny.Element(i) = poziom i
        // (1 Detaliczna PLN, 2 Emag_RO RON, 3 Specjalna PLN = sklep, 4 EUR, 5 Hurt EUR).
        [JsonPropertyName("ceny")]
        public List<KompletCena> Ceny { get; set; } = new();

        // Rozszerzone pola wlasne po NAZWIE z pw_Pole (np. "Wymiary", "Waga produktu").
        [JsonPropertyName("pola_wlasne")]
        public Dictionary<string, string> PolaWlasne { get; set; } = new();

        // true = zbuduj komplet w pamieci Subiekta, odczytaj z powrotem ceny/sklad i ZAMKNIJ BEZ
        // ZAPISU. Do sprawdzenia mapowania poziomow cen i domyslnych wartosci, zanim cokolwiek
        // trafi do bazy (zasada usera: nie zgadujemy, jak dziala GT).
        [JsonPropertyName("podglad")]
        public bool Podglad { get; set; }
    }

    public class KompletSkladnik
    {
        // tw__Towar.tw_Id skladnika
        [JsonPropertyName("tw_id")]
        public int TwId { get; set; }

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; } = 1;
    }

    public class KompletCena
    {
        [JsonPropertyName("poziom")]
        public int Poziom { get; set; }

        [JsonPropertyName("brutto")]
        public decimal? Brutto { get; set; }

        [JsonPropertyName("netto")]
        public decimal? Netto { get; set; }
    }

    public class KompletResponse
    {
        [JsonPropertyName("sukces")]
        public bool Sukces { get; set; }

        // tw_Id zalozonego kompletu (null w trybie podgladu i przy bledzie)
        [JsonPropertyName("tw_id")]
        public int? TwId { get; set; }

        [JsonPropertyName("podglad")]
        public bool Podglad { get; set; }

        // Odczyt z obiektu Sfery PO ustawieniu pol - dowod, co Subiekt z tym zrobil.
        [JsonPropertyName("ceny")]
        public List<Dictionary<string, object?>> Ceny { get; set; } = new();

        [JsonPropertyName("skladniki")]
        public List<Dictionary<string, object?>> Skladniki { get; set; } = new();

        [JsonPropertyName("pola")]
        public Dictionary<string, object?> Pola { get; set; } = new();

        [JsonPropertyName("blad")]
        public string? Blad { get; set; }

        // "biznesowy" (dane nie przeszly - np. symbol zajety) / "techniczny" - jak DokumentResponse.
        [JsonPropertyName("rodzaj")]
        public string? Rodzaj { get; set; }
    }
}
