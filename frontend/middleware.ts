export { default } from "next-auth/middleware";

// Protect all routes except login, register, static assets, and NextAuth internals.
export const config = {
  matcher: ["/((?!login|register|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
