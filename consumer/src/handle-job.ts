import {
  DocumentStatus,
  type DocumentJob,
  type Logger,
  type MetadataStore,
  type VectorStore,
} from "@groundtruth/shared";
import { processDocument } from "./processor.js";

export interface HandleJobDeps {
  db: MetadataStore;
  vectorStore: VectorStore;
  uploadDir: string;
  log: Logger;
}

export interface JobResult {
  success: boolean;
  // When false, indicates whether the failure looks transient (caller
  // should let the queue back-off-retry) or permanent (caller should
  // mark terminal-failed). Default to permanent — we'd rather have a
  // retry path go unused than retry-loop a poison pill.
  failureKind?: "permanent" | "transient";
  errorMessage?: string;
}

// Process a single dequeued job. Returns success/failure + the kind of
// failure to the caller (the poll loop), which is responsible for
// marking the job row. Splitting it this way keeps queue concerns out
// of the document-processing logic and makes both individually testable.
export async function handleJob(
  deps: HandleJobDeps,
  job: DocumentJob
): Promise<JobResult> {
  const { db, vectorStore, uploadDir } = deps;
  const log = deps.log.child({
    jobId: job.id,
    documentId: job.documentId,
    userId: job.userId,
    attempt: job.attempts,
    maxAttempts: job.maxAttempts,
  });

  log.info({ filename: job.filename }, "Processing document");
  await db.updateStatus(job.documentId, DocumentStatus.Processing, 0);

  try {
    const chunkCount = await processDocument(
      { documentId: job.documentId, userId: job.userId, filename: job.filename },
      db,
      vectorStore,
      uploadDir
    );
    await db.updateStatus(job.documentId, DocumentStatus.Ready, chunkCount);
    log.info({ chunkCount }, "Document processed");
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const failureKind = classifyFailure(error);
    log.error({ err: error, failureKind }, "Processing failed");
    // Only flip the user-visible doc status to 'failed' when the queue
    // has actually given up (permanent OR retries exhausted). On a
    // transient failure we leave the doc in 'processing' so the user
    // sees "still working" rather than a flapping status.
    if (failureKind === "permanent" || job.attempts >= job.maxAttempts) {
      await db.markFailed(job.documentId, error.message);
    }
    return { success: false, failureKind, errorMessage: error.message };
  }
}

// Classify a thrown error as worth retrying (transient) or not. Default
// permanent so an unknown error type doesn't accidentally retry-loop —
// add cases here only when you know the error is reliably retryable.
function classifyFailure(err: Error): "permanent" | "transient" {
  // AbortError comes from our per-stage AbortController timeouts. A
  // hung embed call is exactly the kind of transient that benefits from
  // backoff retry.
  if (err.name === "AbortError") return "transient";

  // OpenAI/HTTP-style errors that pg/fetch surface as ECONN*/ENETDOWN
  // are network-side and worth retrying.
  const code = (err as Error & { code?: string }).code;
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENETDOWN" ||
    code === "EAI_AGAIN"
  ) {
    return "transient";
  }

  // Everything else is treated as a content/data problem: bad PDF,
  // empty extraction, parser panic. Retrying won't help.
  return "permanent";
}
