using System;
using System.Security.Cryptography;
using System.Text;

namespace GtBridge.Services
{
    // Hasla Sfery zaszyfrowane DPAPI w appsettings.json (pola *HasloDpapi, base64). Ten sam
    // mechanizm, zakres i entropia co config/sekrety.js po stronie Node - wpisuje je
    // `node scripts/sekrety.js most`. Zakres MASZYNY: appsettings przeniesiony na inny komputer
    // (kopia, mail, commit) nie da sie odszyfrowac. Przed innymi kontami na tym serwerze chroni
    // ACL pliku. Patrz CLAUDE.md "Sekrety".
    public static class Sekrety
    {
        private static readonly byte[] Entropia = Encoding.UTF8.GetBytes("WMS-sekrety-v1");

        // Zaszyfrowane wygrywa z jawnym; puste zaszyfrowane = stary appsettings, bierzemy jawne.
        public static string Haslo(string? jawne, string? dpapi)
        {
            if (string.IsNullOrWhiteSpace(dpapi))
            {
                return jawne ?? "";
            }
            var bajty = ProtectedData.Unprotect(Convert.FromBase64String(dpapi.Trim()), Entropia, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(bajty);
        }
    }
}
