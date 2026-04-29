import Anthropic from "@anthropic-ai/sdk";
import type { LlmInput, LlmProvider } from "./llm.js";

const DEFAULT_MAX_TOKENS = 1024;

// Concrete LlmProvider backed by Anthropic Claude. The query route
// references this through the LlmProvider interface, not directly, so
// swapping in a different vendor or a local model means writing one
// new class — not changing any caller.
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private readonly model: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      // Bound a hung upstream: a stream that produces no tokens for 60s
      // is killed and surfaces as an error the SSE route's catch block
      // handles. The SDK's retries are disabled — failed jobs go to the
      // queue's failed state on first error, so hidden retries would
      // only delay the post-mortem.
      timeout: 60_000,
      maxRetries: 0,
    });
    this.model = opts.model ?? "claude-sonnet-4-6";
  }

  async *streamAnswer(input: LlmInput): AsyncIterable<string> {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: input.systemPrompt,
      messages: [{ role: "user", content: input.userPrompt }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
