import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { randomToken, seal, sha256Base64Url, unseal } from "./crypto.js";
import type { AuthUser, Role } from "./types.js";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
}

interface OAuthState {
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectTo: string;
}

let discoveryCache: Promise<OidcDiscovery> | undefined;

function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function baseUrl(request: FastifyRequest): string {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, "");
  const proto = (request.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ?? "http";
  return `${proto}://${request.headers.host}`;
}

function oidcRedirectUri(request: FastifyRequest): string {
  return config.auth.oidc.redirectUri ?? `${baseUrl(request)}/api/auth/oidc/callback`;
}

async function getDiscovery(): Promise<OidcDiscovery> {
  if (!config.auth.oidc.issuerUrl) throw new Error("OIDC issuer is not configured.");
  discoveryCache ??= fetch(
    `${config.auth.oidc.issuerUrl.replace(/\/+$/, "")}/.well-known/openid-configuration`
  ).then(async (response) => {
    if (!response.ok) throw new Error(`OIDC discovery failed with status ${response.status}.`);
    return (await response.json()) as OidcDiscovery;
  });
  return discoveryCache;
}

function getClaim(payload: Record<string, unknown>, claim: string): unknown {
  if (!claim.includes(".")) return payload[claim];
  return claim.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
    return undefined;
  }, payload);
}

function firstStringClaim(payload: Record<string, unknown>, claims: string[]): string {
  for (const claim of claims) {
    const value = getClaim(payload, claim);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function claimValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(claimValues);
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => Boolean(entry))
      .map(([key]) => key);
  }
  return [];
}

function roleFromClaims(email: string, payload: Record<string, unknown>): Role {
  if (config.auth.adminEmails.includes(email.toLowerCase())) return "admin";

  const roles = claimValues(getClaim(payload, config.auth.oidc.roleClaim)).map((role) => role.toLowerCase());
  const adminRoles = config.auth.oidc.adminRoleValues.map((role) => role.toLowerCase());
  return roles.some((role) => adminRoles.includes(role)) ? "admin" : "viewer";
}

function setSession(reply: FastifyReply, user: AuthUser) {
  reply.setCookie(
    config.auth.sessionCookieName,
    seal(user, config.auth.sessionSecret, config.auth.sessionTtlSeconds),
    {
      httpOnly: true,
      secure: config.auth.cookieSecure,
      sameSite: "lax",
      path: "/",
      maxAge: config.auth.sessionTtlSeconds
    }
  );
}

function clearCookie(reply: FastifyReply, name: string) {
  reply.clearCookie(name, { path: "/" });
}

export function getUser(request: FastifyRequest): AuthUser | null {
  if (config.auth.mode === "none") {
    return {
      email: "local",
      name: "Local user",
      role: config.auth.none.role,
      provider: "none"
    };
  }
  return unseal<AuthUser>(request.cookies[config.auth.sessionCookieName], config.auth.sessionSecret);
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = getUser(request);
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  return user;
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthUser | null> {
  const user = await requireUser(request, reply);
  if (!user) return null;
  if (user.role !== "admin") {
    reply.code(403).send({ error: "Admin permission required" });
    return null;
  }
  return user;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.get("/api/auth/config", async () => ({
    mode: config.auth.mode,
    simpleEnabled: config.auth.mode === "simple",
    oidcEnabled: config.auth.mode === "oidc",
    oidcLoginButtonText: config.auth.oidc.loginButtonText,
    loginSubtitle: config.auth.oidc.loginSubtitle,
    app: config.app
  }));

  app.get("/api/auth/me", async (request, reply) => {
    const user = getUser(request);
    if (!user) return reply.code(401).send({ error: "Authentication required" });
    return { user };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/simple/login", async (request, reply) => {
    if (config.auth.mode !== "simple") return reply.code(404).send({ error: "Simple authentication is disabled" });
    const { username, password } = request.body ?? {};

    if (!safeEqual(username, config.auth.simple.username) || !safeEqual(password, config.auth.simple.password)) {
      return reply.code(401).send({ error: "Invalid username or password" });
    }

    const email = config.auth.simple.email.toLowerCase();
    const user: AuthUser = {
      email,
      name: config.auth.simple.username,
      role: config.auth.simple.admin || config.auth.adminEmails.includes(email) ? "admin" : "viewer",
      provider: "simple"
    };
    setSession(reply, user);
    return { user };
  });

  app.post("/api/auth/logout", async (_request, reply) => {
    clearCookie(reply, config.auth.sessionCookieName);
    clearCookie(reply, config.auth.oauthCookieName);
    return { ok: true };
  });

  app.get<{ Querystring: { redirect?: string } }>("/api/auth/oidc/login", async (request, reply) => {
    if (config.auth.mode !== "oidc") return reply.code(404).send({ error: "OIDC authentication is disabled" });
    if (!config.auth.oidc.clientId) return reply.code(500).send({ error: "OIDC client is not configured" });

    const discovery = await getDiscovery();
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    const redirectTo = request.query.redirect?.startsWith("/") ? request.query.redirect : "/";
    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.auth.oidc.clientId,
      redirect_uri: oidcRedirectUri(request),
      scope: config.auth.oidc.scopes,
      state,
      nonce,
      code_challenge: sha256Base64Url(codeVerifier),
      code_challenge_method: "S256",
      ...config.auth.oidc.extraAuthorizeParams
    });

    reply.setCookie(
      config.auth.oauthCookieName,
      seal<OAuthState>({ state, nonce, codeVerifier, redirectTo }, config.auth.sessionSecret, 10 * 60),
      {
        httpOnly: true,
        secure: config.auth.cookieSecure,
        sameSite: "lax",
        path: "/",
        maxAge: 10 * 60
      }
    );
    return reply.redirect(`${discovery.authorization_endpoint}?${params.toString()}`);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/oidc/callback",
    async (request, reply) => {
      if (config.auth.mode !== "oidc") return reply.code(404).send({ error: "OIDC authentication is disabled" });
      if (request.query.error) return reply.code(401).send({ error: request.query.error });

      const oauthState = unseal<OAuthState>(request.cookies[config.auth.oauthCookieName], config.auth.sessionSecret);
      clearCookie(reply, config.auth.oauthCookieName);
      if (!oauthState || !safeEqual(request.query.state, oauthState.state) || !request.query.code) {
        return reply.code(401).send({ error: "Invalid OIDC callback state" });
      }

      const discovery = await getDiscovery();
      const tokenBody = new URLSearchParams({
        grant_type: "authorization_code",
        code: request.query.code,
        redirect_uri: oidcRedirectUri(request),
        client_id: config.auth.oidc.clientId!,
        code_verifier: oauthState.codeVerifier
      });
      if (config.auth.oidc.clientSecret) tokenBody.set("client_secret", config.auth.oidc.clientSecret);

      const tokenResponse = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: tokenBody
      });
      if (!tokenResponse.ok) {
        return reply.code(401).send({ error: `OIDC token exchange failed with status ${tokenResponse.status}` });
      }

      const tokens = (await tokenResponse.json()) as { id_token?: string; access_token?: string };
      if (!tokens.id_token) return reply.code(401).send({ error: "OIDC response did not include an id_token" });

      const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
      const verified = await jwtVerify(tokens.id_token, jwks, {
        issuer: discovery.issuer,
        audience: config.auth.oidc.clientId
      });
      if (verified.payload.nonce !== oauthState.nonce) return reply.code(401).send({ error: "Invalid OIDC nonce" });

      let userInfo: Record<string, unknown> = {};
      if (tokens.access_token && discovery.userinfo_endpoint) {
        const userInfoResponse = await fetch(discovery.userinfo_endpoint, {
          headers: { authorization: `Bearer ${tokens.access_token}` }
        });
        if (userInfoResponse.ok) userInfo = (await userInfoResponse.json()) as Record<string, unknown>;
      }

      const claims = { ...verified.payload, ...userInfo };
      const email = firstStringClaim(claims, [config.auth.oidc.emailClaim, "email", "preferred_username", "sub"]).toLowerCase();
      if (!email) {
        return reply.code(401).send({
          error: `OIDC token and UserInfo response are missing ${config.auth.oidc.emailClaim}`
        });
      }

      const name = firstStringClaim(claims, [config.auth.oidc.nameClaim, "name", "preferred_username", "email"]);
      const user: AuthUser = {
        email,
        name: name || email,
        role: roleFromClaims(email, claims),
        provider: "oidc"
      };
      setSession(reply, user);
      return reply.redirect(oauthState.redirectTo);
    }
  );
}
