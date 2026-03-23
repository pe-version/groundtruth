import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GitHubProvider from "next-auth/providers/github";

const API_URL = process.env.NEXTAUTH_API_URL ?? "http://localhost:8080";

export const authOptions: NextAuthOptions = {
  providers: [
    // GitHub OAuth — zero password management, trusted identity provider.
    // Users are auto-provisioned in the API on first OAuth login.
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          GitHubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),

    // Username/password fallback — calls the API which stores bcrypt hashes in MongoDB.
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.username || !credentials?.password) return null;

        const res = await fetch(`${API_URL}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: credentials.username,
            password: credentials.password,
          }),
        });

        if (!res.ok) return null;

        const data = await res.json();
        return {
          id: data.userId ?? credentials.username,
          name: credentials.username,
          // Pass through the API's JWT so the session holds the canonical token.
          accessToken: data.token,
        };
      },
    }),
  ],

  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        token.sub = user.id;
        // For credentials: the API already issued the JWT — use it directly.
        if ((user as { accessToken?: string }).accessToken) {
          token.accessToken = (user as { accessToken?: string }).accessToken;
        }
      }
      // For OAuth providers: exchange the OAuth identity for an API JWT via the
      // server-to-server oauth-token endpoint. OAUTH_SERVER_SECRET authenticates
      // this call — it never passes through the browser.
      if (account?.provider && token.sub && !token.accessToken) {
        const oauthRes = await fetch(`${API_URL}/api/auth/oauth-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: account.provider,
            providerId: token.sub,
            secret: process.env.OAUTH_SERVER_SECRET ?? "",
          }),
        });
        if (oauthRes.ok) {
          const data = await oauthRes.json();
          token.sub = data.userId;
          token.accessToken = data.token;
        }
      }
      return token;
    },

    async session({ session, token }) {
      session.user = session.user ?? {};
      (session as { accessToken?: string }).accessToken =
        token.accessToken as string | undefined;
      return session;
    },
  },

  session: {
    strategy: "jwt",
    maxAge: 3600, // 1 hour — matches API token expiry
  },

  pages: {
    signIn: "/login",
  },

  secret: process.env.NEXTAUTH_SECRET,
};
