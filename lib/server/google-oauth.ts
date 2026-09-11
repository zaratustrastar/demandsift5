import { getStateRepository } from "./repository";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const SCOPES = ["openid", "email", "profile"] as const;
const MAX_RESPONSE_BYTES = 1_000_000;

export type GoogleOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
};

type OAuthStatePayload = {
  version: 1;
  workspaceId: string;
  expiresAt: number;
  nonce: string;
};

type GoogleTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
};

type GoogleUserinfo = {
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
};

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required when Google sign-in is enabled.`);
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z\d_-]+$/.test(value)) {
    throw new GoogleAuthError("Google sign-in state is invalid.", "google_state_invalid", 400);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new GoogleAuthError("Google sign-in state is invalid.", "google_state_invalid", 400);
  }
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

function validRedirectUri(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.hash) {
    throw new Error("GOOGLE_REDIRECT_URI must be HTTPS, except for localhost development.");
  }
  return url.toString();
}

/**
 * Mirrors reddit-oauth.ts's configuration/state pattern (signed, expiring
 * state; a feature flag so this is inert unless deliberately turned on).
 * Deliberately does not need reddit-oauth's token-encryption machinery --
 * Google's access token is only ever used once, immediately, to fetch the
 * profile that creates our own session; nothing from Google is persisted.
 */
export async function googleOAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GoogleOAuthConfiguration | null> {
  if (env.GOOGLE_OAUTH_ENABLED?.trim().toLowerCase() !== "true") return null;
  const appUrl = required(env.APP_URL, "APP_URL");
  const redirectUri = validRedirectUri(
    env.GOOGLE_REDIRECT_URI?.trim() || new URL("/api/auth/google/callback", appUrl).toString(),
  );
  const stateSecret = required(env.AUTH_SECRET, "AUTH_SECRET");
  if (new TextEncoder().encode(stateSecret).byteLength < 32) {
    throw new Error("AUTH_SECRET must be at least 32 bytes.");
  }
  return {
    clientId: required(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID"),
    clientSecret: required(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET"),
    redirectUri,
    stateSecret,
  };
}

export async function requireGoogleOAuthConfiguration(): Promise<GoogleOAuthConfiguration> {
  const configuration = await googleOAuthConfiguration();
  if (!configuration) throw new Error("Google sign-in is not enabled.");
  return configuration;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createGoogleOAuthState(
  workspaceId: string,
  configuration: GoogleOAuthConfiguration,
): Promise<string> {
  const nonce = new Uint8Array(18);
  crypto.getRandomValues(nonce);
  const payload: OAuthStatePayload = {
    version: 1,
    workspaceId,
    expiresAt: Date.now() + 10 * 60_000,
    nonce: bytesToBase64Url(nonce),
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(configuration.stateSecret), new TextEncoder().encode(encoded));
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyGoogleOAuthState(
  value: string,
  configuration: GoogleOAuthConfiguration,
): Promise<OAuthStatePayload> {
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) {
    throw new GoogleAuthError("Google sign-in state is invalid.", "google_state_invalid", 400);
  }
  const verified = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(configuration.stateSecret),
    base64UrlToBytes(signature),
    new TextEncoder().encode(encoded),
  );
  if (!verified) throw new GoogleAuthError("Google sign-in state is invalid.", "google_state_invalid", 400);
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as OAuthStatePayload;
  } catch {
    throw new GoogleAuthError("Google sign-in state is invalid.", "google_state_invalid", 400);
  }
  if (
    payload.version !== 1 ||
    !/^ws_[a-z\d]+$/i.test(payload.workspaceId) ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16 ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt < Date.now() ||
    payload.expiresAt > Date.now() + 11 * 60_000
  ) {
    throw new GoogleAuthError("Google sign-in state is invalid or expired.", "google_state_invalid", 400);
  }
  return payload;
}

export async function googleAuthorizationUrl(
  workspaceId: string,
  configuration: GoogleOAuthConfiguration,
): Promise<string> {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", await createGoogleOAuthState(workspaceId, configuration));
  // Google re-prompts consent every time by default only for offline access;
  // we don't request offline access (no refresh token stored), so a
  // returning user gets a fast, silent re-authorization here.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

async function boundedJson(response: Response, context: string): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new GoogleAuthError(`${context} response was too large.`, "google_response_too_large");
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
    throw new GoogleAuthError(`${context} response was too large.`, "google_response_too_large");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new GoogleAuthError(`${context} returned invalid JSON.`, "google_invalid_response");
  }
}

async function googleFetch(url: string, init: RequestInit, timeoutMs = 15_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new GoogleAuthError(
      controller.signal.aborted ? "Google did not respond in time." : "Google could not be reached.",
      controller.signal.aborted ? "google_timeout" : "google_unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function exchangeCodeForAccessToken(code: string, configuration: GoogleOAuthConfiguration): Promise<string> {
  const response = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: configuration.clientId,
      client_secret: configuration.clientSecret,
      redirect_uri: configuration.redirectUri,
    }).toString(),
  });
  const payload = (await boundedJson(response, "Google OAuth")) as GoogleTokenResponse;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!response.ok || !accessToken) {
    throw new GoogleAuthError("Google did not authorize this sign-in.", "google_oauth_failed");
  }
  return accessToken;
}

async function fetchGoogleProfile(accessToken: string): Promise<{ subject: string; email: string; emailVerified: boolean; name: string | null }> {
  const response = await googleFetch(GOOGLE_USERINFO_URL, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  });
  const payload = (await boundedJson(response, "Google profile")) as GoogleUserinfo;
  const subject = typeof payload.sub === "string" ? payload.sub.trim() : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  if (!response.ok || !subject || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new GoogleAuthError("Google account identity could not be verified.", "google_identity_failed");
  }
  return {
    subject,
    email,
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === "string" && payload.name.trim() ? payload.name.trim().slice(0, 160) : null,
  };
}

/**
 * The single entry point the callback route needs: exchange the
 * authorization code, resolve (or create) the user, claim the anonymous
 * workspace the sign-in started from, and issue a session. See
 * app/api/auth/google/callback/route.ts.
 */
export async function completeGoogleSignIn(
  workspaceId: string,
  code: string,
  configuration: GoogleOAuthConfiguration,
): Promise<{ userId: string; token: string; expiresAt: string }> {
  const accessToken = await exchangeCodeForAccessToken(code, configuration);
  const profile = await fetchGoogleProfile(accessToken);
  const repository = getStateRepository();
  const user = await repository.findOrCreateUserByGoogleAccount({
    subject: profile.subject,
    email: profile.email,
    name: profile.name,
    emailVerified: profile.emailVerified,
  });

  // First sign-in claims whichever workspace this browser was on (their
  // scan results, which would otherwise disappear in 30 days) as the
  // account's permanent one. A *returning* user signing in again -- e.g.
  // from a new device with no rd_workspace cookie of its own, so
  // /api/auth/google/start had to create a fresh, empty workspace just to
  // start the redirect -- already has a claimed workspace; leave it alone
  // rather than reassigning their account to that empty throwaway one.
  // requireWorkspace's session-priority resolution then routes every
  // subsequent request to their real, original workspace regardless of
  // which one this particular request happened to create.
  const existingWorkspaceId = await repository.getPrimaryWorkspaceIdForUser(user.id);
  if (!existingWorkspaceId) {
    await repository.claimWorkspaceForUser(workspaceId, user.id);
  }

  const session = await repository.createAuthSession(user.id);
  return { userId: user.id, token: session.token, expiresAt: session.expiresAt };
}
