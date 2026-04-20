import path from "node:path";

// Derives the on-disk path for an uploaded document. Both the API (writer) and
// the consumer (reader) call this so the layout is defined in exactly one
// place — the Kafka event carries only documentId, never a path, so nothing
// external can influence where the consumer reads from.
export function getUploadPath(uploadDir: string, documentId: string): string {
  return path.join(uploadDir, `${documentId}.pdf`);
}
