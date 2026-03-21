// lib/api.ts — typed client for the Direze API

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

// ── Auth token management ────────────────────────────────────────────────────

let authToken: string | null = null;

export function setAuthToken(token: string | null): void {
  authToken = token;
  if (token) {
    localStorage.setItem("direze_token", token);
  } else {
    localStorage.removeItem("direze_token");
  }
}

export function getAuthToken(): string | null {
  if (authToken) return authToken;
  if (typeof window !== "undefined") {
    authToken = localStorage.getItem("direze_token");
  }
  return authToken;
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

// ── Documents ──────────────────────────────────────────────────────────────

export async function listDocuments(): Promise<Document[]> {
  const res = await fetch(`${BASE}/documents`, {
    cache: "no-store",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch documents");
  return res.json();
}

export async function getDocument(id: string): Promise<Document> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    cache: "no-store",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error("Failed to fetch document");
  return res.json();
}

export async function uploadDocument(file: File): Promise<Document> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${BASE}/documents/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const err: Record<string, unknown> = await res.json().catch(() => ({}));
    throw new Error(
      typeof err.error === "string" ? err.error : "Upload failed"
    );
  }
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await fetch(`${BASE}/documents/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
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

  const res = await fetch(`${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
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
  const res = await fetch(`${BASE}/dashboard/stats`, {
    cache: "no-store",
    headers: authHeaders(),
  });
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

  const res = await fetch(`${BASE}/query/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });

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
        else if (event.type === "done") callbacks.onDone();
      } catch {
        // Ignore malformed SSE lines
      }
    }
  }
}
