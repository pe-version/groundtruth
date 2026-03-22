"use client";

import { useState, useRef, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import { queryDocumentStream } from "@/lib/api";
import { Send, ArrowLeft, ChevronDown, ChevronUp, Bot, User } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
}

const EXAMPLE_QUESTIONS = [
  "Summarize this document",
  "What are the key points?",
  "What dates or deadlines are mentioned?",
];

function ChatInterface() {
  const params = useSearchParams();
  const docId = params.get("docId") || null;
  const filename = params.get("filename") ?? "All Documents";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [expandedSources, setExpandedSources] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    // Add a placeholder assistant message that we'll stream into
    const assistantIdx = messages.length + 1; // index of the new assistant message
    setMessages((prev) => [
      ...prev,
      { role: "assistant", content: "", sources: [] },
    ]);

    try {
      await queryDocumentStream(docId, question, {
        onSources: (sources) => {
          setMessages((prev) => {
            const updated = [...prev];
            const msg = updated[assistantIdx];
            if (msg) updated[assistantIdx] = { ...msg, sources };
            return updated;
          });
        },
        onDelta: (text) => {
          setMessages((prev) => {
            const updated = [...prev];
            const msg = updated[assistantIdx];
            if (msg)
              updated[assistantIdx] = {
                ...msg,
                content: msg.content + text,
              };
            return updated;
          });
        },
        onDone: () => {
          setLoading(false);
        },
        onError: () => {
          setMessages((prev) => {
            const updated = [...prev];
            updated[assistantIdx] = {
              role: "assistant",
              content: "Sorry, something went wrong. Please try again.",
            };
            return updated;
          });
          setLoading(false);
        },
      });
    } catch {
      setMessages((prev) => {
        const updated = [...prev];
        updated[assistantIdx] = {
          role: "assistant",
          content: "Sorry, something went wrong. Please try again.",
        };
        return updated;
      });
      setLoading(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 p-4 border-b border-gray-800 bg-gray-900 shrink-0">
        <Link href="/documents" className="p-1.5 rounded-lg hover:bg-gray-800 text-gray-400 transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div>
          <p className="font-medium text-sm truncate max-w-xs">{filename}</p>
          <p className="text-xs text-gray-500">
            {docId ? "Ask anything about this document" : "Ask across all documents"}
          </p>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 max-w-3xl w-full mx-auto">
        {messages.length === 0 && (
          <div className="text-center text-gray-600 pt-16">
            <Bot className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="mb-6">
              {docId
                ? <>Ask a question about <span className="text-gray-400">{filename}</span></>
                : <>Ask a question across <span className="text-gray-400">all documents</span></>}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => setInput(q)}
                  className="px-3 py-1.5 text-sm rounded-lg border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1
              ${msg.role === "user" ? "bg-indigo-600" : "bg-gray-700"}`}>
              {msg.role === "user"
                ? <User className="w-4 h-4" />
                : <Bot className="w-4 h-4" />}
            </div>

            <div className={`max-w-[80%] ${msg.role === "user" ? "items-end" : "items-start"} flex flex-col gap-1`}>
              <div className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed
                ${msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-tr-sm whitespace-pre-wrap"
                  : "bg-gray-800 text-gray-100 rounded-tl-sm prose prose-invert prose-sm max-w-none"}`}>
                {msg.content ? (
                  msg.role === "assistant" ? (
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  ) : (
                    msg.content
                  )
                ) : (loading && msg.role === "assistant" ? (
                  <div className="flex gap-1">
                    {[0, 1, 2].map((j) => (
                      <span key={j} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce"
                        style={{ animationDelay: `${j * 150}ms` }} />
                    ))}
                  </div>
                ) : null)}
              </div>

              {/* Source passages (collapsible) */}
              {msg.sources && msg.sources.length > 0 && (
                <button
                  onClick={() => setExpandedSources(expandedSources === i ? null : i)}
                  className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors ml-1"
                >
                  {expandedSources === i ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  See relevant passages ({msg.sources.length})
                </button>
              )}

              {expandedSources === i && msg.sources && (
                <div className="space-y-1.5 mt-1">
                  {msg.sources.map((src, j) => (
                    <div key={j} className="text-xs bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-gray-400 max-w-sm">
                      <span className="text-gray-600 font-mono mr-1">[{j + 1}]</span>
                      {src}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-gray-800 bg-gray-900 shrink-0">
        <div className="max-w-3xl mx-auto flex gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Ask a question about your document..."
            rows={1}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-2.5 text-sm
              resize-none focus:outline-none focus:border-indigo-500 transition-colors
              placeholder:text-gray-600"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40
              disabled:cursor-not-allowed transition-colors shrink-0"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </div>
    </main>
  );
}

export default function ChatPage() {
  return (
    <Suspense>
      <ChatInterface />
    </Suspense>
  );
}
