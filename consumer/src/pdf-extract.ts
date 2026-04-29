import { extractText, getDocumentProxy } from "unpdf";

// Maximum total characters we'll surface from one document. Caps memory
// for adversarial / accidentally-huge PDFs without imposing a per-page
// limit that could truncate honest-but-dense documents.
const MAX_CHARS = 5_000_000;

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Magic-byte gate before we hand bytes to pdf.js. Cheap reject for the
  // common "user uploaded a renamed .txt" case and one less surface for
  // any PDF parser bug to chew on.
  if (buffer.length < 4 || buffer.subarray(0, 4).toString("ascii") !== "%PDF") {
    throw new Error("Not a valid PDF file");
  }

  // unpdf wraps Mozilla's pdf.js: ESM, no native deps, no global side
  // effects, and actively maintained. Replaces pdf-parse, which has had
  // known issues with malformed inputs and is no longer maintained.
  let pdf;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (err) {
    throw new Error(
      `Failed to parse PDF: ${(err as Error).message ?? "unknown error"}`
    );
  }

  const { text } = await extractText(pdf, { mergePages: true });
  const joined = (Array.isArray(text) ? text.join("\n") : text).trim();

  if (joined.length === 0) {
    throw new Error("No text could be extracted from the PDF");
  }

  return joined.slice(0, MAX_CHARS);
}
