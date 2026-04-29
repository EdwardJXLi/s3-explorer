import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";

export type AuthMode = "none" | "simple" | "oidc";

const env = process.env;

function packageVersion(): string {
  try {
    const packageJson = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version?: unknown };
    return typeof packageJson.version === "string" && packageJson.version.trim() ? packageJson.version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalPositiveInt(value: string | undefined, fallback: number): number | undefined {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed <= 0 ? undefined : parsed;
}

export const config = {
  nodeEnv: env.NODE_ENV ?? "development",
  host: env.HOST ?? "0.0.0.0",
  port: int(env.PORT, 8080),
  publicBaseUrl: env.PUBLIC_BASE_URL,
  trustProxy: bool(env.TRUST_PROXY, true),

  app: {
    name: env.APP_NAME ?? "S3 Explorer",
    iconUrl: env.APP_ICON_URL,
    defaultTheme: env.APP_DEFAULT_THEME === "dark" ? "dark" : "light",
    version: env.APP_VERSION || packageVersion(),
    showPoweredByFooter: bool(env.SHOW_POWERED_BY_FOOTER, true)
  },

  storage: {
    endpoint: env.STORAGE_ENDPOINT,
    region: env.STORAGE_REGION ?? "us-east-1",
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
    sessionToken: env.STORAGE_SESSION_TOKEN,
    forcePathStyle: bool(env.STORAGE_FORCE_PATH_STYLE, true),
    buckets: csv(env.STORAGE_BUCKETS),
    defaultBucket: env.STORAGE_DEFAULT_BUCKET,
    allowBucketList: bool(env.STORAGE_ALLOW_BUCKET_LIST, true),
    maxUploadBytes: optionalPositiveInt(env.STORAGE_MAX_UPLOAD_BYTES, 512 * 1024 * 1024),
    proxyDownloadsEnabled: bool(env.ENABLE_PROXY_DOWNLOADS, false),
    defaultPresignSeconds: int(env.DEFAULT_PRESIGN_SECONDS, 300),
    maxPresignSeconds: int(env.MAX_PRESIGN_SECONDS, 60 * 60 * 24 * 7)
  },

  auth: {
    mode: (env.AUTH_MODE ?? "simple") as AuthMode,
    sessionSecret: env.SESSION_SECRET ?? "change-me-in-production",
    sessionCookieName: env.SESSION_COOKIE_NAME ?? "object_explorer_session",
    oauthCookieName: env.OAUTH_COOKIE_NAME ?? "object_explorer_oauth",
    sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 60 * 60 * 12),
    cookieSecure: bool(env.COOKIE_SECURE, env.PUBLIC_BASE_URL?.startsWith("https://") ?? false),
    adminEmails: csv(env.ADMIN_EMAILS).map((email) => email.toLowerCase()),

    simple: {
      username: env.SIMPLE_AUTH_USERNAME ?? "admin",
      password: env.SIMPLE_AUTH_PASSWORD,
      email: env.SIMPLE_AUTH_EMAIL ?? env.SIMPLE_AUTH_USERNAME ?? "admin",
      admin: bool(env.SIMPLE_AUTH_ADMIN, true)
    },
    none: {
      role: (env.AUTH_NONE_ROLE === "viewer" ? "viewer" : "admin") as "viewer" | "admin"
    },

    oidc: {
      issuerUrl: env.OIDC_ISSUER_URL,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      redirectUri: env.OIDC_REDIRECT_URI,
      loginButtonText: env.OIDC_LOGIN_BUTTON_TEXT ?? "Continue with SSO",
      loginSubtitle: env.LOGIN_SUBTITLE ?? "Sign in to browse and manage configured buckets.",
      scopes: env.OIDC_SCOPES ?? "openid email profile",
      emailClaim: env.OIDC_EMAIL_CLAIM ?? "email",
      nameClaim: env.OIDC_NAME_CLAIM ?? "name",
      roleClaim: env.OIDC_ROLE_CLAIM ?? "roles",
      adminRoleValues: csv(env.OIDC_ADMIN_ROLE_VALUES ?? "admin"),
      extraAuthorizeParams: Object.fromEntries(
        csv(env.OIDC_EXTRA_AUTHORIZE_PARAMS).map((pair) => {
          const [key, ...rest] = pair.split("=");
          return [key, rest.join("=")];
        })
      )
    }
  }
};

export function validateConfig(): string[] {
  const problems: string[] = [];

  if (config.auth.sessionSecret === "change-me-in-production" && config.nodeEnv === "production") {
    problems.push("SESSION_SECRET must be set in production.");
  }

  if (config.auth.mode === "simple" && !config.auth.simple.password) {
    problems.push("SIMPLE_AUTH_PASSWORD must be set when AUTH_MODE=simple.");
  }

  if (config.auth.mode === "oidc") {
    if (!config.auth.oidc.issuerUrl) problems.push("OIDC_ISSUER_URL is required when AUTH_MODE=oidc.");
    if (!config.auth.oidc.clientId) problems.push("OIDC_CLIENT_ID is required when AUTH_MODE=oidc.");
  }

  if (
    config.storage.buckets.length > 0 &&
    (!config.storage.defaultBucket || !config.storage.buckets.includes(config.storage.defaultBucket))
  ) {
    config.storage.defaultBucket = config.storage.buckets[0];
  }

  return problems;
}
