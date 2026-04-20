import { Kafka, type Producer } from "kafkajs";
import type { KafkaDocumentEvent } from "@direze/shared";

const TOPIC = "raw-docs";

export interface PublishContext {
  requestId?: string;
}

export class KafkaProducer {
  private kafka: Kafka;
  private producer: Producer;

  constructor(brokers: string) {
    this.kafka = new Kafka({
      clientId: "direze-api",
      brokers: brokers.split(",").map((b) => b.trim()),
    });
    this.producer = this.kafka.producer();
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async publishDocumentEvent(
    event: KafkaDocumentEvent,
    ctx?: PublishContext
  ): Promise<void> {
    // Correlation IDs travel in Kafka headers, not in the event body, so they
    // don't pollute the domain schema. The consumer reads them on entry and
    // threads them into its logger.
    const headers: Record<string, string> = {};
    if (ctx?.requestId) headers["x-request-id"] = ctx.requestId;
    if (event.userId) headers["x-user-id"] = event.userId;

    await this.producer.send({
      topic: TOPIC,
      messages: [
        {
          key: event.documentId,
          value: JSON.stringify(event),
          headers,
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
