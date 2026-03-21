import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { apiConfigSchema, consumerConfigSchema } from "../src/config.js";

describe("apiConfigSchema", () => {
  const validEnv = {
    MONGO_URI: "mongodb://localhost:27017/direze",
    POSTGRES_DSN: "postgres://direze:direze@localhost:5432/direze",
    OPENAI_API_KEY: "sk-test-key-12345",
    ANTHROPIC_API_KEY: "sk-ant-test-key-12345",
    KAFKA_BROKERS: "localhost:9092",
    JWT_SECRET: "this-is-a-long-enough-secret",
  };

  it("parses valid config with defaults", () => {
    const config = apiConfigSchema.parse(validEnv);
    expect(config.PORT).toBe(8080);
    expect(config.UPLOAD_DIR).toBe("/tmp/uploads");
    expect(config.CORS_ORIGINS).toBe("http://localhost:3000");
  });

  it("rejects missing required fields", () => {
    expect(() => apiConfigSchema.parse({})).toThrow();
  });

  it("rejects short JWT_SECRET", () => {
    expect(() =>
      apiConfigSchema.parse({ ...validEnv, JWT_SECRET: "short" })
    ).toThrow("at least 16 characters");
  });

  it("coerces PORT to number", () => {
    const config = apiConfigSchema.parse({ ...validEnv, PORT: "3000" });
    expect(config.PORT).toBe(3000);
  });
});

describe("consumerConfigSchema", () => {
  const validEnv = {
    MONGO_URI: "mongodb://localhost:27017/direze",
    POSTGRES_DSN: "postgres://direze:direze@localhost:5432/direze",
    OPENAI_API_KEY: "sk-test-key-12345",
    KAFKA_BROKERS: "localhost:9092",
  };

  it("parses valid config with defaults", () => {
    const config = consumerConfigSchema.parse(validEnv);
    expect(config.KAFKA_GROUP_ID).toBe("direze-consumer");
    expect(config.UPLOAD_DIR).toBe("/tmp/uploads");
  });

  it("rejects missing KAFKA_BROKERS", () => {
    const { KAFKA_BROKERS, ...rest } = validEnv;
    expect(() => consumerConfigSchema.parse(rest)).toThrow();
  });
});
