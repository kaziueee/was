using System;
using System.Diagnostics;
using System.IO;
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
            var host = CreateHostBuilder(args).Build();
            host.Start(); // uruchamia Kestrel (nasluch :5000) i wraca - nie blokuje

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var stan = host.Services.GetRequiredService<StanMostu>();
            var sfera = host.Services.GetRequiredService<ISferaGtService>();

            bool restart;
            using (var tray = new TrayIkona(stan, sfera))
            {
                Application.Run(tray); // do "Zamknij"/"Restart" z menu ikony
                restart = tray.ZadanoRestart;
            }

            // Zatrzymaj host PRZED ewentualnym restartem - zwalnia port 5000, zamyka Sfere
            // (SferaGtService.Dispose przez kontener DI), zeby nowa instancja mogla wystartowac.
            host.StopAsync().GetAwaiter().GetResult();
            host.Dispose();

            if (restart)
            {
                var exe = Environment.ProcessPath;
                if (!string.IsNullOrEmpty(exe))
                {
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
