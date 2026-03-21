import { describe, it, expect } from "vitest";
import { extractTextFromPDF } from "../src/pdf-extract.js";

describe("extractTextFromPDF", () => {
  it("rejects non-PDF buffers", async () => {
    const buffer = Buffer.from("This is not a PDF");
    await expect(extractTextFromPDF(buffer)).rejects.toThrow(
      "Not a valid PDF file"
    );
  });

  it("rejects empty buffers", async () => {
    const buffer = Buffer.alloc(0);
    await expect(extractTextFromPDF(buffer)).rejects.toThrow(
      "Not a valid PDF file"
    );
  });

  it("rejects buffers that start with %PDF but are invalid", async () => {
    const buffer = Buffer.from("%PDF-1.4 corrupted data");
    // pdf-parse will throw on invalid PDF structure
    await expect(extractTextFromPDF(buffer)).rejects.toThrow();
  });
});
