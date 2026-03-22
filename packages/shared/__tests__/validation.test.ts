import { describe, it, expect } from "vitest";
import { UUID_REGEX, UUID_PATTERN } from "../src/validation.js";

describe("UUID_REGEX", () => {
  it("accepts valid UUIDs", () => {
    expect(UUID_REGEX.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(UUID_REGEX.test("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
  });

  it("rejects invalid strings", () => {
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
    expect(UUID_REGEX.test("")).toBe(false);
  });
});

describe("UUID_PATTERN", () => {
  it("is the regex source string", () => {
    expect(UUID_PATTERN).toBe(UUID_REGEX.source);
  });
});
