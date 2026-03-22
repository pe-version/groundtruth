"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import Link from "next/link";
import { listDocuments, deleteDocument, Document, DocumentStatus } from "@/lib/api";
import { FileText, Trash2, MessageSquare, RefreshCw } from "lucide-react";

const STATUS_STYLES: Record<DocumentStatus, string> = {
  pending:    "bg-yellow-900/50 text-yellow-300 border-yellow-700",
  processing: "bg-blue-900/50   text-blue-300   border-blue-700",
  ready:      "bg-green-900/50  text-green-300  border-green-700",
  failed:     "bg-red-900/50    text-red-300    border-red-700",
};

const STATUS_TOOLTIPS: Record<DocumentStatus, string> = {
  pending:    "Waiting to be processed",
  processing: "We're reading your document — this usually takes a minute",
  ready:      "Ready to use",
  failed:     "Something went wrong processing this document",
};

function allTerminal(docs: Document[]): boolean {
  return docs.length > 0 && docs.every((d) => d.status === "ready" || d.status === "failed");
}

export default function DocumentsPage() {
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDocs = useCallback(async () => {
    try {
      const result = await listDocuments();
      setDocs(result);
      setError(null);

      // Stop polling if all documents are in terminal states
      if (allTerminal(result) && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load documents";
      setError(msg);

      // Stop polling on auth errors
      if (msg.includes("401") || msg.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden")) {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(fetchDocs, 5000);
  }, [fetchDocs]);

  useEffect(() => {
    fetchDocs();
    startPolling();
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchDocs, startPolling]);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this document? You won't be able to ask questions about it anymore.")) return;
    try {
      await deleteDocument(id);
      setDocs((prev) => prev.filter((d) => d.id !== id));
    } catch {
      alert("Failed to delete the document. Please try again.");
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Documents</h1>
          <div className="flex gap-3">
            <button
              onClick={() => { fetchDocs(); startPolling(); }}
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
            >
              <RefreshCw className="w-4 h-4" /> Refresh
            </button>
            <Link
              href="/chat"
              className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
            >
              <MessageSquare className="w-4 h-4" /> Ask a Question
            </Link>
            <Link
              href="/upload"
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium transition-colors"
            >
              + Upload
            </Link>
          </div>
        </div>

        {error && (
          <div className="mb-6 p-3 bg-red-950/50 border border-red-800 rounded-lg text-red-300 text-sm">
            {error}
          </div>
        )}

        {loading && docs.length === 0 ? (
          <p className="text-gray-500">Loading...</p>
        ) : docs.length === 0 ? (
          <div className="text-center py-20 text-gray-500">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No documents yet. <Link href="/upload" className="text-indigo-400 hover:underline">Upload one.</Link></p>
          </div>
        ) : (
          <ul className="space-y-3">
            {docs.map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between p-4 bg-gray-900 rounded-xl border border-gray-800 hover:border-gray-700 transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{doc.filename}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {doc.chunkCount > 0 && `${doc.chunkCount} sections · `}
                      {new Date(doc.uploadedAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0 ml-4">
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full border ${STATUS_STYLES[doc.status]}`}
                    title={STATUS_TOOLTIPS[doc.status]}
                  >
                    {doc.status}
                  </span>

                  {doc.status === "failed" && doc.errorMsg && (
                    <span className="text-xs text-red-400 max-w-[200px] truncate" title={doc.errorMsg}>
                      {doc.errorMsg}
                    </span>
                  )}

                  {doc.status === "ready" && (
                    <Link
                      href={`/chat?docId=${doc.id}&filename=${encodeURIComponent(doc.filename)}`}
                      className="p-2 rounded-lg bg-indigo-900/50 hover:bg-indigo-800/60 text-indigo-300 transition-colors"
                      title="Ask questions"
                    >
                      <MessageSquare className="w-4 h-4" />
                    </Link>
                  )}

                  <button
                    onClick={() => handleDelete(doc.id)}
                    className="p-2 rounded-lg hover:bg-red-900/40 text-gray-500 hover:text-red-400 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
