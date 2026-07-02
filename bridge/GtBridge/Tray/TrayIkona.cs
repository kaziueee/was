using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using GtBridge.Services;

namespace GtBridge.Tray
{
    // Ikona mostu przy zegarze (Faza C#9). Kolor = stan ostatniej operacji GT:
    //   szary = nieznany/start, zielony = ostatnie MM/test OK, czerwony = blad.
    // Menu (prawy klik): Testuj polaczenie / Restart / Pokaz log / Zamknij.
    // Konsola z logami zostaje - "Pokaz log" wywoluje ja na wierzch.
    public sealed class TrayIkona : ApplicationContext
    {
        private readonly StanMostu _stan;
        private readonly ISferaGtService _sfera;
        private readonly NotifyIcon _ikona;
        private readonly System.Windows.Forms.Timer _timer;
        private readonly Icon _zielona;
        private readonly Icon _czerwona;
        private readonly Icon _szara;

        // Ustawiane przez "Restart" - Program.Main po zamknieciu petli zatrzymuje host
        // (zwalnia port 5000) i dopiero wtedy uruchamia nowa instancje.
        public bool ZadanoRestart { get; private set; }

        [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
        [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
        private const int SW_RESTORE = 9;

        public TrayIkona(StanMostu stan, ISferaGtService sfera)
        {
            _stan = stan;
            _sfera = sfera;

            _zielona = Kropka(Color.FromArgb(34, 160, 60));
            _czerwona = Kropka(Color.FromArgb(200, 40, 40));
            _szara = Kropka(Color.FromArgb(150, 150, 150));

            var menu = new ContextMenuStrip();
            menu.Items.Add("Testuj polaczenie z GT", null, (_, _) => TestujPolaczenie());
            menu.Items.Add("Restart mostu", null, (_, _) => Restart());
            menu.Items.Add("Pokaz log (konsola)", null, (_, _) => PokazKonsole());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Zamknij most", null, (_, _) => Zamknij());

            _ikona = new NotifyIcon
            {
                Icon = _szara,
                Text = "Most WMS - start",
                Visible = true,
                ContextMenuStrip = menu,
            };
            _ikona.DoubleClick += (_, _) => PokazKonsole();

            _timer = new System.Windows.Forms.Timer { Interval = 2000 };
            _timer.Tick += (_, _) => Odswiez();
            _timer.Start();
            Odswiez();
        }

        // Odczyt stanu i aktualizacja ikony + dymka (Text ma limit ~63 znakow).
        private void Odswiez()
        {
            var (st, kom, czas) = _stan.Odczytaj();
            _ikona.Icon = st switch
            {
                StanPolaczenia.Ok => _zielona,
                StanPolaczenia.Blad => _czerwona,
                _ => _szara,
            };
            string godz = czas.HasValue ? czas.Value.ToString("HH:mm") : "-";
            string etykieta = st switch { StanPolaczenia.Ok => "OK", StanPolaczenia.Blad => "BLAD", _ => "..." };
            string tekst = $"Most WMS :5000 - {etykieta} {godz}\n{kom}";
            _ikona.Text = tekst.Length > 63 ? tekst.Substring(0, 62) + "…" : tekst;
        }

        private async void TestujPolaczenie()
        {
            _ikona.Text = "Most WMS - testuje polaczenie...";
            // Task.Run: sam test blokuje watek (czeka na watek STA Sfery) - nie blokujmy UI.
            var wynik = await Task.Run(() => _sfera.TestPolaczeniaAsync());
            Odswiez();
            _ikona.ShowBalloonTip(4000, "Most WMS",
                wynik.Sukces ? "Polaczenie z GT OK" : ("Blad: " + wynik.Blad),
                wynik.Sukces ? ToolTipIcon.Info : ToolTipIcon.Error);
        }

        private void Restart()
        {
            ZadanoRestart = true;
            Zamknij();
        }

        private void PokazKonsole()
        {
            var h = GetConsoleWindow();
            if (h != IntPtr.Zero)
            {
                ShowWindow(h, SW_RESTORE);
                SetForegroundWindow(h);
            }
        }

        private void Zamknij()
        {
            _timer.Stop();
            _ikona.Visible = false;
            ExitThread(); // konczy Application.Run -> Program.Main sprząta host (i ew. restart)
        }

        private static Icon Kropka(Color kolor)
        {
            using var bmp = new Bitmap(16, 16);
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using var pedzel = new SolidBrush(kolor);
                g.FillEllipse(pedzel, 2, 2, 11, 11);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _timer?.Dispose();
                if (_ikona != null) { _ikona.Visible = false; _ikona.Dispose(); }
                foreach (var ic in new[] { _zielona, _czerwona, _szara })
                {
                    if (ic == null) continue;
                    IntPtr h = ic.Handle;
                    ic.Dispose();
                    DestroyIcon(h); // Icon.FromHandle nie zwalnia HICON z GetHicon
                }
            }
            base.Dispose(disposing);
        }
    }
}
