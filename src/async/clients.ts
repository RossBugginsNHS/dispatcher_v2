import { PutEventsCommand, EventBridgeClient } from "@aws-sdk/client-eventbridge";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

import type { CloudEvent } from "./cloudevents.js";

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

export async function publishCloudEvent(
  eb: EventBridgeClient,
  eventBusName: string,
  event: CloudEvent,
): Promise<void> {
  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          EventBusName: eventBusName,
          Source: event.source,
          DetailType: event.type,
          Time: new Date(event.time),
          Detail: JSON.stringify(event),
        },
      ],
    }),
  );
}
