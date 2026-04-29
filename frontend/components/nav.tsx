"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, UploadCloud, MessageSquare, LayoutDashboard, LogOut } from "lucide-react";
import { useAuth } from "@/lib/auth-provider";

const links = [
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/upload", label: "Upload", icon: UploadCloud },
  { href: "/chat", label: "Ask a Question", icon: MessageSquare },
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
];

export default function Nav() {
  const pathname = usePathname();
  const { status, logout } = useAuth();

  // Hide the nav entirely on the auth pages — they're full-page sign-in /
  // sign-up flows where a header would just be visual noise. Same goes
  // for any pre-bootstrap render where we don't yet know the auth state.
  if (status !== "authenticated") return null;

  return (
    <nav className="bg-gray-900 border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-6">
        <span className="text-white font-semibold text-lg tracking-tight">Groundtruth</span>
        <div className="flex items-center gap-1">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                  active
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
                }`}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            );
          })}
        </div>
      </div>
      <button
        onClick={() => logout()}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors"
      >
        <LogOut className="w-4 h-4" />
        Sign Out
      </button>
    </nav>
  );
}
