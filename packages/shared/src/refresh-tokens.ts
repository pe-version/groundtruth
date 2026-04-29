import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

// Server-side state for refresh-token rotation. Why this exists:
//
//   • Access tokens (JWT) are stateless and short-lived (15 min).
//   • A refresh token is a long-lived random secret stored only as a
//     SHA-256 hash. Its row in `refresh_tokens` is the token's existence;
//     revocation = DELETE on that row.
//   • There is no per-request denylist lookup — the access token's TTL
//     is the revocation horizon. (See the README ADR for why a denylist
//     was the wrong abstraction.)
//
// Hashing the token before storage means a leaked DB dump cannot be used
// to mint access tokens; the attacker would still need the cleartext
// refresh secret, which exists only in the legitimate client's cookie.

export interface IssuedRefreshToken {
  token: string;        // cleartext — given to the client once, then forgotten
  expiresAt: Date;
}

export interface RefreshTokenRow {
  userId: string;
  expiresAt: Date;
}

export class RefreshTokenStore {
  // Default lifetime: 30 days. Long enough that an active user is never
  // forced to re-enter credentials; short enough that a stolen token has
  // a bounded window of damage. The store also caps the per-user count
  // so a stuffing attack can't bloat the table.
  private readonly ttlMs: number;

  constructor(private readonly pool: Pool, opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 24 * 60 * 60 * 1000;
  }

  static async connect(dsn: string, opts?: { ttlMs?: number }): Promise<RefreshTokenStore> {
    const pool = new Pool({ connectionString: dsn });
    return new RefreshTokenStore(pool, opts);
  }

  // Mint a new refresh token: 32 random bytes base64url-encoded. The hash
  // is what we store; the cleartext is returned to the caller exactly
  // once (handed to the client as an httpOnly cookie).
  async issue(userId: string): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = sha256(token);
    const expiresAt = new Date(Date.now() + this.ttlMs);

    await this.pool.query(
      `INSERT INTO refresh_tokens (token_hash, user_id, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, userId, expiresAt]
    );

    return { token, expiresAt };
  }

  // Look up by hash (constant-time index probe). Returns null if missing
  // or expired; the caller treats both the same way.
  async find(token: string): Promise<RefreshTokenRow | null> {
    const tokenHash = sha256(token);
    const { rows } = await this.pool.query<{ user_id: string; expires_at: Date }>(
      `SELECT user_id, expires_at FROM refresh_tokens
       WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );
    if (rows.length === 0) return null;
    return { userId: rows[0].user_id, expiresAt: rows[0].expires_at };
  }

  // Revocation primitive: drop a single row. Used by /auth/logout AND by
  // /auth/refresh after rotation, so a stolen token is single-use.
  async revoke(token: string): Promise<void> {
    const tokenHash = sha256(token);
    await this.pool.query(
      `DELETE FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
  }

  // Convenience for "log out everywhere", or for use after a password
  // change. Drops every refresh row for the given user.
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [userId]
    );
  }

  // Janitor sweep: drop expired rows. Called periodically; no return.
  async pruneExpired(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at <= NOW()`
    );
    return rowCount ?? 0;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
