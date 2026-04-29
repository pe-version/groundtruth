import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from "jose";

// Replaces @fastify/jwt + jsonwebtoken. jose is a smaller, modern, audited
// JWT library backed by Web Crypto. Keeps us on a single library for both
// access tokens here and (future) refresh-token rotation.

export interface AccessClaims extends JWTPayload {
  sub: string;
}

const ALG = "HS256";

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

export class JwtService {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    // The config schema enforces ≥32 chars; this guards against accidental
    // misuse if construction ever happens outside that path.
    if (secret.length < 32) {
      throw new Error("JWT secret must be at least 32 characters");
    }
    this.key = new TextEncoder().encode(secret);
  }

  // 15-minute access token. The short lifetime is what makes a refresh-
  // token + denylist scheme unnecessary: revocation falls out naturally
  // when the access token expires and the refresh token is the only
  // mechanism the server has to mint a new one.
  async signAccessToken(sub: string, ttl = "15m"): Promise<string> {
    return await new SignJWT({ sub })
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt()
      .setExpirationTime(ttl)
      .sign(this.key);
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALG],
      });
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new InvalidTokenError("missing sub claim");
      }
      return payload as AccessClaims;
    } catch (err) {
      if (err instanceof joseErrors.JOSEError) {
        throw new InvalidTokenError(err.message);
      }
      throw err;
    }
  }
}
