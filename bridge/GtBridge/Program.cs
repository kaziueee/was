using System;
using System.Diagnostics;
using System.IO;
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
            host.StopAsync().GetAwaiter().GetResult();
            host.Dispose();
            Dziennik.Zapisz("proces", "Host zatrzymany");

            if (restart)
            {
                var exe = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exe))
                {
                    Dziennik.Zapisz("proces", $"Uruchamiam nowa instancje: {exe}");
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = exe,
                        WorkingDirectory = Environment.CurrentDirectory, // appsettings.json z CWD!
                        UseShellExecute = true,
                    });
                }
            }
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
