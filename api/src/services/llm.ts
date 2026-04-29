// Provider-agnostic LLM interface.
//
// The query path streams tokens from `LlmProvider.streamAnswer(...)` and
// doesn't care which provider implements it. Today there's exactly one
// implementation (Anthropic Claude); the abstraction exists so that
// swapping in a local-model provider (Ollama, llama.cpp) or a different
// hosted vendor (OpenAI, Together) means writing a new class, not
// editing the route or the streaming SSE machinery.
//
// We deliberately do NOT abstract over more than streaming text in a
// system+user shape — every additional capability we'd promise here
// (function calling, vision, structured outputs) creates a wider
// surface to keep providers consistent on. Add one knob at a time.

export interface LlmProvider {
  /** Friendly name for logs and the README; not used to dispatch. */
  readonly name: string;

  /**
   * Stream the model's response as text deltas. The caller is responsible
   * for assembling them (or piping them to an SSE response).
   */
  streamAnswer(input: LlmInput): AsyncIterable<string>;
}

export interface LlmInput {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}
