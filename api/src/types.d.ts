import type { MongoDB, VectorStore, ApiConfig } from "@direze/shared";
import type { KafkaProducer } from "./services/kafka-producer.js";

declare module "fastify" {
  interface FastifyInstance {
    db: MongoDB;
    vectorStore: VectorStore;
    kafkaProducer: KafkaProducer;
    config: ApiConfig;
  }

  interface FastifyContextConfig {
    public?: boolean;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string };
    user: { sub: string };
  }
}
