import type { FastifyInstance } from "fastify";

// JWT auth is configured in index.ts via @fastify/jwt plugin and onRequest hook.
// This file provides helper utilities for auth-related operations.

export function generateToken(
  fastify: FastifyInstance,
  payload: { sub: string }
): string {
  return fastify.jwt.sign(payload, { expiresIn: "24h" });
}
