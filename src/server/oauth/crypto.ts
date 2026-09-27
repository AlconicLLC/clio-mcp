import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const VERSION = "v1";

/** 256-bit random value, base64url. Used for access/refresh tokens, codes and one-time form tokens. */
export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

/** Tokens are looked up by hash so a database dump yields nothing usable. */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * AES-256-GCM with `aad` bound in, so a ciphertext copied onto another row
 * (another user) fails to decrypt instead of handing over that user's tokens.
 */
export function encryptJson(key: Buffer, value: unknown, aad: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

export function decryptJson<T>(key: Buffer, blob: string, aad: string): T {
  const [version, payload] = blob.split(":", 2);
  if (version !== VERSION || !payload) throw new Error("Unsupported ciphertext format.");
  const raw = Buffer.from(payload, "base64");
  if (raw.length <= IV_LENGTH + TAG_LENGTH) throw new Error("Ciphertext is truncated.");
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}
