// lib/api.ts — typed client for the Groundtruth API
// Auth is handled via httpOnly cookies set by the API.
// The NextAuth session provides the token for server-side calls;
// browser requests use credentials: "include" to send cookies.

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080/api";

export type DocumentStatus = "pending" | "processing" | "ready" | "failed";

export interface Document {
  id: string;
  filename: string;
  status: DocumentStatus;
  chunkCount: number;
  uploadedAt: string;
  updatedAt: string;
  errorMsg?: string;
}

export interface QueryResponse {
  answer: string;
  sources: string[];
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
// Token is stored in NextAuth session and passed via Authorization header.
// The API also sets an httpOnly cookie as a fallback.

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
}

export function getAuthToken(): string | null {
  return authToken;
}

function requestInit(extra?: RequestInit): RequestInit {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
  }
  return {
    ...extra,
    credentials: "include" as const,
    headers: { ...headers, ...(extra?.headers as Record<string, string> ?? {}) },
  };
}

function checkRateLimit(res: Response): void {
  if (res.status === 429) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }
}

// ── Documents ──────────────────────────────────────────────────────────────

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch(`${BASE}/documents`, requestInit({ cache: "no-store" }));
  checkRateLimit(res);
  if (!res.ok) throw new Error(`Failed to fetch documents (${res.status})`);
  return res.json();
}

export async function getDocument(id: string): Promise<Document> {
  const res = await fetch(`${BASE}/documents/${id}`, requestInit({ cache: "no-store" }));
  checkRateLimit(res);
  if (!res.ok) throw new Error(`Failed to fetch document (${res.status})`);
  return res.json();
}

export async function uploadDocument(file: File): Promise<Document> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/documents/upload`, requestInit({
    method: "POST",
    body: form,
  }));
  checkRateLimit(res);
  if (!res.ok) {
    const err: Record<string, unknown> = await res.json().catch(() => ({}));
    throw new Error(
      typeof err.error === "string" ? err.error : "Upload failed"
    );
  }
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${BASE}/documents/${id}`, requestInit({
    method: "DELETE",
  }));
  checkRateLimit(res);
  if (!res.ok) throw new Error("Delete failed");
}

// ── Query (non-streaming) ────────────────────────────────────────────────────

export async function queryDocument(
  documentId: string | null,
  question: string,
  topK = 5
): Promise<QueryResponse> {
  const body: Record<string, unknown> = { question, topK };
  if (documentId) body.documentId = documentId;

  const res = await fetch(`${BASE}/query`, requestInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
  checkRateLimit(res);
  if (!res.ok) throw new Error("Query failed");
  return res.json();
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface DashboardStats {
  total: number;
  ready: number;
  processing: number;
  pending: number;
  failed: number;
  byStatus: Record<string, number>;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const res = await fetch(`${BASE}/dashboard/stats`, requestInit({ cache: "no-store" }));
  checkRateLimit(res);
  if (!res.ok) throw new Error("Failed to fetch stats");
  return res.json();
}

// ── Query (streaming via SSE) ────────────────────────────────────────────────

export interface StreamCallbacks {
  onSources: (sources: string[]) => void;
  onDelta: (text: string) => void;
  onDone: () => void;
  onError: (error: Error) => void;
}

export async function queryDocumentStream(
  documentId: string | null,
  question: string,
  callbacks: StreamCallbacks,
  topK = 5
): Promise<void> {
  const body: Record<string, unknown> = { question, topK };
  if (documentId) body.documentId = documentId;

  const res = await fetch(`${BASE}/query/stream`, requestInit({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

  if (res.status === 429) {
    callbacks.onError(new Error("Too many requests. Please wait a moment and try again."));
    return;
  }

  if (!res.ok) {
    callbacks.onError(new Error("Query failed"));
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) {
    callbacks.onError(new Error("No response body"));
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6);
      try {
        const event = JSON.parse(json);
        if (event.type === "sources") callbacks.onSources(event.sources);
        else if (event.type === "delta") callbacks.onDelta(event.text);
        else if (event.type === "error") callbacks.onError(new Error(event.message));
        else if (event.type === "done") callbacks.onDone();
      } catch {
        // Ignore malformed SSE lines
      }
    }
  }
}
