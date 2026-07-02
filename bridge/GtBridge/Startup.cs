using GtBridge.Services;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace GtBridge
{
    public class Startup
    {
        public Startup(IConfiguration configuration, IWebHostEnvironment env)
        {
            Configuration = configuration;
            Srodowisko = env;
        }

        public IConfiguration Configuration { get; }
        public IWebHostEnvironment Srodowisko { get; }

        public void ConfigureServices(IServiceCollection services)
        {
            services.Configure<SferaOptions>(Configuration.GetSection(SferaOptions.Sekcja));

            // Wspoldzielony stan mostu dla ikony w trayu (aktualizowany przez SferaGtService).
            services.AddSingleton<StanMostu>();

            // Mock w developmencie (Mac, bez Sfery) lub gdy wymuszony przez
            // konfiguracje (Sfera:UzyjMock=true). Na serwerze Windows z GT+Sfera
            // (Production - domyslne srodowisko) wchodzi prawdziwy SferaGtService.
            bool uzyjMock = Srodowisko.IsDevelopment()
                || Configuration.GetValue<bool>($"{SferaOptions.Sekcja}:UzyjMock");
            if (uzyjMock)
            {
                services.AddSingleton<ISferaGtService, MockSferaGtService>();
            }
            else
            {
                services.AddSingleton<ISferaGtService, SferaGtService>();
            }

            services.AddControllers();
        }

        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            if (env.IsDevelopment())
            {
                app.UseDeveloperExceptionPage();
            }

            app.UseRouting();

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllers();
            });
        }
    }
}
