import { z } from "zod";

const baseSchema = z.object({
  MONGO_URI: z.string().min(1),
  POSTGRES_DSN: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
});

export const apiConfigSchema = baseSchema.extend({
  PORT: z.coerce.number().default(8080),
  ANTHROPIC_API_KEY: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  UPLOAD_DIR: z.string().default("/tmp/uploads"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
});

export const consumerConfigSchema = baseSchema.extend({
  KAFKA_BROKERS: z.string().min(1),
  KAFKA_GROUP_ID: z.string().default("direze-consumer"),
  UPLOAD_DIR: z.string().default("/tmp/uploads"),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;
export type ConsumerConfig = z.infer<typeof consumerConfigSchema>;

export function loadApiConfig(): ApiConfig {
  return apiConfigSchema.parse(process.env);
}

export function loadConsumerConfig(): ConsumerConfig {
  return consumerConfigSchema.parse(process.env);
}
