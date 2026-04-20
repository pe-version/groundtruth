import { pino, type Logger } from "pino";

// Shared structured logger. API and consumer both call this so every log
// line across services has the same JSON shape and can be filtered on the
// same fields (requestId, userId, documentId, component, ...).
//
// In development, pino-pretty makes the output human-readable. In prod
// (NODE_ENV=production) the raw JSON is emitted for aggregation.

export interface LoggerFields {
  requestId?: string;
  userId?: string;
  documentId?: string;
  [key: string]: unknown;
}

export function createLogger(component: string): Logger {
  const isProd = process.env.NODE_ENV === "production";
  return pino({
    name: component,
    level: process.env.LOG_LEVEL ?? "info",
    base: { component },
    ...(isProd
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l" },
          },
        }),
  });
}

export type { Logger };
