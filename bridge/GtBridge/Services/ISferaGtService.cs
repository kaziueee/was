using System.Collections.Generic;
using System.Threading.Tasks;
using GtBridge.Models;

namespace GtBridge.Services
{
    // Operacje na Subiekcie GT przez Sfere - implementowane przez SferaGtService (COM)
    // lub MockSferaGtService (lokalny development bez dostepu do Sfery)
    public interface ISferaGtService
    {
        Task<DokumentResponse> WystawMmAsync(MmRequest request);

        Task<DokumentResponse> ZapiszLokalizacjeAsync(LokRequest request);

        Task<List<StanPozycja>> PobierzStanyAsync(string magazynId);

        Task<ArtykulInfo?> PobierzArtykulAsync(string artykulGtId);

        Task<DokumentResponse> WystawRwAsync(InwentaryzacjaDokumentRequest request);

        Task<DokumentResponse> WystawPwAsync(InwentaryzacjaDokumentRequest request);

        // Lekki test polaczenia z GT (dla przycisku "Testuj polaczenie" w ikonie trayu):
        // loguje sie do Sfery (Polacz) i nic nie wystawia. Nie rzuca - zwraca Sukces/Blad.
        Task<DokumentResponse> TestPolaczeniaAsync();
    }
}
