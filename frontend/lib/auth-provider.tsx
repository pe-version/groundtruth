"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  getAuthToken,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  restoreSession,
  subscribeAuth,
} from "./api";

// Context shape exposed to the rest of the app. Pages use `useAuth()` to
// read state and trigger flows; they don't talk to lib/api.ts directly
// for auth concerns.
interface AuthContextValue {
  // null = unauthenticated; string = current access token (proxy for "logged in")
  token: string | null;
  status: "loading" | "authenticated" | "unauthenticated";
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const PUBLIC_PATHS = new Set(["/login", "/register", "/"]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState<string | null>(getAuthToken);
  const [status, setStatus] = useState<AuthContextValue["status"]>("loading");
  const bootstrapped = useRef(false);

  // Mirror lib/api.ts's module-local token into React state so pages
  // re-render when login/refresh/logout happen — including silent
  // refresh from a 401 retry deep in the call stack.
  useEffect(() => {
    return subscribeAuth((next) => setToken(next));
  }, []);

  // On first mount, attempt a silent refresh. If the refresh cookie is
  // valid, we land in `authenticated`; otherwise `unauthenticated` and
  // protected pages bounce to /login below.
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    restoreSession()
      .then((ok) => setStatus(ok ? "authenticated" : "unauthenticated"))
      .catch(() => setStatus("unauthenticated"));
  }, []);

  // Once bootstrap finishes (or any subsequent state change lands here),
  // redirect unauthenticated users out of protected pages.
  useEffect(() => {
    if (status === "loading") return;
    const isPublic = PUBLIC_PATHS.has(pathname);
    if (status === "unauthenticated" && !isPublic) {
      router.replace("/login");
    }
  }, [status, pathname, router]);

  // Keep status in sync with the token mirror — e.g., a successful login
  // sets the token, which should flip status without waiting for the
  // bootstrap effect.
  useEffect(() => {
    if (status === "loading") return;
    setStatus(token ? "authenticated" : "unauthenticated");
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback(async (username: string, password: string) => {
    await apiLogin(username, password);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    await apiRegister(username, password);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    router.push("/login");
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({ token, status, login, register, logout }),
    [token, status, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
