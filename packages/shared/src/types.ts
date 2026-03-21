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
  filename: string;
  status: DocumentStatus;
  chunkCount: number;
  uploadedAt: Date;
  updatedAt: Date;
  errorMsg?: string;
}

export interface KafkaDocumentEvent {
  documentId: string;
  filename: string;
  filePath: string;
}

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
