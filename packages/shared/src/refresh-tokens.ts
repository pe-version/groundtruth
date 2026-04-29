import { createHash, randomBytes } from "node:crypto";
import { Pool } from "pg";

// Server-side state for refresh-token rotation. Why this exists:
//
//   • Access tokens (JWT) are stateless and short-lived (15 min).
//   • A refresh token is a long-lived random secret stored only as a
//     SHA-256 hash. Its row in `refresh_tokens` is the token's existence;
//     revocation = DELETE on that row.
//   • Rotation is atomic: a single `DELETE … RETURNING user_id` consumes
//     the token. Two concurrent /auth/refresh calls cannot both succeed.
//   • Consumed-token history: every successful consume also records the
//     hash + user in `consumed_refresh_tokens`. A subsequent attempt with
//     the same hash hits the history table → replay → all refresh tokens
//     for that user get revoked, killing both the legitimate session and
//     the attacker's session. (Painful for the user, but the right
//     security posture: a presented-then-presented-again refresh token
//     means somebody other than the user has the secret.)
//
// Hashing the token before storage means a leaked DB dump cannot be used
// to mint access tokens; the attacker would still need the cleartext
// refresh secret, which exists only in the legitimate client's cookie.

export interface IssuedRefreshToken {
  token: string;        // cleartext — given to the client once, then forgotten
  expiresAt: Date;
}

export interface ConsumeResult {
  userId: string;
}

export type ConsumeOutcome =
  | { kind: "ok"; userId: string }
  | { kind: "replay"; userId: string }   // a confirmed replay; caller should revokeAllForUser
  | { kind: "missing" };                 // never existed, or expired without ever being consumed

export class RefreshTokenStore {
  // Default lifetime: 30 days. Long enough that an active user is never
  // forced to re-enter credentials; short enough that a stolen token has
  // a bounded window of damage.
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

  // Atomic rotation primitive. Performs the DELETE-RETURNING in one
  // statement; any concurrent caller racing on the same token will see
  // zero rows. Returns one of three outcomes the caller branches on.
  //
  // The outcome tagging exists so the caller can distinguish a benign
  // 401 (expired / never-existed) from a confirmed replay that warrants
  // revoking every other refresh token for that user.
  async consume(token: string): Promise<ConsumeOutcome> {
    const tokenHash = sha256(token);

    // Atomic step: try to consume. The CTE moves the row from
    // refresh_tokens to consumed_refresh_tokens in a single statement,
    // so a concurrent caller racing the same hash cannot both succeed.
    const { rows } = await this.pool.query<{ user_id: string }>(
      `WITH deleted AS (
         DELETE FROM refresh_tokens
         WHERE token_hash = $1 AND expires_at > NOW()
         RETURNING user_id, expires_at
       ), recorded AS (
         INSERT INTO consumed_refresh_tokens (token_hash, user_id, expires_at)
         SELECT $1, user_id, expires_at FROM deleted
         RETURNING user_id
       )
       SELECT user_id FROM recorded`,
      [tokenHash]
    );
    if (rows.length === 1) {
      return { kind: "ok", userId: rows[0].user_id };
    }

    // Zero rows from consume → either the token never existed, expired
    // and was reaped, or has already been consumed. Check the history.
    const replay = await this.pool.query<{ user_id: string }>(
      `SELECT user_id FROM consumed_refresh_tokens
       WHERE token_hash = $1 AND expires_at > NOW()`,
      [tokenHash]
    );
    if (replay.rows.length === 1) {
      return { kind: "replay", userId: replay.rows[0].user_id };
    }
    return { kind: "missing" };
  }

  // Used by /auth/logout. Idempotent — missing rows are not an error.
  // Note: logout intentionally does NOT use consume() because we don't
  // want a replayed-then-logged-out flow to nuke the user's other
  // sessions. Logout is a courtesy to the legitimate client.
  async revoke(token: string): Promise<void> {
    const tokenHash = sha256(token);
    await this.pool.query(
      `DELETE FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash]
    );
  }

  // The replay-recovery primitive. Drops every refresh token for the
  // given user. Called when consume() reports a replay.
  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM refresh_tokens WHERE user_id = $1`,
      [userId]
    );
  }

  // Janitor sweep: drop expired rows from both tables.
  async pruneExpired(): Promise<{ active: number; consumed: number }> {
    const active = await this.pool.query(
      `DELETE FROM refresh_tokens WHERE expires_at <= NOW()`
    );
    const consumed = await this.pool.query(
      `DELETE FROM consumed_refresh_tokens WHERE expires_at <= NOW()`
    );
    return { active: active.rowCount ?? 0, consumed: consumed.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
