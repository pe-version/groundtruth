import { z } from "zod";

export const DocumentStatus = {
  Pending: "pending",
  Processing: "processing",
  Ready: "ready",
  Failed: "failed",
} as const;

export type DocumentStatus =
  (typeof DocumentStatus)[keyof typeof DocumentStatus];

export interface Document {
  _id: string;
  userId: string;
  filename: string;
  status: DocumentStatus;
  chunkCount: number;
  uploadedAt: Date;
  updatedAt: Date;
  errorMsg?: string;
}

// Runtime schema for messages on the `raw-docs` Kafka topic. The type is
// *derived* from the schema so there is no way for the declared shape and
// the validator to drift apart — they are literally the same definition.
// Parsing discipline: every trust boundary that receives a KafkaDocumentEvent
// uses KafkaDocumentEventSchema.parse(), never a cast.
export const KafkaDocumentEventSchema = z.object({
  documentId: z.string().min(1),
  userId: z.string().min(1),
  filename: z.string().min(1),
});

export type KafkaDocumentEvent = z.infer<typeof KafkaDocumentEventSchema>;

export interface Chunk {
  id: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  score: number;
}

export interface QueryRequest {
  documentId: string;
  question: string;
  topK?: number;
}

export interface QueryResponse {
  answer: string;
  sources: string[];
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export interface User {
  _id: string;            // username (or "provider:id" for OAuth users)
  passwordHash: string;   // empty string for OAuth-only users
  oauthProvider?: string; // e.g. "github" — set for OAuth-provisioned accounts
  createdAt: Date;
}
