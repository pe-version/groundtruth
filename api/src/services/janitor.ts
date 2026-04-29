import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  type MetadataStore,
  type VectorStore,
  type Logger,
} from "@groundtruth/shared";

export interface JanitorDeps {
  db: MetadataStore;
  vectorStore: VectorStore;
  uploadDir: string;
  log: Logger;
  // Only touch things older than this. Protects mid-flight uploads and
  // in-progress consumer work from being treated as orphans.
  orphanAgeMs: number;
  intervalMs: number;
}

export interface JanitorReport {
  orphanFilesDeleted: number;
  orphanChunksDeleted: number;
  stuckDocsFailed: number;
}

// Runs a single reconciliation pass across the three storage systems:
//   1. Files on disk with no matching documents row (and old enough)
//   2. Chunks in pgvector whose document_id isn't in `documents`
//   3. `documents` rows stuck in pending/processing past the age threshold
//
// Ordering matters: we read the documents table first, then list filesystem
// / pgvector, so an upload that registers in the table after our read but
// before our fs scan is still treated as live (we'll see the file, but the
// row won't be in our snapshot — it gets protected by the age threshold).
export async function runJanitor(deps: JanitorDeps): Promise<JanitorReport> {
  const { db, vectorStore, uploadDir, log, orphanAgeMs } = deps;
  const now = Date.now();
  const ageThreshold = new Date(now - orphanAgeMs);

  const docs = await db.listAllDocumentIds();
  const knownIds = new Set(docs.map((d) => d.id));

  const report: JanitorReport = {
    orphanFilesDeleted: 0,
    orphanChunksDeleted: 0,
    stuckDocsFailed: 0,
  };

  // --- 1. Orphan files ---------------------------------------------------
  let filenames: string[] = [];
  try {
    filenames = await readdir(uploadDir);
  } catch (err) {
    log.warn({ err }, "Could not read upload dir; skipping file reconciliation");
  }

  for (const name of filenames) {
    if (!name.endsWith(".pdf")) continue;
    const docId = name.slice(0, -".pdf".length);
    if (knownIds.has(docId)) continue;

    const fullPath = path.join(uploadDir, name);
    try {
      const s = await stat(fullPath);
      if (s.mtimeMs > now - orphanAgeMs) continue; // too fresh; skip
      await unlink(fullPath);
      log.info({ file: name }, "Deleted orphan file");
      report.orphanFilesDeleted++;
    } catch (err) {
      log.warn({ err, file: name }, "Failed to delete orphan file");
    }
  }

  // --- 2. Orphan chunks --------------------------------------------------
  try {
    const chunkDocIds = await vectorStore.listAllDocumentIds();
    for (const docId of chunkDocIds) {
      if (knownIds.has(docId)) continue;
      const deleted = await vectorStore.deleteOrphanChunks(docId);
      if (deleted > 0) {
        log.info({ documentId: docId, deleted }, "Deleted orphan chunks");
        report.orphanChunksDeleted += deleted;
      }
    }
  } catch (err) {
    log.warn({ err }, "Chunk reconciliation failed");
  }

  // --- 3. Stuck pending/processing docs ---------------------------------
  try {
    const stuck = await db.listStuckDocuments(ageThreshold);
    for (const doc of stuck) {
      await db.markFailed(
        doc.id,
        `Stuck in ${doc.status} past ${Math.round(orphanAgeMs / 60000)}m; janitor marked failed`
      );
      log.warn({ documentId: doc.id, previousStatus: doc.status }, "Marked stuck doc failed");
      report.stuckDocsFailed++;
    }
  } catch (err) {
    log.warn({ err }, "Stuck-doc reconciliation failed");
  }

  log.info(report, "Janitor pass complete");
  return report;
}

export function startJanitor(deps: JanitorDeps): () => void {
  // Run one pass shortly after boot, then on the interval. The initial pass
  // catches leftovers from the previous shutdown/crash.
  const initial = setTimeout(() => {
    runJanitor(deps).catch((err) => deps.log.error({ err }, "Janitor pass failed"));
  }, 60_000);

  const interval = setInterval(() => {
    runJanitor(deps).catch((err) => deps.log.error({ err }, "Janitor pass failed"));
  }, deps.intervalMs);

  return () => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
