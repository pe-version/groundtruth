import {
  DocumentStatus,
  type KafkaDocumentEvent,
  type MongoDB,
  type VectorStore,
} from "@direze/shared";
import { processDocument } from "./processor.js";
import type { DeadLetterQueue } from "./dlq.js";

export interface HandleMessageDeps {
  db: MongoDB;
  vectorStore: VectorStore;
  dlq: DeadLetterQueue;
  uploadDir: string;
  heartbeat: () => Promise<void>;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string, err?: Error) => void;
  };
}

export interface KafkaMessageEnvelope {
  key?: string;
  value: string | null;
  topic: string;
  partition: number;
  offset: string;
}

// Processes a single Kafka message. Extracted from the eachMessage closure in
// index.ts so we can exercise the retry/DLQ/commit branches without a live
// Kafka cluster.
export async function handleMessage(
  deps: HandleMessageDeps,
  msg: KafkaMessageEnvelope
): Promise<void> {
  const { db, vectorStore, dlq, uploadDir, heartbeat, log } = deps;

  if (!msg.value) {
    log.warn("Empty message received, skipping");
    return;
  }

  let event: KafkaDocumentEvent;
  try {
    event = JSON.parse(msg.value);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error("Could not parse message, sending to DLQ", error);
    await dlq.send(
      { key: msg.key, value: msg.value, topic: msg.topic, partition: msg.partition, offset: msg.offset },
      error
    );
    return;
  }

  log.info(`Processing document ${event.documentId} (${event.filename})`);
  await db.updateStatus(event.documentId, DocumentStatus.Processing, 0);

  const heartbeatInterval = setInterval(() => {
    heartbeat().catch(() => {});
  }, 5000);

  try {
    const chunkCount = await processDocument(event, db, vectorStore, uploadDir);
    await db.updateStatus(event.documentId, DocumentStatus.Ready, chunkCount);
    log.info(`Done: ${event.documentId} — ${chunkCount} chunks indexed`);
  } catch (err) {
    // DLQ-on-first-failure: no in-process retries. Users recover by
    // re-uploading. The DLQ preserves the original message for operator
    // inspection and manual replay.
    const error = err instanceof Error ? err : new Error(String(err));
    log.error(`Error processing ${event.documentId} — sending to DLQ`, error);
    await db.markFailed(event.documentId, error.message);
    await dlq.send(
      { key: msg.key, value: msg.value, topic: msg.topic, partition: msg.partition, offset: msg.offset },
      error
    );
  } finally {
    clearInterval(heartbeatInterval);
  }
}
