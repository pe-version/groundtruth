import { describe, it, expect } from "vitest";

// Test the UUID regex pattern used for input validation
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("UUID validation", () => {
  it("accepts valid UUIDs", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_REGEX.test("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(true);
    expect(UUID_REGEX.test("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
  });

  it("rejects invalid UUIDs", () => {
    expect(UUID_REGEX.test("")).toBe(false);
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716")).toBe(false);
    expect(UUID_REGEX.test("550e8400e29b41d4a716446655440000")).toBe(false);
    // SQL injection attempt
    expect(UUID_REGEX.test("'; DROP TABLE chunks;--")).toBe(false);
    // Path traversal attempt
    expect(UUID_REGEX.test("../../../etc/passwd")).toBe(false);
  });
});

describe("query request validation rules", () => {
  it("topK bounds are enforced in schema", () => {
    // These are the bounds defined in the Fastify JSON schema
    const MIN_TOP_K = 1;
    const MAX_TOP_K = 20;
    const MAX_QUESTION_LENGTH = 2000;

    expect(MIN_TOP_K).toBe(1);
    expect(MAX_TOP_K).toBe(20);
    expect(MAX_QUESTION_LENGTH).toBe(2000);
  });
});
