import { Kafka, type Producer } from "kafkajs";

const DLQ_TOPIC = "raw-docs-dlq";

export class DeadLetterQueue {
  private producer: Producer;

  constructor(kafka: Kafka) {
    this.producer = kafka.producer();
  }

  async connect(): Promise<void> {
    await this.producer.connect();
  }

  async send(
    originalMessage: {
      key?: string | null;
      value: string;
      topic: string;
      partition: number;
      offset: string;
    },
    error: Error
  ): Promise<void> {
    await this.producer.send({
      topic: DLQ_TOPIC,
      messages: [
        {
          key: originalMessage.key ?? undefined,
          value: JSON.stringify({
            originalTopic: originalMessage.topic,
            originalPartition: originalMessage.partition,
            originalOffset: originalMessage.offset,
            payload: originalMessage.value,
            error: error.message,
            stack: error.stack,
            failedAt: new Date().toISOString(),
          }),
        },
      ],
    });
  }

  async disconnect(): Promise<void> {
    await this.producer.disconnect();
  }
}
