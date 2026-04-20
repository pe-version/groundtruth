import { MongoClient, Collection } from "mongodb";
import { DocumentStatus, type Document, type User } from "./types.js";

const DB_NAME = "direze";
const COLLECTION = "documents";
const USERS_COLLECTION = "users";

export class MongoDB {
  private client: MongoClient;
  private docs: Collection<Document>;
  private users: Collection<User>;

  constructor(client: MongoClient) {
    this.client = client;
    this.docs = client.db(DB_NAME).collection<Document>(COLLECTION);
    this.users = client.db(DB_NAME).collection<User>(USERS_COLLECTION);
  }

  static async connect(uri: string): Promise<MongoDB> {
    const client = new MongoClient(uri);
    await client.connect();
    await client.db(DB_NAME).command({ ping: 1 });
    return new MongoDB(client);
  }

  async disconnect(): Promise<void> {
    await this.client.close();
  }

  // ── User store ──────────────────────────────────────────────────────────────

  async createUser(username: string, passwordHash: string): Promise<void> {
    await this.users.insertOne({
      _id: username,
      passwordHash,
      createdAt: new Date(),
    } as any);
  }

  async getUser(username: string): Promise<User | null> {
    return this.users.findOne({ _id: username } as any) as Promise<User | null>;
  }

  // Idempotent upsert for OAuth-provisioned users. No password is stored —
  // these accounts can only be accessed via the oauth-token endpoint.
  async upsertOAuthUser(userId: string, provider: string): Promise<void> {
    await this.users.updateOne(
      { _id: userId } as any,
      {
        $setOnInsert: {
          passwordHash: "",
          oauthProvider: provider,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );
  }

  // ── Documents ───────────────────────────────────────────────────────────────

  async insertDocument(doc: Document): Promise<void> {
    await this.docs.insertOne(doc as any);
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.docs.findOne({ _id: id } as any) as Promise<Document | null>;
  }

  async listDocuments(userId: string): Promise<Document[]> {
    return this.docs
      .find({ userId })
      .sort({ uploadedAt: -1 })
      .toArray() as Promise<Document[]>;
  }

  async updateStatus(
    id: string,
    status: DocumentStatus,
    chunkCount: number
  ): Promise<void> {
    await this.docs.updateOne(
      { _id: id } as any,
      { $set: { status, chunkCount, updatedAt: new Date() } }
    );
  }

  async markFailed(id: string, errorMsg: string): Promise<void> {
    await this.docs.updateOne(
      { _id: id } as any,
      {
        $set: {
          status: DocumentStatus.Failed,
          errorMsg,
          updatedAt: new Date(),
        },
      }
    );
  }

  async deleteDocument(id: string): Promise<void> {
    await this.docs.deleteOne({ _id: id } as any);
  }

  async getStatusSummary(userId: string): Promise<
    { status: DocumentStatus; count: number }[]
  > {
    return this.docs
      .aggregate([
        { $match: { userId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, status: "$_id", count: 1 } },
      ])
      .toArray() as Promise<{ status: DocumentStatus; count: number }[]>;
  }
}
