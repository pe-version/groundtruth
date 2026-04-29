// lib/api.ts — typed client for the Groundtruth API.
//
// Auth model (post-NextAuth-removal):
//   • Access token: 15-minute JWT, returned in JSON on login/register/refresh
//     and also set as an httpOnly cookie on the API origin. We mirror it in
//     module-local state so we can attach it as `Authorization: Bearer …`
//     on every request — that makes the smoke test and any non-browser
//     consumer Just Work without depending on cookies.
//   • Refresh token: 30-day random secret, kept only as an httpOnly cookie
//     scoped to /api/auth on the API origin. Never visible to JS.
//   • On a 401, the client tries /auth/refresh once. Success → retry the
//     original request. Failure → cleared state and a "session expired"
//     error the caller surfaces to the user.

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

export interface AuthResponse {
  token: string;
  userId: string;
}

// ── Auth state ───────────────────────────────────────────────────────────────

let authToken: string | null = null;
const subscribers = new Set<(token: string | null) => void>();

export function setAuthToken(token: string | null): void {
  authToken = token;
  subscribers.forEach((fn) => fn(token));
}

export function getAuthToken(): string | null {
  return authToken;
}

// AuthProvider subscribes here so the React tree re-renders when auth
// state changes (login, refresh, logout). Returns the unsubscribe fn.
export function subscribeAuth(fn: (token: string | null) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ── Internal request plumbing ────────────────────────────────────────────────

class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

function buildHeaders(extra?: HeadersInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;
  if (extra) Object.assign(headers, extra as Record<string, string>);
  return headers;
}

// Try to refresh once. Returns true on success (new access token now in
// state), false if the refresh cookie is missing or expired.
async function tryRefresh(): Promise<boolean> {
  const res = await fetch(`${BASE}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    setAuthToken(null);
    return false;
  }
  const data = (await res.json()) as AuthResponse;
  setAuthToken(data.token);
  return true;
}

// All authenticated requests go through here. On a 401, we attempt one
// silent refresh and retry; any further 401 propagates so the caller can
// redirect to /login.
async function request(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = buildHeaders(init.headers);
  let res = await fetch(input, { ...init, headers, credentials: "include" });
  if (res.status !== 401) return res;

  const refreshed = await tryRefresh();
  if (!refreshed) throw new UnauthorizedError();

  res = await fetch(input, {
    ...init,
    headers: buildHeaders(init.headers),
    credentials: "include",
  });
  if (res.status === 401) throw new UnauthorizedError();
  return res;
}

function checkRateLimit(res: Response): void {
  if (res.status === 429) {
    throw new Error("Too many requests. Please wait a moment and try again.");
  }
}

// ── Auth API ─────────────────────────────────────────────────────────────────

export async function login(username: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });
  if (res.status === 401) throw new Error("Invalid credentials");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(typeof err.error === "string" ? err.error : "Login failed");
  }
  const data = (await res.json()) as AuthResponse;
  setAuthToken(data.token);
  return data;
}

export async function register(username: string, password: string): Promise<AuthResponse> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    credentials: "include",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 409) throw new Error("That username is already taken.");
    throw new Error(
      typeof err.error === "string" ? err.error : "Registration failed."
    );
  }
  const data = (await res.json()) as AuthResponse;
  setAuthToken(data.token);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await fetch(`${BASE}/auth/logout`, {
      method: "POST",
      credentials: "include",
    });
  } finally {
    setAuthToken(null);
  }
}

// Page-load bootstrap: try to silently refresh. If the refresh cookie is
// present and valid, the user has a live session. Otherwise the caller
// should treat them as logged out.
export async function restoreSession(): Promise<boolean> {
  return await tryRefresh();
}

// ── Documents ────────────────────────────────────────────────────────────────

export async function listDocuments(): Promise<Document[]> {
  const res = await request(`${BASE}/documents`, { cache: "no-store" });
  checkRateLimit(res);
  if (!res.ok) throw new Error(`Failed to fetch documents (${res.status})`);
  return res.json();
}

export async function getDocument(id: string): Promise<Document> {
  const res = await request(`${BASE}/documents/${id}`, { cache: "no-store" });
  checkRateLimit(res);
  if (!res.ok) throw new Error(`Failed to fetch document (${res.status})`);
  return res.json();
}

export async function uploadDocument(file: File): Promise<Document> {
  const form = new FormData();
  form.append("file", file);
  const res = await request(`${BASE}/documents/upload`, {
    method: "POST",
    body: form,
  });
  checkRateLimit(res);
  if (!res.ok) {
    const err: Record<string, unknown> = await res.json().catch(() => ({}));
    throw new Error(typeof err.error === "string" ? err.error : "Upload failed");
  }
  return res.json();
}

export async function deleteDocument(id: string): Promise<void> {
  const res = await request(`${BASE}/documents/${id}`, { method: "DELETE" });
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

  const res = await request(`${BASE}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
  const res = await request(`${BASE}/dashboard/stats`, { cache: "no-store" });
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

  let res: Response;
  try {
    res = await request(`${BASE}/query/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    callbacks.onError(err instanceof Error ? err : new Error("Query failed"));
    return;
  }

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
