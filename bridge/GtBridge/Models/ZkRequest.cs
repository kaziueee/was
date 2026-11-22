using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace GtBridge.Models
{
    // Zamowienie od klienta (ZK) w GT przez Sfere - POST /api/zk. Woła scripts/zk-zaloz.js po
    // walidacjach w Node (kontrahent i towary istnieja, ceny z poziomu cen GT). Wzor: ZK hurtowe
    // K4ENERGY wystawiane recznie w Subiekcie (ZK 125854/2026: EUR, kurs NBP z dnia poprzedniego,
    // VAT "ue" 0%, magazyn K4, z rezerwacja).
    public class ZkRequest
    {
        // kh__Kontrahent.kh_Id - platnik i odbiorca (Sfera od 1.24 ustawia OdbiorcaId razem z KontrahentId).
        [JsonPropertyName("kontrahent_id")]
        public int KontrahentId { get; set; }

        // sl_Magazyn.mag_Id - magazyn dokumentu (dok_MagId). Sfera bierze go z biezacego magazynu
        // sesji (Subiekt.MagazynId), wiec most przestawia go na czas budowy i potem przywraca.
        [JsonPropertyName("magazyn_id")]
        public int MagazynId { get; set; }

        // Symbol waluty ("EUR"); puste / "PLN" = dokument w zlotych. Kurs pobiera Sfera wg parametrow
        // dokumentu (PobierzKursWalutyWgParametrow) - nie podajemy go recznie.
        [JsonPropertyName("waluta")]
        public string? Waluta { get; set; }

        // sl_StawkaVAT.vat_Id dla WSZYSTKICH pozycji (7 = "ue" 0%); null = stawka z kartoteki towaru.
        [JsonPropertyName("vat_id")]
        public int? VatId { get; set; }

        // true = ZK rezerwuje stany (tak jak reczne ZK hurtowe).
        [JsonPropertyName("rezerwacja")]
        public bool Rezerwacja { get; set; } = true;

        // Uwagi dokumentu - z kluczem "WMS-ZK:<klucz>", po ktorym skrypt sprawdza, czy takie ZK juz jest.
        [JsonPropertyName("uwagi")]
        public string? Uwagi { get; set; }

        [JsonPropertyName("pozycje")]
        public List<ZkPozycja> Pozycje { get; set; } = new();

        // true = zbuduj ZK w pamieci Subiekta, odczytaj kurs/ceny/VAT/sumy i zamknij BEZ zapisu.
        [JsonPropertyName("podglad")]
        public bool Podglad { get; set; }
    }

    public class ZkPozycja
    {
        [JsonPropertyName("tw_id")]
        public int TwId { get; set; }

        [JsonPropertyName("ilosc")]
        public decimal Ilosc { get; set; }

        // Cena netto przed rabatem w WALUCIE DOKUMENTU (np. Hurt EUR = tc_CenaNetto5).
        [JsonPropertyName("cena_netto")]
        public decimal CenaNetto { get; set; }
    }

    public class ZkResponse
    {
        [JsonPropertyName("sukces")]
        public bool Sukces { get; set; }

        [JsonPropertyName("podglad")]
        public bool Podglad { get; set; }

        // NumerPelny po zapisie (np. "ZK 125900/2026"); w podgladzie to, co Sfera ma przed zapisem.
        [JsonPropertyName("numer")]
        public string? Numer { get; set; }

        // Odczyt naglowka z obiektu Sfery PO ustawieniu pol - dowod, co Subiekt z tym zrobil.
        [JsonPropertyName("naglowek")]
        public Dictionary<string, object?> Naglowek { get; set; } = new();

        [JsonPropertyName("pozycje")]
        public List<Dictionary<string, object?>> Pozycje { get; set; } = new();

        [JsonPropertyName("blad")]
        public string? Blad { get; set; }

        [JsonPropertyName("rodzaj")]
        public string? Rodzaj { get; set; }
    }
}
