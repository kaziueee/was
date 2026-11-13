using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Diagnostics.Eventing.Reader;
using System.Globalization;
using System.Runtime.InteropServices;

namespace GtBridge.Services
{
    // Ukryty Subiekt.exe, ktorego most uruchamia przez Sfere (gt.Uruchom ... gtaUruchomWTle), jest
    // procesem-DZIECKIEM mostu (ParentProcessId = pid GtBridge, sprawdzone na SRV 2026-11-12).
    // Po tym go rozpoznajemy - nigdy po nazwie: na SRV chodzi kilkanascie Subiektow pracownikow
    // i lacznika Fenom, ktorych most nie ma prawa dotknac.
    //
    // POWOD ISTNIENIA (2026-11-13): Subiekt mostu sam pada co 1-2 tygodnie (7 razy od 25.09,
    // `combase.dll` / `ntdll.dll` / `ucrtbase.dll`, Application Error 1000 - blad po stronie
    // Subiekta, Subiekty pracownikow padaja tak samo). Proces po crashu potrafi WISIEC na liscie
    // procesow, a most trzymal do niego martwe polaczenie COM: kazde MM konczylo sie
    // RPC_E_DISCONNECTED / RPC_S_SERVER_UNAVAILABLE az do recznego restartu (12.11: 6:14 -> 7:38).
    // Restart z traya w tym stanie wisial na zamykaniu sesji, a ubity most zostawial Subiekta-sierote.
    public static class ProcesySubiekta
    {
        private const string NazwaExe = "Subiekt.exe";

        // Pid-y procesow Subiekt.exe, ktorych rodzicem jest ten proces (most).
        public static List<int> Dzieci()
        {
            int ja = Environment.ProcessId;
            var wynik = new List<int>();
            foreach (var (pid, rodzic, nazwa) in Migawka())
            {
                if (rodzic == ja && string.Equals(nazwa, NazwaExe, StringComparison.OrdinalIgnoreCase))
                    wynik.Add(pid);
            }
            return wynik;
        }

        // Ubija Subiekty uruchomione przez most. Nie rzuca - to sprzatanie, ma sie udac albo
        // przynajmniej nie przeszkodzic temu, co dzieje sie dalej (logowanie od nowa, restart).
        public static void UbijDzieci(string powod)
        {
            List<int> dzieci;
            try { dzieci = Dzieci(); }
            catch (Exception ex)
            {
                Dziennik.Zapisz("proces", $"Nie umiem wyliczyc Subiektow mostu ({powod}): {ex.Message}");
                return;
            }
            foreach (var pid in dzieci)
            {
                try
                {
                    using var p = Process.GetProcessById(pid);
                    p.Kill();
                    p.WaitForExit(5000);
                    Dziennik.Zapisz("proces", $"Ubity Subiekt mostu pid={pid} ({powod})");
                }
                catch (Exception ex)
                {
                    Dziennik.Zapisz("proces", $"Nie udalo sie ubic Subiekta mostu pid={pid} ({powod}): {ex.Message}");
                }
            }
        }

        // Czy Windows zapisal awarie (Application Error 1000) dla Subiekta o tym pid-zie w ostatnich
        // `okno`. Porownujemy tez czas startu procesu z tego wpisu (pole 9, FILETIME), zeby stary
        // wpis o innym procesie z tym samym, ponownie uzytym pid-em nie ubil zdrowego Subiekta.
        // Indeksy pol wpisu 1000 (0 = nazwa aplikacji, 8 = pid hex, 9 = start hex) - te same,
        // ktore czytalem na SRV przy diagnozie; nie zaleza od jezyka systemu (to dane, nie tresc).
        public static bool PadlWedlugDziennika(int pid, DateTime startProcesu, TimeSpan okno)
        {
            string xpath = "*[System[Provider[@Name='Application Error'] and (EventID=1000) and " +
                           $"TimeCreated[timediff(@SystemTime) <= {(long)okno.TotalMilliseconds}]]]";
            using var czytnik = new EventLogReader(new EventLogQuery("Application", PathType.LogName, xpath));
            for (EventRecord? wpis = czytnik.ReadEvent(); wpis != null; wpis = czytnik.ReadEvent())
            {
                using (wpis)
                {
                    var p = wpis.Properties;
                    if (p.Count < 10) continue;
                    if (!string.Equals(p[0].Value as string, NazwaExe, StringComparison.OrdinalIgnoreCase)) continue;
                    if (ParsujHex(p[8].Value as string) != pid) continue;
                    long? start = ParsujHex(p[9].Value as string);
                    if (start == null) continue;
                    var startWpisu = DateTime.FromFileTime(start.Value);
                    if (Math.Abs((startWpisu - startProcesu).TotalSeconds) > 2) continue;
                    return true;
                }
            }
            return false;
        }

        private static long? ParsujHex(string? s)
        {
            if (string.IsNullOrWhiteSpace(s)) return null;
            s = s.Trim();
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) s = s.Substring(2);
            return long.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var v) ? v : null;
        }

        // Lista procesow z pid-em rodzica (Toolhelp32). .NET nie ma ParentProcessId, a WMI
        // (System.Management) to dodatkowa paczka dla jednego pola.
        private static IEnumerable<(int Pid, int Rodzic, string Nazwa)> Migawka()
        {
            var wynik = new List<(int, int, string)>();
            IntPtr migawka = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (migawka == INVALID_HANDLE_VALUE) throw new Win32Exception(Marshal.GetLastWin32Error());
            try
            {
                var wpis = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32>() };
                if (!Process32First(migawka, ref wpis)) return wynik;
                do
                {
                    wynik.Add(((int)wpis.th32ProcessID, (int)wpis.th32ParentProcessID, wpis.szExeFile));
                } while (Process32Next(migawka, ref wpis));
            }
            finally { CloseHandle(migawka); }
            return wynik;
        }

        private const uint TH32CS_SNAPPROCESS = 0x00000002;
        private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
        private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
        private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);
    }
}
