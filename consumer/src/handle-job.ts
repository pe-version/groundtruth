import {
  DocumentStatus,
  type DocumentJob,
  type Logger,
  type MongoDB,
  type VectorStore,
} from "@groundtruth/shared";
import { processDocument } from "./processor.js";

export interface HandleJobDeps {
  db: MongoDB;
  vectorStore: VectorStore;
  uploadDir: string;
  log: Logger;
}

export interface JobResult {
  success: boolean;
  errorMessage?: string;
}

// Process a single dequeued job. Returns success/failure to the caller
// (the poll loop) which is responsible for marking the job row in the
// queue. Splitting it this way keeps the queue concerns out of the
// document-processing logic and makes both individually testable.
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
    // Fail-fast: no in-process retries. The job-row's `error_message` and
    // status='failed' is the post-mortem record. Users recover by
    // re-uploading; operators inspect with
    //   SELECT * FROM document_jobs WHERE status='failed';
    const error = err instanceof Error ? err : new Error(String(err));
    log.error({ err: error }, "Processing failed");
    await db.markFailed(job.documentId, error.message);
    return { success: false, errorMessage: error.message };
  }
}
