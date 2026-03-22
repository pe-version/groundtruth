"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { uploadDocument } from "@/lib/api";
import { UploadCloud, FileText, AlertCircle, CheckCircle } from "lucide-react";

type UploadState = "idle" | "uploading" | "success" | "error";

export default function UploadPage() {
  const router = useRouter();
  const [state, setState] = useState<UploadState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [isDragging, setIsDragging] = useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        setErrorMsg("Only PDF files are supported.");
        setState("error");
        return;
      }

      setState("uploading");
      try {
        await uploadDocument(file);
        setState("success");
        setTimeout(() => router.push("/documents"), 1500);
      } catch (e: unknown) {
        setErrorMsg(e instanceof Error ? e.message : "Upload failed.");
        setState("error");
      }
    },
    [router]
  );

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col items-center justify-center p-8">
      <div className="w-full max-w-xl">
        <h1 className="text-3xl font-bold mb-2">Upload a Document</h1>
        <p className="text-gray-400 mb-8">
          Upload a PDF and we&apos;ll prepare it so you can ask questions about it. This usually takes a minute or two.
        </p>

        {/* Drop zone */}
        <label
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`
            flex flex-col items-center justify-center w-full h-60 border-2 border-dashed rounded-xl cursor-pointer
            transition-colors duration-200
            ${isDragging ? "border-indigo-400 bg-indigo-950/40" : "border-gray-700 bg-gray-900 hover:border-indigo-500"}
            ${state === "uploading" ? "opacity-50 pointer-events-none" : ""}
          `}
        >
          <input type="file" accept=".pdf" className="hidden" onChange={onInputChange} />

          {state === "idle" || state === "error" ? (
            <>
              <UploadCloud className="w-12 h-12 text-gray-500 mb-3" />
              <p className="text-gray-400 font-medium">
                Drag & drop a PDF, or <span className="text-indigo-400">browse</span>
              </p>
              <p className="text-sm text-gray-600 mt-1">Max 50 MB</p>
            </>
          ) : state === "uploading" ? (
            <>
              <FileText className="w-12 h-12 text-indigo-400 mb-3 animate-pulse" />
              <p className="text-gray-300">Uploading...</p>
            </>
          ) : (
            <>
              <CheckCircle className="w-12 h-12 text-green-400 mb-3" />
              <p className="text-gray-300">Uploaded! Redirecting...</p>
            </>
          )}
        </label>

        {/* Error message */}
        {state === "error" && (
          <div className="flex items-center gap-2 mt-4 p-3 bg-red-950/50 border border-red-800 rounded-lg text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="text-sm">{errorMsg}</span>
          </div>
        )}
      </div>
    </main>
  );
}
