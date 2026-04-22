import {
  DocumentStatus,
  KafkaDocumentEventSchema,
  type KafkaDocumentEvent,
  type Logger,
  type MongoDB,
  type VectorStore,
} from "@groundtruth/shared";
import { processDocument } from "./processor.js";
import type { DeadLetterQueue } from "./dlq.js";

export interface HandleMessageDeps {
  db: MongoDB;
  vectorStore: VectorStore;
  dlq: DeadLetterQueue;
  uploadDir: string;
  heartbeat: () => Promise<void>;
  log: Logger;
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

  // Parse, don't cast. Malformed or unexpected shapes go straight to the DLQ
  // with a descriptive error rather than blowing up deeper in the pipeline.
  let event: KafkaDocumentEvent;
  try {
    const parsed = JSON.parse(msg.value);
    event = KafkaDocumentEventSchema.parse(parsed);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, "Invalid message, sending to DLQ");
    await dlq.send(
      { key: msg.key, value: msg.value, topic: msg.topic, partition: msg.partition, offset: msg.offset },
      error
    );
    return;
  }

  // Child logger carries documentId + userId on every subsequent line from
  // this message's lifetime (the caller has already attached requestId).
  const msgLog = log.child({
    documentId: event.documentId,
    userId: event.userId,
  });

  msgLog.info({ filename: event.filename }, "Processing document");
  await db.updateStatus(event.documentId, DocumentStatus.Processing, 0);

  const heartbeatInterval = setInterval(() => {
    heartbeat().catch((err) => msgLog.warn({ err }, "Heartbeat failed"));
  }, 5000);

  try {
    const chunkCount = await processDocument(event, db, vectorStore, uploadDir);
    await db.updateStatus(event.documentId, DocumentStatus.Ready, chunkCount);
    msgLog.info({ chunkCount }, "Document processed");
  } catch (err) {
    // DLQ-on-first-failure: no in-process retries. Users recover by
    // re-uploading. The DLQ preserves the original message for operator
    // inspection and manual replay.
    const error = err instanceof Error ? err : new Error(String(err));
    msgLog.error({ err: error }, "Processing failed, sending to DLQ");
    await db.markFailed(event.documentId, error.message);
    await dlq.send(
      { key: msg.key, value: msg.value, topic: msg.topic, partition: msg.partition, offset: msg.offset },
      error
    );
  } finally {
    clearInterval(heartbeatInterval);
  }
}
