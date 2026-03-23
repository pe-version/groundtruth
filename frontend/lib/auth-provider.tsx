"use client";

import { SessionProvider, useSession } from "next-auth/react";
import type { ReactNode } from "react";
import { useEffect } from "react";
import { setAuthToken } from "./api";

// Wires the NextAuth session token into the API client on every session change.
function TokenSync() {
  const { data: session } = useSession();
  useEffect(() => {
    const token = (session as { accessToken?: string } | null)?.accessToken ?? null;
    setAuthToken(token);
  }, [session]);
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <TokenSync />
      {children}
    </SessionProvider>
  );
}
