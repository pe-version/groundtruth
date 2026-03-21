import pdf from "pdf-parse";

export async function extractTextFromPDF(buffer: Buffer): Promise<string> {
  // Validate PDF magic bytes
  if (
    buffer.length < 4 ||
    buffer.subarray(0, 4).toString("ascii") !== "%PDF"
  ) {
    throw new Error("Not a valid PDF file");
  }

  const data = await pdf(buffer);

  if (!data.text || data.text.trim().length === 0) {
    throw new Error("No text could be extracted from the PDF");
  }

  return data.text;
}
