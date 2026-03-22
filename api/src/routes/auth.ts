import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";

const SALT_ROUNDS = 10;

// In-memory user store for development.
// In production, replace with a database-backed store.
const users = new Map<string, { passwordHash: string }>();

export async function authRoutes(fastify: FastifyInstance) {
  // Register endpoint — creates a new user with hashed password.
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

      if (users.has(username)) {
        return reply.code(409).send({ error: "User already exists" });
      }

      const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
      users.set(username, { passwordHash });

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

  // Login endpoint — validates credentials and returns JWT.
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

      const user = users.get(username);
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
}
