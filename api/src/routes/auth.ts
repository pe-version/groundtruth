import bcrypt from "bcryptjs";
import { timingSafeEqual } from "crypto";
import type { FastifyInstance } from "fastify";

const SALT_ROUNDS = 10;

// Usernames are restricted to a narrow charset so they can never collide with
// the OAuth id namespace (`provider:providerId`) or trip Unicode-normalization
// lookalike bugs (e.g., "alice" vs "alıce"). We also NFKC-normalize and
// lowercase before storage/lookup so case and width variants map to one user.
const USERNAME_REGEX = /^[a-z0-9_.-]{3,64}$/;

function normalizeUsername(input: string): string {
  return input.normalize("NFKC").toLowerCase();
}

export async function authRoutes(fastify: FastifyInstance) {
  // Register endpoint — creates a new user with hashed password stored in MongoDB.
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

      const passwordHash = await bcrypt.hash(request.body.password, SALT_ROUNDS);
      await fastify.db.createUser(normalized, passwordHash);

      const token = fastify.jwt.sign({ sub: normalized }, { expiresIn: "1h" });

      reply
        .setCookie("direze_token", token, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600,
        })
        .send({ token, userId: normalized });
    }
  );

  // Login endpoint — validates credentials against MongoDB and returns JWT.
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

      const valid = await bcrypt.compare(request.body.password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = fastify.jwt.sign({ sub: normalized }, { expiresIn: "1h" });

      reply
        .setCookie("direze_token", token, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600,
        })
        .send({ token, userId: normalized });
    }
  );

  // OAuth token endpoint — server-to-server only.
  //
  // Called exclusively by the NextAuth server-side JWT callback after a
  // successful OAuth login. The caller presents OAUTH_SERVER_SECRET (a shared
  // secret that never passes through the browser) to prove it is the trusted
  // NextAuth server. In exchange it receives a standard API JWT, which NextAuth
  // stores in the session and the frontend uses for all subsequent requests.
  //
  // OAuth users have no password stored in MongoDB — their passwordHash field
  // is an empty string. This means they cannot authenticate via /auth/login
  // even if an attacker knows their userId; the only path to a JWT is through
  // this endpoint, which requires the server secret.
  //
  // Why not share a password? See ADR in README § Authentication.
  fastify.post<{ Body: { provider: string; providerId: string; secret: string } }>(
    "/auth/oauth-token",
    {
      config: {
        public: true,
        rateLimit: { max: 30, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["provider", "providerId", "secret"],
          properties: {
            provider:   { type: "string", minLength: 1, maxLength: 50 },
            providerId: { type: "string", minLength: 1, maxLength: 200 },
            secret:     { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const { provider, providerId, secret } = request.body;
      const serverSecret = fastify.config.OAUTH_SERVER_SECRET;

      if (!serverSecret) {
        return reply.code(503).send({ error: "OAuth login not configured" });
      }

      // Timing-safe comparison prevents secret enumeration via response time.
      const provided = Buffer.from(secret);
      const expected = Buffer.from(serverSecret);
      const valid =
        provided.length === expected.length &&
        timingSafeEqual(provided, expected);

      if (!valid) {
        return reply.code(401).send({ error: "Unauthorized" });
      }

      const userId = `${provider}:${providerId}`;
      await fastify.db.upsertOAuthUser(userId, provider);

      const token = fastify.jwt.sign({ sub: userId }, { expiresIn: "1h" });
      return reply.send({ token, userId });
    }
  );
}
