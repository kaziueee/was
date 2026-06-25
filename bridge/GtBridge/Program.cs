using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;

namespace GtBridge
{
    public class Program
    {
        public static void Main(string[] args)
        {
            CreateHostBuilder(args).Build().Run();
        }

        public static IHostBuilder CreateHostBuilder(string[] args) =>
            Host.CreateDefaultBuilder(args)
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    // 0.0.0.0 - dostepny tez z sieci lokalnej (Mac dev); na prod localhost wystarczy
                    webBuilder.UseUrls("http://0.0.0.0:5000");
                    webBuilder.UseStartup<Startup>();
                });
    }
}
