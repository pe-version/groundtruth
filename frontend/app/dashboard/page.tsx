"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDashboardStats, type DashboardStats } from "@/lib/api";
import { BarChart3, FileText, CheckCircle, Clock, AlertTriangle, Loader2 } from "lucide-react";

const STAT_CARDS = [
  { key: "total" as const, label: "Total Documents", icon: FileText, color: "text-gray-300", bg: "bg-gray-800" },
  { key: "ready" as const, label: "Ready", icon: CheckCircle, color: "text-green-400", bg: "bg-green-900/30" },
  { key: "processing" as const, label: "Processing", icon: Loader2, color: "text-blue-400", bg: "bg-blue-900/30" },
  { key: "pending" as const, label: "Pending", icon: Clock, color: "text-yellow-400", bg: "bg-yellow-900/30" },
  { key: "failed" as const, label: "Failed", icon: AlertTriangle, color: "text-red-400", bg: "bg-red-900/30" },
];

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setStats(await getDashboardStats());
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
    const interval = setInterval(fetchStats, 10_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 p-8">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <BarChart3 className="w-7 h-7 text-indigo-400" />
            <h1 className="text-3xl font-bold">Dashboard</h1>
          </div>
          <div className="flex gap-3">
            <Link
              href="/documents"
              className="px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-sm text-gray-300 transition-colors"
            >
              Documents
            </Link>
            <Link
              href="/upload"
              className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-sm font-medium transition-colors"
            >
              + Upload
            </Link>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-500">Loading stats...</p>
        ) : stats ? (
          <>
            {/* Stat cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4 mb-8">
              {STAT_CARDS.map(({ key, label, icon: Icon, color, bg }) => (
                <div
                  key={key}
                  className={`${bg} rounded-xl border border-gray-800 p-4 flex flex-col items-center gap-2`}
                >
                  <Icon className={`w-6 h-6 ${color}`} />
                  <p className="text-2xl font-bold">{stats[key]}</p>
                  <p className="text-xs text-gray-500">{label}</p>
                </div>
              ))}
            </div>

            {/* Status bar */}
            {stats.total > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-gray-400 font-medium">Processing Pipeline</p>
                <div className="flex h-4 rounded-full overflow-hidden bg-gray-800">
                  {stats.ready > 0 && (
                    <div
                      className="bg-green-500 transition-all"
                      style={{ width: `${(stats.ready / stats.total) * 100}%` }}
                      title={`${stats.ready} ready`}
                    />
                  )}
                  {stats.processing > 0 && (
                    <div
                      className="bg-blue-500 transition-all"
                      style={{ width: `${(stats.processing / stats.total) * 100}%` }}
                      title={`${stats.processing} processing`}
                    />
                  )}
                  {stats.pending > 0 && (
                    <div
                      className="bg-yellow-500 transition-all"
                      style={{ width: `${(stats.pending / stats.total) * 100}%` }}
                      title={`${stats.pending} pending`}
                    />
                  )}
                  {stats.failed > 0 && (
                    <div
                      className="bg-red-500 transition-all"
                      style={{ width: `${(stats.failed / stats.total) * 100}%` }}
                      title={`${stats.failed} failed`}
                    />
                  )}
                </div>
                <div className="flex gap-4 text-xs text-gray-500">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-green-500" /> Ready</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> Processing</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-yellow-500" /> Pending</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> Failed</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-gray-500">Could not load dashboard stats.</p>
        )}
      </div>
    </main>
  );
}
