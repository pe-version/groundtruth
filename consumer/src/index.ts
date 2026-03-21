import { Kafka, type EachMessagePayload } from "kafkajs";
import {
  loadConsumerConfig,
  MongoDB,
  VectorStore,
  DocumentStatus,
  type KafkaDocumentEvent,
} from "@direze/shared";
import { processDocument } from "./processor.js";
import { DeadLetterQueue } from "./dlq.js";

const MAX_RETRIES = 3;

async function main() {
  const config = loadConsumerConfig();

  const db = await MongoDB.connect(config.MONGO_URI);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);

  const kafka = new Kafka({
    clientId: "direze-consumer",
    brokers: config.KAFKA_BROKERS.split(",").map((b) => b.trim()),
  });

  const consumer = kafka.consumer({ groupId: config.KAFKA_GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topic: "raw-docs", fromBeginning: false });

  const dlq = new DeadLetterQueue(kafka);
  await dlq.connect();

  // Track retry counts per document
  const retryCounts = new Map<string, number>();

  console.log("Consumer started, waiting for messages...");

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({
      message,
      partition,
      topic,
      heartbeat,
    }: EachMessagePayload) => {
      const value = message.value?.toString();
      if (!value) {
        console.warn("Empty message received, skipping");
        await commitOffset(consumer, topic, partition, message.offset);
        return;
      }

      let event: KafkaDocumentEvent;
      try {
        event = JSON.parse(value);
      } catch (err) {
        console.error("Could not parse message:", err, "— sending to DLQ");
        await dlq.send(
          { key: message.key?.toString(), value, topic, partition, offset: message.offset },
          err instanceof Error ? err : new Error(String(err))
        );
        await commitOffset(consumer, topic, partition, message.offset);
        return;
      }

      console.log(
        `Processing document ${event.documentId} (${event.filename})`
      );
      await db.updateStatus(event.documentId, DocumentStatus.Processing, 0);

      try {
        await heartbeat();
        const chunkCount = await processDocument(event, db, vectorStore);
        await db.updateStatus(
          event.documentId,
          DocumentStatus.Ready,
          chunkCount
        );
        console.log(
          `Done: ${event.documentId} — ${chunkCount} chunks indexed`
        );
        retryCounts.delete(event.documentId);
      } catch (err) {
        const retries = (retryCounts.get(event.documentId) ?? 0) + 1;
        retryCounts.set(event.documentId, retries);

        const error = err instanceof Error ? err : new Error(String(err));

        if (retries >= MAX_RETRIES) {
          console.error(
            `Document ${event.documentId} failed after ${MAX_RETRIES} retries — sending to DLQ`
          );
          await db.markFailed(
            event.documentId,
            `Failed after ${MAX_RETRIES} retries: ${error.message}`
          );
          await dlq.send(
            { key: message.key?.toString(), value, topic, partition, offset: message.offset },
            error
          );
          retryCounts.delete(event.documentId);
        } else {
          console.error(
            `Error processing ${event.documentId} (attempt ${retries}/${MAX_RETRIES}):`,
            err
          );
          await db.markFailed(event.documentId, error.message);
        }
      }

      await commitOffset(consumer, topic, partition, message.offset);
    },
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Consumer shutting down...");
    await consumer.disconnect();
    await dlq.disconnect();
    await vectorStore.close();
    await db.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function commitOffset(
  consumer: { commitOffsets: (offsets: Array<{ topic: string; partition: number; offset: string }>) => Promise<void> },
  topic: string,
  partition: number,
  offset: string
) {
  await consumer.commitOffsets([
    { topic, partition, offset: (BigInt(offset) + 1n).toString() },
  ]);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
