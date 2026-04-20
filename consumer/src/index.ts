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
        console.error("Could not parse message, sending to DLQ");
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

      // Periodic heartbeat to prevent rebalancing during long processing.
      const heartbeatInterval = setInterval(() => {
        heartbeat().catch(() => {});
      }, 5000);

      try {
        const chunkCount = await processDocument(
          event,
          db,
          vectorStore,
          config.UPLOAD_DIR
        );
        await db.updateStatus(
          event.documentId,
          DocumentStatus.Ready,
          chunkCount
        );
        console.log(
          `Done: ${event.documentId} — ${chunkCount} chunks indexed`
        );
      } catch (err) {
        // DLQ-on-first-failure: no in-process retries. Users recover by
        // re-uploading. The DLQ preserves the original message for operator
        // inspection and manual replay.
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          `Error processing ${event.documentId} — sending to DLQ:`,
          error.message
        );
        await db.markFailed(event.documentId, error.message);
        await dlq.send(
          { key: message.key?.toString(), value, topic, partition, offset: message.offset },
          error
        );
      } finally {
        clearInterval(heartbeatInterval);
      }

      await commitOffset(consumer, topic, partition, message.offset);
    },
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("Consumer shutting down...");
    try { await consumer.disconnect(); } catch (err) { console.error("Error disconnecting consumer:", err); }
    try { await dlq.disconnect(); } catch (err) { console.error("Error disconnecting DLQ:", err); }
    try { await vectorStore.close(); } catch (err) { console.error("Error closing VectorStore:", err); }
    try { await db.disconnect(); } catch (err) { console.error("Error disconnecting MongoDB:", err); }
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
