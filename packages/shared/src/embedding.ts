import OpenAI from "openai";

const MODEL = "text-embedding-3-small";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export async function embedText(text: string): Promise<number[]> {
  const response = await getClient().embeddings.create({
    model: MODEL,
    input: text,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error("Empty embedding response from OpenAI");
  }

  return response.data[0].embedding;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const response = await getClient().embeddings.create({
    model: MODEL,
    input: texts,
  });

  if (!response.data || response.data.length === 0) {
    throw new Error("Empty embedding response from OpenAI");
  }

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}
