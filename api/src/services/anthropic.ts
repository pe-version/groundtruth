import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

const SYSTEM_PROMPT = `You are a helpful assistant. Answer the user's question using ONLY the provided document excerpts.
If the answer cannot be found in the excerpts, say so clearly.
Always be concise and cite which excerpt supports your answer.`;

/**
 * Streams Claude's response as an async iterable of text tokens.
 * Used by both the SSE endpoint (token-by-token) and the non-streaming
 * endpoint (collected into a single string).
 */
export async function* streamClaude(
  context: string,
  question: string
): AsyncIterable<string> {
  const userPrompt = `Document excerpts:\n\n${context}\n\nQuestion: ${question}`;

  const stream = getClient().messages.stream({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
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
