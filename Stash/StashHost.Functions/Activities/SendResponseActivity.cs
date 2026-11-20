using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;
using StashHost.Shared.Contracts;
using StashHost.Shared.Messages;

namespace StashHost.Functions.Activities;

/// <summary>
/// Activity function that publishes the upload response to Kafka (stash.upload.response topic).
/// </summary>
public class SendResponseActivity
{
    private readonly IKafkaProducer _kafkaProducer;

    public SendResponseActivity(IKafkaProducer kafkaProducer)
    {
        _kafkaProducer = kafkaProducer;
    }

    [Function(nameof(SendResponseActivity))]
    public async Task<ActivityResult> Run(
        [ActivityTrigger] UploadResponseMessage response,
        ILogger log)
    {
        await _kafkaProducer.ProduceUploadResponseAsync(response, CancellationToken.None);
        return ActivityResult.Success();
    }
}
