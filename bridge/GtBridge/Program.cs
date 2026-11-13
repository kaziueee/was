using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using GtBridge.Services;
using GtBridge.Tray;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace GtBridge
{
    public class Program
    {
        // STAThread wymagany przez WinForms (NotifyIcon). Web-host startuje nieblokujaco,
        // a watek glowny prowadzi petle komunikatow ikony w trayu.
        [STAThread]
        public static void Main(string[] args)
        {
            Dziennik.Rotuj();
            Dziennik.Zapisz("proces", $"START mostu, pid={Environment.ProcessId}, exe={Environment.ProcessPath}");

            var host = CreateHostBuilder(args).Build();
            host.Start(); // uruchamia Kestrel (nasluch :5000) i wraca - nie blokuje
            Dziennik.Zapisz("proces", "Kestrel wystartowal");

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var stan = host.Services.GetRequiredService<StanMostu>();
            var sfera = host.Services.GetRequiredService<ISferaGtService>();

            // Test polaczenia PRZY STARCIE (zyczenie usera 2026-08-05): bez niego most po restarcie
            // raportuje sfera="nieznany" az do pierwszego MM, wiec przez pol dnia nikt nie wie, czy
            // Sfera w ogole odpowiada - a to jest jedyna rzecz, ktora ten most robi.
            //
            // W tle (Task.Run), zeby nie opoznial startu Kestrela ani ikony w trayu. Gdy sie nie uda
            // (GT wstaje wolniej niz most, baza chwilowo niedostepna), ponawiamy co 5 minut az do
            // pierwszego sukcesu - inaczej czerwona kropka zostalaby na caly dzien mimo sprawnej
            // Sfery. Ponowienie POMIJAMY, gdy watek STA jest czyms zajety: przy zawieszonym
            // wywolaniu COM dokladanie zadan tylko wydluzaloby kolejke (widac ja w /api/zdrowie).
            _ = Task.Run(async () =>
            {
                while (true)
                {
                    var (_, _, _, zajetyOd, _, _) = stan.OdczytajPelny();
                    if (zajetyOd == null)
                    {
                        var wynik = await sfera.TestPolaczeniaAsync();   // sam loguje i ustawia StanMostu
                        if (wynik.Sukces) return;
                    }
                    else
                    {
                        Dziennik.Zapisz("test", $"Pomijam test startowy - watek STA zajety od {zajetyOd:HH:mm:ss}");
                    }
                    await Task.Delay(TimeSpan.FromMinutes(5));
                }
            });

            bool restart;
            using (var tray = new TrayIkona(stan, sfera))
            {
                Application.Run(tray); // do "Zamknij"/"Restart" z menu ikony
                restart = tray.ZadanoRestart;
            }

            // Zatrzymaj host PRZED ewentualnym restartem - zwalnia port 5000, zamyka Sfere
            // (SferaGtService.Dispose przez kontener DI), zeby nowa instancja mogla wystartowac.
            Dziennik.Zapisz("proces", restart ? "Zadano RESTART z traya - zatrzymuje host" : "Zamykanie mostu - zatrzymuje host");

            // Straznik zamykania (2026-11-13): zamkniecie sesji Sfery to wywolanie COM, ktorego nie da
            // sie przerwac. 12.11 restart z traya zawisl na "Zamykam sesje Sfery" po crashu Subiekta
            // mostu: proces zyl, portu 5000 juz nie bylo, a nowa instancja nigdy nie wstala - most
            // lezal 1,5 h do recznego ubicia. Po 20 s sprzatamy sami i konczymy proces twardo.
            using var zamkniete = new ManualResetEventSlim(false);
            var straznikZamykania = new Thread(() =>
            {
                if (zamkniete.Wait(TimeSpan.FromSeconds(20))) return;
                Dziennik.Zapisz("proces", "Zamykanie wisi > 20 s - ubijam Subiekta mostu i koncze proces twardo");
                ProcesySubiekta.UbijDzieci("zamykanie wisi");
                if (restart) UruchomNowaInstancje(zOpoznieniem: true);
                Dziennik.Zapisz("proces", "Twarde zakonczenie procesu");
                Process.GetCurrentProcess().Kill();
            }) { IsBackground = true, Name = "StraznikZamykania" };
            straznikZamykania.Start();

            host.StopAsync().GetAwaiter().GetResult();
            host.Dispose();
            zamkniete.Set();
            Dziennik.Zapisz("proces", "Host zatrzymany");

            if (restart) UruchomNowaInstancje(zOpoznieniem: false);
        }

        // Nowa instancja mostu po restarcie z traya. Z opoznieniem (sciezka twardego zakonczenia):
        // stary proces jeszcze zyje w chwili startu, a nowy musi zajac port 5000 - wiec cmd czeka
        // ~3 s, w tym czasie stary proces sie zabija.
        private static void UruchomNowaInstancje(bool zOpoznieniem)
        {
            var exe = Environment.ProcessPath;
            if (string.IsNullOrEmpty(exe)) return;
            Dziennik.Zapisz("proces", $"Uruchamiam nowa instancje{(zOpoznieniem ? " (za 3 s)" : "")}: {exe}");
            var start = zOpoznieniem
                ? new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = $"/c ping -n 4 127.0.0.1 >nul & start \"\" \"{exe}\"",
                    WorkingDirectory = Environment.CurrentDirectory, // appsettings.json z CWD!
                    UseShellExecute = false,
                    CreateNoWindow = true,
                }
                : new ProcessStartInfo
                {
                    FileName = exe,
                    WorkingDirectory = Environment.CurrentDirectory, // appsettings.json z CWD!
                    UseShellExecute = true,
                };
            Process.Start(start);
        }

        public static IHostBuilder CreateHostBuilder(string[] args)
        {
            // Adres nasluchu Kestrela z appsettings ("Nasluch"). Domyslnie 0.0.0.0:5000 (dev,
            // dostep z LAN). Na prod: "http://127.0.0.1:5000" - most wola TYLKO lokalny Node
            // (ta sama maszyna), wiec nie musi byc widoczny w sieci. Czytamy z appsettings obok
            // exe (publish) i z CWD - spojnie z reszta konfiguracji (zrodlo pozniejsze wygrywa).
            var wstepnaCfg = new ConfigurationBuilder()
                .AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"), optional: true)
                .AddJsonFile(Path.Combine(Directory.GetCurrentDirectory(), "appsettings.json"), optional: true)
                .Build();
            var nasluch = wstepnaCfg["Nasluch"];
            if (string.IsNullOrWhiteSpace(nasluch)) nasluch = "http://0.0.0.0:5000";

            return Host.CreateDefaultBuilder(args)
                .ConfigureAppConfiguration((ctx, cfg) =>
                {
                    // Wczytaj appsettings.json TAKZE z katalogu .exe (publish), nie tylko z CWD.
                    // Dzieki temu most znajduje haslo/konfiguracje niezaleznie od sposobu startu
                    // (dwuklik, skrot w Autostarcie, Harmonogram zadan) - kluczowe dla autostartu,
                    // bo tam katalog roboczy bywa inny niz folder exe. Zrodlo dodane pozniej => wygrywa.
                    cfg.AddJsonFile(Path.Combine(AppContext.BaseDirectory, "appsettings.json"),
                        optional: true, reloadOnChange: false);
                })
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseUrls(nasluch);
                    webBuilder.UseStartup<Startup>();
                });
        }
    }
}
