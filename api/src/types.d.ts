import type {
  MetadataStore,
  VectorStore,
  JobQueue,
  RefreshTokenStore,
  ApiConfig,
} from "@groundtruth/shared";
import type { JwtService } from "./services/jwt.js";
import type { LlmProvider } from "./services/llm.js";

declare module "fastify" {
  interface FastifyInstance {
    db: MetadataStore;
    vectorStore: VectorStore;
    jobQueue: JobQueue;
    refreshTokens: RefreshTokenStore;
    jwt: JwtService;
    llm: LlmProvider;
    config: ApiConfig;
  }

  interface FastifyContextConfig {
    public?: boolean;
  }

  interface FastifyRequest {
    user?: { sub: string };
  }
}
