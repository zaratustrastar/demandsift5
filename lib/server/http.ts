import { createId, createToken } from "./ids";
import { getStateRepository } from "./repository";
import { isProductionRuntime } from "./runtime-env";

const API_ERROR_BRAND = Symbol.for("threadline.api-error");

export class ApiError extends Error {
  readonly [API_ERROR_BRAND] = true;

  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isApiError(error: unknown): error is {
  message: string;
  status: number;
  code: string;
} {
  if (!error || typeof error !== "object") return false;
  const value = error as Record<PropertyKey, unknown>;
  const branded = value[API_ERROR_BRAND] === true || value.name === "ApiError";
  return (
    branded &&
    typeof value.message === "string" &&
    typeof value.code === "string" &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599
  );
}

export async function readJson<T>(request: Request, maxBytes = 24_000): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new ApiError("Content-Type must be application/json.", 415, "unsupported_media_type");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new ApiError("Request body is too large.", 413, "payload_too_large");
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError("Request body must contain valid JSON.", 400, "invalid_json");
  }
}

export function apiErrorResponse(error: unknown): Response {
  if (isApiError(error)) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }

  console.error("Unhandled API error", error);
  return Response.json(
    { error: { code: "internal_error", message: "Something went wrong. Please try again." } },
    { status: 500 },
  );
}

function parseCookies(request: Request): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key) values.set(key, decodeURIComponent(value));
  }
  return values;
}

export type WorkspaceActor = { workspaceId: string; token: string };

async function hashToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createWorkspace(): Promise<WorkspaceActor> {
  const actor = { workspaceId: createId("ws"), token: createToken() };
  const createdAt = new Date();
  await getStateRepository().saveWorkspace({
    id: actor.workspaceId,
    tokenHash: await hashToken(actor.token),
    expiresAt: new Date(createdAt.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    createdAt: createdAt.toISOString(),
  });
  return actor;
}

export async function requireWorkspace(request: Request): Promise<WorkspaceActor> {
  const cookie = parseCookies(request).get("rd_workspace") ?? "";
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const credential = cookie || bearer;
  const separator = credential.indexOf(".");
  const workspaceId = separator > 0 ? credential.slice(0, separator) : "";
  const token = separator > 0 ? credential.slice(separator + 1) : "";
  if (!workspaceId || !token || !(await getStateRepository().verifyWorkspaceToken(workspaceId, token))) {
    throw new ApiError("Your workspace session is missing or expired.", 401, "unauthorized");
  }

  return { workspaceId, token };
}

export function workspaceCookie(actor: WorkspaceActor): string {
  const secure = isProductionRuntime() ? "; Secure" : "";
  return `rd_workspace=${encodeURIComponent(`${actor.workspaceId}.${actor.token}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

export function getRequestOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      throw new ApiError("APP_URL is not a valid URL.", 500, "server_configuration_error");
    }
  }
  return new URL(request.url).origin;
}
