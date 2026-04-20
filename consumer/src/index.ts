import { Kafka, type EachMessagePayload } from "kafkajs";
import { loadConsumerConfig, MongoDB, VectorStore } from "@direze/shared";
import { DeadLetterQueue } from "./dlq.js";
import { handleMessage } from "./handle-message.js";

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
      await handleMessage(
        {
          db,
          vectorStore,
          dlq,
          uploadDir: config.UPLOAD_DIR,
          heartbeat,
          log: {
            info: (m) => console.log(m),
            warn: (m) => console.warn(m),
            error: (m, err) => console.error(m, err?.message ?? ""),
          },
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
