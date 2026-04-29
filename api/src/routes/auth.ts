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

// A precomputed argon2id hash of a random sentinel value. We run
// `argon2Verify(SENTINEL_HASH, ...)` on the missing-user branch of
// /auth/login so the timing of "user doesn't exist" matches "user
// exists, password wrong" (~100ms). Without this, a remote attacker
// can enumerate valid usernames just by measuring response time.
//
// Lazily computed on first use so the cost lands once at module-warm
// time, not at every cold boot.
let sentinelHashPromise: Promise<string> | null = null;
function getSentinelHash(): Promise<string> {
  if (!sentinelHashPromise) {
    sentinelHashPromise = argon2Hash(
      "groundtruth-login-timing-sentinel-not-a-real-password"
    );
  }
  return sentinelHashPromise;
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

      // Constant-time-ish branching: we always run an argon2Verify so a
      // missing user takes the same wall-clock time as a wrong password.
      // The verify is against a sentinel hash on the missing-user path,
      // and against the user's real hash otherwise. Either way the
      // result decides authentication via a single boolean below.
      const hashToCheck =
        user && user.passwordHash ? user.passwordHash : await getSentinelHash();

      let verified = false;
      try {
        verified = await argon2Verify(hashToCheck, request.body.password);
      } catch {
        verified = false;
      }

      // OAuth-provisioned users have an empty passwordHash and so always
      // fall through to the sentinel branch — they cannot authenticate
      // via /auth/login regardless of timing.
      const valid = !!user && !!user.passwordHash && verified;
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      return reply.send(await issueSession(normalized, reply));
    }
  );

  // Refresh: atomically consume the presented refresh token and mint a
  // new pair. The consume() call performs the DELETE-RETURNING in a
  // single statement, so two concurrent /auth/refresh calls racing on
  // the same cookie cannot both succeed.
  //
  // If the same token is presented a second time, consume() reports a
  // *replay* — the cleartext is in two places that shouldn't both have
  // it. We revoke every refresh token for that user, forcing the
  // legitimate session to re-authenticate. Painful, but correct: a
  // replayed refresh token means the secret leaked.
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

      const outcome = await fastify.refreshTokens.consume(cookie);

      if (outcome.kind === "replay") {
        request.log.warn(
          { userId: outcome.userId },
          "Refresh-token replay detected; revoking all sessions for user"
        );
        await fastify.refreshTokens.revokeAllForUser(outcome.userId);
        clearAuthCookies(reply);
        return reply.code(401).send({ error: "Session revoked" });
      }

      if (outcome.kind === "missing") {
        clearAuthCookies(reply);
        return reply.code(401).send({ error: "Invalid refresh token" });
      }

      return reply.send(await issueSession(outcome.userId, reply));
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
