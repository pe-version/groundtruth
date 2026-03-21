import type { FastifyInstance } from "fastify";

interface LoginBody {
  username: string;
  password: string;
}

export async function authRoutes(fastify: FastifyInstance) {
  // Login endpoint — generates a JWT for authenticated users.
  // In production, validate against a real user store (database, LDAP, etc.).
  fastify.post<{ Body: LoginBody }>(
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

      // TODO: Replace with real credential verification.
      // For now, accept any non-empty credentials for development.
      if (!username || !password) {
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      const token = fastify.jwt.sign(
        { sub: username },
        { expiresIn: "24h" }
      );

      return { token, userId: username };
    }
  );
}
