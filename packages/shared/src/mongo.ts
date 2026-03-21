import { MongoClient, Collection, type WithId } from "mongodb";
import { DocumentStatus, type Document } from "./types.js";

const DB_NAME = "direze";
const COLLECTION = "documents";

export class MongoDB {
  private client: MongoClient;
  private docs: Collection<Document>;

  constructor(client: MongoClient) {
    this.client = client;
    this.docs = client.db(DB_NAME).collection<Document>(COLLECTION);
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

  async insertDocument(doc: Document): Promise<void> {
    await this.docs.insertOne(doc);
  }

  async getDocument(id: string): Promise<Document | null> {
    return this.docs.findOne({ _id: id } as any) as Promise<Document | null>;
  }

  async listDocuments(): Promise<Document[]> {
    return this.docs
      .find()
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

  async getStatusSummary(): Promise<
    { status: DocumentStatus; count: number }[]
  > {
    return this.docs
      .aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $project: { _id: 0, status: "$_id", count: 1 } },
      ])
      .toArray() as Promise<{ status: DocumentStatus; count: number }[]>;
  }
}
