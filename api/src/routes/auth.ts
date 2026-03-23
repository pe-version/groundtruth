import bcrypt from "bcryptjs";
import { timingSafeEqual } from "crypto";
import type { FastifyInstance } from "fastify";

const SALT_ROUNDS = 10;

export async function authRoutes(fastify: FastifyInstance) {
  // Register endpoint — creates a new user with hashed password stored in MongoDB.
  fastify.post<{ Body: { username: string; password: string } }>(
    "/auth/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 minute" },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          properties: {
            username: { type: "string", minLength: 1, maxLength: 100 },
            password: { type: "string", minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password } = request.body;

      const existing = await fastify.db.getUser(username);
      if (existing) {
        return reply.code(409).send({ error: "User already exists" });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      await fastify.db.createUser(username, passwordHash);

      const token = fastify.jwt.sign({ sub: username }, { expiresIn: "1h" });

      reply
        .setCookie("direze_token", token, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600,
        })
        .send({ token, userId: username });
    }
  );

  // Login endpoint — validates credentials against MongoDB and returns JWT.
  fastify.post<{ Body: { username: string; password: string } }>(
    "/auth/login",
    {
      config: {
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
      const { username, password } = request.body;

      const user = await fastify.db.getUser(username);
      if (!user) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = fastify.jwt.sign({ sub: username }, { expiresIn: "1h" });

      reply
        .setCookie("direze_token", token, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "strict",
          maxAge: 3600,
        })
        .send({ token, userId: username });
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
