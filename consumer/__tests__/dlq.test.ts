import { describe, it, expect, vi, beforeEach } from "vitest";
import { DeadLetterQueue } from "../src/dlq.js";

const mockSend = vi.fn().mockResolvedValue(undefined);
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);

vi.mock("kafkajs", () => ({
  Kafka: vi.fn().mockImplementation(() => ({
    producer: () => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      send: mockSend,
    }),
    consumer: vi.fn(),
  })),
}));

import { Kafka } from "kafkajs";

describe("DeadLetterQueue", () => {
  let dlq: DeadLetterQueue;

  beforeEach(async () => {
    vi.clearAllMocks();
    const kafka = new Kafka({ clientId: "test", brokers: ["localhost:9092"] });
    dlq = new DeadLetterQueue(kafka);
    await dlq.connect();
  });

  it("connects the producer", () => {
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it("sends messages to raw-docs-dlq topic with correct shape", async () => {
    const originalMessage = {
      key: "doc-123",
      value: '{"documentId":"doc-123"}',
      topic: "raw-docs",
      partition: 0,
      offset: "42",
    };
    const error = new Error("Processing failed");
    error.stack = "Error: Processing failed\n    at test.ts:1";

    await dlq.send(originalMessage, error);

    expect(mockSend).toHaveBeenCalledOnce();
    const call = mockSend.mock.calls[0][0];
    expect(call.topic).toBe("raw-docs-dlq");
    expect(call.messages).toHaveLength(1);

    const msg = call.messages[0];
    expect(msg.key).toBe("doc-123");

    const payload = JSON.parse(msg.value);
    expect(payload.originalTopic).toBe("raw-docs");
    expect(payload.originalPartition).toBe(0);
    expect(payload.originalOffset).toBe("42");
    expect(payload.payload).toBe('{"documentId":"doc-123"}');
    expect(payload.error).toBe("Processing failed");
    expect(payload.stack).toContain("Processing failed");
    expect(payload.failedAt).toBeDefined();
  });

  it("handles null key gracefully", async () => {
    const originalMessage = {
      key: null,
      value: "bad-json",
      topic: "raw-docs",
      partition: 1,
      offset: "10",
    };

    await dlq.send(originalMessage, new Error("Parse error"));

    const msg = mockSend.mock.calls[0][0].messages[0];
    expect(msg.key).toBeUndefined();
  });

  it("disconnects the producer", async () => {
    await dlq.disconnect();
    expect(mockDisconnect).toHaveBeenCalledOnce();
  });
});
