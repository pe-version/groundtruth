"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, UserPlus } from "lucide-react";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace("/api", "") ?? "http://localhost:8080";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(
        res.status === 409
          ? "That username is already taken."
          : typeof data.error === "string"
          ? data.error
          : "Registration failed. Please try again."
      );
      setLoading(false);
      return;
    }

    // Auto sign-in after successful registration.
    const result = await signIn("credentials", {
      username,
      password,
      redirect: false,
    });

    setLoading(false);
    if (result?.error) {
      router.push("/login");
    } else {
      router.push("/documents");
    }
  };

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center p-8">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-bold mb-2">Create an account</h1>
        <p className="text-gray-400 mb-8">
          Upload documents and get instant answers.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm text-gray-400 mb-1">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm
                focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm text-gray-400 mb-1">
              Password{" "}
              <span className="text-gray-600">(min 8 characters)</span>
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-sm
                focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-950/50 border border-red-800 rounded-lg text-red-300">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span className="text-sm">{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg
              bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed
              text-sm font-medium transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            {loading ? "Creating account..." : "Create account"}
          </button>
        </form>

        <p className="text-sm text-gray-500 mt-6 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-indigo-400 hover:text-indigo-300">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
