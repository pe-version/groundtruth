import { hash as argon2Hash, verify as argon2Verify } from "@node-rs/argon2";
import type { FastifyInstance, FastifyReply } from "fastify";

// argon2id with library defaults (memoryCost=19456 KiB, timeCost=2,
// parallelism=1) — these are the OWASP-recommended baseline settings as
// of 2024 and target ~80–150ms on modern hardware. Each hash embeds its
// own parameters, so future tuning doesn't invalidate stored hashes.

// Usernames are restricted to a narrow charset so they can never collide
// with any provider:id form we may add later, and to dodge Unicode
// look-alike bugs (e.g., "alice" vs "alıce"). We NFKC-normalize and
// lowercase before storage/lookup so case and width variants map to one
// canonical user.
const USERNAME_REGEX = /^[a-z0-9_.-]{3,64}$/;

const ACCESS_COOKIE = "groundtruth_token";
const REFRESH_COOKIE = "groundtruth_refresh";

// 15 min — matches the JwtService default. Cookie maxAge tracks the
// access token's lifetime so the browser drops the cookie at the same
// moment the server stops trusting the JWT.
const ACCESS_COOKIE_MAX_AGE = 15 * 60;

// 30 days — matches RefreshTokenStore default. Cookie path is scoped to
// /api/auth so the refresh token never gets sent to any other route.
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const REFRESH_COOKIE_PATH = "/api/auth";

function normalizeUsername(input: string): string {
  return input.normalize("NFKC").toLowerCase();
}

function setAuthCookies(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string
) {
  const secure = process.env.NODE_ENV === "production";
  reply
    .setCookie(ACCESS_COOKIE, accessToken, {
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: ACCESS_COOKIE_MAX_AGE,
    })
    .setCookie(REFRESH_COOKIE, refreshToken, {
      path: REFRESH_COOKIE_PATH,
      httpOnly: true,
      secure,
      sameSite: "strict",
      maxAge: REFRESH_COOKIE_MAX_AGE,
    });
}

function clearAuthCookies(reply: FastifyReply) {
  reply
    .clearCookie(ACCESS_COOKIE, { path: "/" })
    .clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

export async function authRoutes(fastify: FastifyInstance) {
  // Issue both an access JWT (15 min) and a refresh token (30 days, stored
  // hashed in Postgres). Sets cookies for the browser flow; also returns
  // the access token in the JSON body so non-browser clients (curl, the
  // smoke test) can use the Authorization header.
  async function issueSession(userId: string, reply: FastifyReply) {
    const accessToken = await fastify.jwt.signAccessToken(userId);
    const { token: refreshToken } = await fastify.refreshTokens.issue(userId);
    setAuthCookies(reply, accessToken, refreshToken);
    return { token: accessToken, userId };
  }

  fastify.post<{ Body: { username: string; password: string } }>(
    "/auth/register",
    {
      config: {
        public: true,
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 3, maxLength: 64 },
            password: { type: "string", minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const normalized = normalizeUsername(request.body.username);
      if (!USERNAME_REGEX.test(normalized)) {
        return reply.code(400).send({
          error: "Username must be 3-64 characters: letters, digits, _ . or -",
        });
      }

      const existing = await fastify.db.getUser(normalized);
      if (existing) {
        return reply.code(409).send({ error: "User already exists" });
      }

      const passwordHash = await argon2Hash(request.body.password);
      await fastify.db.createUser(normalized, passwordHash);

      return reply.send(await issueSession(normalized, reply));
    }
  );

  fastify.post<{ Body: { username: string; password: string } }>(
    "/auth/login",
    {
      config: {
        public: true,
        rateLimit: { max: 10, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 1, maxLength: 100 },
            password: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const normalized = normalizeUsername(request.body.username);

      const user = await fastify.db.getUser(normalized);
      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      // argon2.verify throws on malformed hashes; the catch lets a missing
      // or empty hash field naturally fail closed.
      let valid = false;
      try {
        valid = await argon2Verify(user.passwordHash, request.body.password);
      } catch {
        valid = false;
      }
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      return reply.send(await issueSession(normalized, reply));
    }
  );

  // Refresh: read the refresh cookie, mint a new access token, ROTATE the
  // refresh token (delete old, issue new). Single-use refresh tokens make
  // theft detectable: if both the legitimate user and an attacker present
  // the same refresh token, the second one to arrive sees a 401 and the
  // owner's session continues.
  fastify.post(
    "/auth/refresh",
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const cookie = request.cookies?.[REFRESH_COOKIE];
      if (!cookie) {
        return reply.code(401).send({ error: "No refresh token" });
      }

      const found = await fastify.refreshTokens.find(cookie);
      if (!found) {
        // Clear the stale cookie so the client doesn't keep retrying.
        clearAuthCookies(reply);
        return reply.code(401).send({ error: "Invalid refresh token" });
      }

      // Rotate: revoke the presented token before issuing a new one. If
      // the same token is presented twice (replay), the second attempt
      // hits the 401 path above.
      await fastify.refreshTokens.revoke(cookie);
      return reply.send(await issueSession(found.userId, reply));
    }
  );

  // Logout: revoke the presented refresh token (best-effort — a missing
  // cookie still returns 204). Access tokens are stateless, so the access
  // cookie just gets cleared on the client; the JWT itself remains
  // technically valid until its 15-minute expiry — that's the documented
  // tradeoff of stateless access tokens.
  fastify.post(
    "/auth/logout",
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
    },
    async (request, reply) => {
      const cookie = request.cookies?.[REFRESH_COOKIE];
      if (cookie) {
        await fastify.refreshTokens.revoke(cookie);
      }
      clearAuthCookies(reply);
      return reply.code(204).send();
    }
  );
}
