using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;
using Microsoft.Extensions.Logging;
using System.Net;

namespace StashHost.Functions.Functions;

/// <summary>
/// Health check function that returns the health status of the StashHost backend.
/// </summary>
public class HealthCheckFunction
{
    [Function(nameof(HealthCheckFunction))]
    public static async Task<HttpResponseData> Run(
        [HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = "health")] HttpRequestData req,
        FunctionContext executionContext)
    {
        var response = req.CreateResponse(HttpStatusCode.OK);
        response.Headers.Add("Content-Type", "application/json");
        await response.WriteStringAsync("{\"status\":\"healthy\",\"timestamp\":\"" + DateTime.UtcNow + "\"}");
        return response;
    }
}
