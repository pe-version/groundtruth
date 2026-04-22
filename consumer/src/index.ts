import { Kafka, type EachMessagePayload } from "kafkajs";
import { loadConsumerConfig, MongoDB, VectorStore, createLogger } from "@groundtruth/shared";
import { DeadLetterQueue } from "./dlq.js";
import { handleMessage } from "./handle-message.js";

async function main() {
  const config = loadConsumerConfig();
  const log = createLogger("consumer");

  const db = await MongoDB.connect(config.MONGO_URI);
  const vectorStore = await VectorStore.connect(config.POSTGRES_DSN);

  const kafka = new Kafka({
    clientId: "groundtruth-consumer",
    brokers: config.KAFKA_BROKERS.split(",").map((b) => b.trim()),
  });

  const consumer = kafka.consumer({ groupId: config.KAFKA_GROUP_ID });
  await consumer.connect();
  await consumer.subscribe({ topic: "raw-docs", fromBeginning: false });

  const dlq = new DeadLetterQueue(kafka);
  await dlq.connect();

  log.info("Consumer started, waiting for messages");

  await consumer.run({
    autoCommit: false,
    eachMessage: async ({
      message,
      partition,
      topic,
      heartbeat,
    }: EachMessagePayload) => {
      // Propagate the API-side requestId through Kafka headers so a single
      // grep can follow an upload from HTTP entry to chunks indexed.
      const requestId = message.headers?.["x-request-id"]?.toString();
      const msgLog = log.child({
        requestId,
        topic,
        partition,
        offset: message.offset,
      });

      await handleMessage(
        {
          db,
          vectorStore,
          dlq,
          uploadDir: config.UPLOAD_DIR,
          heartbeat,
          log: msgLog,
        },
        {
          key: message.key?.toString(),
          value: message.value?.toString() ?? null,
          topic,
          partition,
          offset: message.offset,
        }
      );
      await commitOffset(consumer, topic, partition, message.offset);
    },
  });

  const shutdown = async () => {
    log.info("Consumer shutting down");
    try { await consumer.disconnect(); } catch (err) { log.error({ err }, "Error disconnecting consumer"); }
    try { await dlq.disconnect(); } catch (err) { log.error({ err }, "Error disconnecting DLQ"); }
    try { await vectorStore.close(); } catch (err) { log.error({ err }, "Error closing VectorStore"); }
    try { await db.disconnect(); } catch (err) { log.error({ err }, "Error disconnecting MongoDB"); }
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
  // Logger may not be initialized if config load failed; fall back to console.
  console.error("Fatal error:", err);
  process.exit(1);
});
