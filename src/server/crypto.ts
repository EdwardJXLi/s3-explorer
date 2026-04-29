import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function seal<T extends object>(payload: T, secret: string, ttlSeconds: number): string {
  const body = Buffer.from(
    JSON.stringify({
      payload,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds
    })
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function unseal<T extends object>(token: string | undefined, secret: string): T | null {
  if (!token) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const sig = Buffer.from(signature);
  const exp = Buffer.from(expected);
  if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      payload: T;
      exp: number;
    };
    if (!decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded.payload;
  } catch {
    return null;
  }
}
