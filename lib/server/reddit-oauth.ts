import type { RedditConnectionRecord } from "./contracts";
import { getStateRepository } from "./repository";

const REDDIT_AUTHORIZE_URL = "https://www.reddit.com/api/v1/authorize";
const REDDIT_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const REDDIT_API_ORIGIN = "https://oauth.reddit.com";
const REQUIRED_SCOPES = ["identity", "submit"] as const;
const MAX_RESPONSE_BYTES = 1_000_000;

export type RedditOAuthConfiguration = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userAgent: string;
  stateSecret: string;
  encryptionKey: CryptoKey;
};

type OAuthStatePayload = {
  version: 1;
  workspaceId: string;
  scanId: string | null;
  expiresAt: number;
  nonce: string;
};

type RedditTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
};

type RedditIdentity = { id?: unknown; name?: unknown };

export class RedditApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly outcome: "safe-failure" | "unknown",
    readonly status = 502,
  ) {
    super(message);
    this.name = "RedditApiError";
  }
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required when Reddit OAuth is enabled.`);
  return normalized;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = Buffer.from(value, "base64url");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
}

function encryptionKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.trim();
  const decoded = /^[a-f\d]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  if (bytes.byteLength !== 32) {
    throw new Error("REDDIT_TOKEN_ENCRYPTION_KEY must contain exactly 32 bytes (64 hex characters or base64).");
  }
  return bytes;
}

function validRedirectUri(value: string): string {
  const url = new URL(value);
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password || url.hash) {
    throw new Error("REDDIT_REDIRECT_URI must be HTTPS, except for localhost development.");
  }
  return url.toString();
}

export async function redditOAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RedditOAuthConfiguration | null> {
  if (env.REDDIT_OAUTH_ENABLED?.trim().toLowerCase() !== "true") return null;
  const appUrl = required(env.APP_URL, "APP_URL");
  const redirectUri = validRedirectUri(
    env.REDDIT_REDIRECT_URI?.trim() || new URL("/api/reddit/callback", appUrl).toString(),
  );
  const stateSecret = required(env.REDDIT_OAUTH_STATE_SECRET || env.AUTH_SECRET, "REDDIT_OAUTH_STATE_SECRET or AUTH_SECRET");
  if (new TextEncoder().encode(stateSecret).byteLength < 32) {
    throw new Error("The Reddit OAuth state secret must be at least 32 bytes.");
  }
  const userAgent = required(env.REDDIT_USER_AGENT, "REDDIT_USER_AGENT");
  if (userAgent.length < 12 || userAgent.length > 256) {
    throw new Error("REDDIT_USER_AGENT must be between 12 and 256 characters.");
  }
  const encryptionKey = await crypto.subtle.importKey(
    "raw",
    encryptionKeyBytes(required(env.REDDIT_TOKEN_ENCRYPTION_KEY, "REDDIT_TOKEN_ENCRYPTION_KEY")),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return {
    clientId: required(env.REDDIT_CLIENT_ID, "REDDIT_CLIENT_ID"),
    clientSecret: required(env.REDDIT_CLIENT_SECRET, "REDDIT_CLIENT_SECRET"),
    redirectUri,
    userAgent,
    stateSecret,
    encryptionKey,
  };
}

export async function requireRedditOAuthConfiguration(): Promise<RedditOAuthConfiguration> {
  const configuration = await redditOAuthConfiguration();
  if (!configuration) throw new Error("Reddit OAuth is not enabled.");
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

export async function createRedditOAuthState(
  workspaceId: string,
  scanId: string | null,
  configuration: RedditOAuthConfiguration,
): Promise<string> {
  const nonce = new Uint8Array(18);
  crypto.getRandomValues(nonce);
  const payload: OAuthStatePayload = {
    version: 1,
    workspaceId,
    scanId,
    expiresAt: Date.now() + 10 * 60_000,
    nonce: bytesToBase64Url(nonce),
  };
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(configuration.stateSecret),
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyRedditOAuthState(
  value: string,
  configuration: RedditOAuthConfiguration,
): Promise<OAuthStatePayload> {
  const [encoded, signature, extra] = value.split(".");
  if (!encoded || !signature || extra) throw new Error("Reddit OAuth state is invalid.");
  const verified = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(configuration.stateSecret),
    base64UrlToBytes(signature),
    new TextEncoder().encode(encoded),
  );
  if (!verified) throw new Error("Reddit OAuth state is invalid.");
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))) as OAuthStatePayload;
  } catch {
    throw new Error("Reddit OAuth state is invalid.");
  }
  if (
    payload.version !== 1 ||
    !/^ws_[a-z\d]+$/i.test(payload.workspaceId) ||
    (payload.scanId !== null && !/^scan_[a-z\d]+$/i.test(payload.scanId)) ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 16 ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt < Date.now() ||
    payload.expiresAt > Date.now() + 11 * 60_000
  ) {
    throw new Error("Reddit OAuth state is invalid or expired.");
  }
  return payload;
}

function tokenAdditionalData(
  workspaceId: string,
  kind: "access" | "refresh",
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`demandsift:reddit-token:${workspaceId}:${kind}:v1`);
}

export async function encryptRedditToken(
  token: string,
  workspaceId: string,
  kind: "access" | "refresh",
  configuration: RedditOAuthConfiguration,
): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAdditionalData(workspaceId, kind), tagLength: 128 },
    configuration.encryptionKey,
    new TextEncoder().encode(token),
  );
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptRedditToken(
  value: string,
  workspaceId: string,
  kind: "access" | "refresh",
  configuration: RedditOAuthConfiguration,
): Promise<string> {
  const [version, iv, ciphertext, extra] = value.split(".");
  if (version !== "v1" || !iv || !ciphertext || extra) throw new Error("Stored Reddit credentials are invalid.");
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64UrlToBytes(iv),
        additionalData: tokenAdditionalData(workspaceId, kind),
        tagLength: 128,
      },
      configuration.encryptionKey,
      base64UrlToBytes(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new Error("Stored Reddit credentials could not be decrypted.");
  }
}

export async function redditAuthorizationUrl(
  workspaceId: string,
  scanId: string | null,
  configuration: RedditOAuthConfiguration,
): Promise<string> {
  const url = new URL(REDDIT_AUTHORIZE_URL);
  url.searchParams.set("client_id", configuration.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", await createRedditOAuthState(workspaceId, scanId, configuration));
  url.searchParams.set("redirect_uri", configuration.redirectUri);
  url.searchParams.set("duration", "permanent");
  url.searchParams.set("scope", REQUIRED_SCOPES.join(" "));
  return url.toString();
}

async function boundedJson(response: Response, context: string): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new RedditApiError(`${context} response was too large.`, "reddit_response_too_large", "safe-failure");
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
    throw new RedditApiError(`${context} response was too large.`, "reddit_response_too_large", "safe-failure");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new RedditApiError(`${context} returned invalid JSON.`, "reddit_invalid_response", "safe-failure");
  }
}

async function redditFetch(
  url: string,
  init: RequestInit,
  configuration: RedditOAuthConfiguration,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("user-agent", configuration.userAgent);
  try {
    return await fetch(url, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch {
    throw new RedditApiError(
      controller.signal.aborted ? "Reddit did not respond in time." : "Reddit could not be reached.",
      controller.signal.aborted ? "reddit_timeout" : "reddit_unreachable",
      "unknown",
      502,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function basicAuthorization(configuration: RedditOAuthConfiguration): string {
  return `Basic ${Buffer.from(`${configuration.clientId}:${configuration.clientSecret}`).toString("base64")}`;
}

async function tokenRequest(
  form: URLSearchParams,
  configuration: RedditOAuthConfiguration,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number; scopes: string[] }> {
  const response = await redditFetch(REDDIT_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: basicAuthorization(configuration),
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  }, configuration);
  const payload = await boundedJson(response, "Reddit OAuth") as RedditTokenResponse;
  const accessToken = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token.trim() : undefined;
  const expiresIn = Number(payload.expires_in);
  const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/).filter(Boolean) : [];
  if (!response.ok || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new RedditApiError("Reddit did not authorize this connection.", "reddit_oauth_failed", "safe-failure", 502);
  }
  return { accessToken, refreshToken, expiresIn, scopes };
}

async function redditIdentity(
  accessToken: string,
  configuration: RedditOAuthConfiguration,
): Promise<{ id: string; username: string }> {
  const response = await redditFetch(`${REDDIT_API_ORIGIN}/api/v1/me`, {
    headers: { accept: "application/json", authorization: `Bearer ${accessToken}` },
  }, configuration);
  const payload = await boundedJson(response, "Reddit identity") as RedditIdentity;
  const id = typeof payload.id === "string" ? payload.id.trim() : "";
  const username = typeof payload.name === "string" ? payload.name.trim() : "";
  if (!response.ok || !id || !/^[A-Za-z0-9_-]{1,100}$/.test(username)) {
    throw new RedditApiError("Reddit account identity could not be verified.", "reddit_identity_failed", "safe-failure", 502);
  }
  return { id, username };
}

export async function connectRedditAccount(
  workspaceId: string,
  code: string,
  configuration: RedditOAuthConfiguration,
): Promise<RedditConnectionRecord> {
  const token = await tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: configuration.redirectUri,
  }), configuration);
  if (!token.refreshToken || !REQUIRED_SCOPES.every((scope) => token.scopes.includes(scope))) {
    throw new RedditApiError("Reddit did not grant permanent identity and submit access.", "reddit_scopes_missing", "safe-failure", 502);
  }
  const identity = await redditIdentity(token.accessToken, configuration);
  const now = new Date();
  const record: RedditConnectionRecord = {
    workspaceId,
    redditUserId: identity.id,
    username: identity.username,
    accessTokenCiphertext: await encryptRedditToken(token.accessToken, workspaceId, "access", configuration),
    refreshTokenCiphertext: await encryptRedditToken(token.refreshToken, workspaceId, "refresh", configuration),
    scopes: token.scopes,
    tokenExpiresAt: new Date(now.getTime() + token.expiresIn * 1_000).toISOString(),
    connectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await getStateRepository().saveRedditConnection(record);
  return record;
}

export async function validRedditAccessToken(
  connection: RedditConnectionRecord,
  configuration: RedditOAuthConfiguration,
  forceRefresh = false,
): Promise<{ connection: RedditConnectionRecord; accessToken: string }> {
  if (!forceRefresh && Date.parse(connection.tokenExpiresAt) > Date.now() + 60_000) {
    return {
      connection,
      accessToken: await decryptRedditToken(connection.accessTokenCiphertext, connection.workspaceId, "access", configuration),
    };
  }
  const refreshToken = await decryptRedditToken(
    connection.refreshTokenCiphertext,
    connection.workspaceId,
    "refresh",
    configuration,
  );
  const refreshed = await tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }), configuration);
  const updatedAt = new Date();
  const updated: RedditConnectionRecord = {
    ...connection,
    accessTokenCiphertext: await encryptRedditToken(refreshed.accessToken, connection.workspaceId, "access", configuration),
    refreshTokenCiphertext: refreshed.refreshToken
      ? await encryptRedditToken(refreshed.refreshToken, connection.workspaceId, "refresh", configuration)
      : connection.refreshTokenCiphertext,
    scopes: refreshed.scopes.length ? refreshed.scopes : connection.scopes,
    tokenExpiresAt: new Date(updatedAt.getTime() + refreshed.expiresIn * 1_000).toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
  await getStateRepository().saveRedditConnection(updated);
  return { connection: updated, accessToken: refreshed.accessToken };
}

function commentResult(payload: unknown): { commentId: string; url: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const json = (payload as { json?: unknown }).json;
  if (!json || typeof json !== "object") return null;
  const errors = (json as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const first = Array.isArray(errors[0]) ? errors[0].map(String).filter(Boolean).join(": ") : "Reddit rejected the reply.";
    throw new RedditApiError(first.slice(0, 300), "reddit_comment_rejected", "safe-failure", 422);
  }
  const things = (json as { data?: { things?: unknown } }).data?.things;
  const data = Array.isArray(things) && things[0] && typeof things[0] === "object"
    ? (things[0] as { data?: unknown }).data
    : null;
  if (!data || typeof data !== "object") return null;
  const row = data as { id?: unknown; name?: unknown; url?: unknown; permalink?: unknown };
  const name = typeof row.name === "string" ? row.name : "";
  const id = typeof row.id === "string" ? row.id : name.replace(/^t1_/, "");
  const rawUrl = typeof row.permalink === "string" ? row.permalink : typeof row.url === "string" ? row.url : "";
  if (!id || !rawUrl) return null;
  const url = new URL(rawUrl, "https://www.reddit.com");
  if (url.protocol !== "https:" || (url.hostname !== "reddit.com" && !url.hostname.endsWith(".reddit.com"))) return null;
  return { commentId: id, url: url.toString() };
}

export async function submitRedditComment(input: {
  accessToken: string;
  redditThingId: string;
  text: string;
  configuration: RedditOAuthConfiguration;
}): Promise<{ commentId: string; url: string }> {
  const response = await redditFetch(`${REDDIT_API_ORIGIN}/api/comment`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input.accessToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      api_type: "json",
      return_rtjson: "true",
      thing_id: input.redditThingId,
      text: input.text,
    }).toString(),
  }, input.configuration);
  const payload = await boundedJson(response, "Reddit comment submission");
  if (response.status === 401) {
    throw new RedditApiError("Reddit authorization expired.", "reddit_token_expired", "safe-failure", 401);
  }
  if (!response.ok) {
    throw new RedditApiError(
      response.status >= 500 ? "Reddit may not have completed the reply." : "Reddit rejected the reply.",
      "reddit_comment_failed",
      response.status >= 500 ? "unknown" : "safe-failure",
      response.status >= 500 ? 502 : 422,
    );
  }
  const result = commentResult(payload);
  if (!result) {
    throw new RedditApiError("Reddit returned an uncertain publication result.", "reddit_publication_uncertain", "unknown", 502);
  }
  return result;
}

export async function revokeRedditConnection(
  connection: RedditConnectionRecord,
  configuration: RedditOAuthConfiguration,
): Promise<void> {
  try {
    const refreshToken = await decryptRedditToken(
      connection.refreshTokenCiphertext,
      connection.workspaceId,
      "refresh",
      configuration,
    );
    await redditFetch("https://www.reddit.com/api/v1/revoke_token", {
      method: "POST",
      headers: {
        authorization: basicAuthorization(configuration),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }).toString(),
    }, configuration);
  } catch {
    // Local disconnection still proceeds; the user can revoke the app in Reddit settings.
  }
}
