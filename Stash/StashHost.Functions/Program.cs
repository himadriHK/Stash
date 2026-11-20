using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using StashHost.Functions;
using StashHost.Functions.Activities;
using StashHost.Functions.Middleware;
using StashHost.Shared.Services;

var host = new HostBuilder()
    .ConfigureFunctionsWorkerDefaults()
    .ConfigureServices((context, services) =>
    {
        var configuration = context.Configuration;

        // Register storage infrastructure
        services.AddStorageInfrastructure(configuration);

        // Register JWT validator
        var signingKey = configuration["Auth:Jwt:SigningKey"] ?? throw new InvalidOperationException("Auth:Jwt:SigningKey is not configured");
        var issuer = configuration["Auth:Jwt:Issuer"] ?? "stash-auth";
        var audience = configuration["Auth:Jwt:Audience"] ?? "stash-app";
        services.AddSingleton<IJwtValidator>(sp => new JwtValidator(signingKey, issuer, audience));
    })
    .Build();

host.Run();
