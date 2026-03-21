import { Kafka, type Producer } from "kafkajs";
import type { KafkaDocumentEvent } from "@direze/shared";

const TOPIC = "raw-docs";

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

  async publishDocumentEvent(event: KafkaDocumentEvent): Promise<void> {
    await this.producer.send({
      topic: TOPIC,
      messages: [
        {
          key: event.documentId,
          value: JSON.stringify(event),
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
