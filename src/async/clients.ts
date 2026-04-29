import { PutEventsCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

export function createSqsClient(): SQSClient {
  return new SQSClient({});
}

export function createEventBridgeClient(): EventBridgeClient {
  return new EventBridgeClient({});
}

export async function enqueueJson(
  sqs: SQSClient,
  queueUrl: string,
  payload: unknown,
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(payload),
    }),
  );
}

export async function publishFact(
  eb: EventBridgeClient,
  eventBusName: string,
  detailType: string,
  detail: unknown,
): Promise<void> {
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBusName,
          Source: "dispatcher.v2",
          DetailType: detailType,
          Detail: JSON.stringify(detail),
        },
      ],
    }),
  );
}
