import { getRequestOrigin, requireWorkspace } from "@/lib/server/http";
import { presentAccess, requireOwnedScan } from "@/lib/server/presenter";
import {
  connectRedditAccount,
  requireRedditOAuthConfiguration,
  verifyRedditOAuthState,
} from "@/lib/server/reddit-oauth";
import { assertRateLimit } from "@/lib/server/rate-limit";

function redirectResult(origin: string, result: "connected" | "denied" | "error", scanId?: string | null) {
  const target = new URL("/", origin);
  target.searchParams.set("reddit", result);
  if (scanId) target.searchParams.set("scan_id", scanId);
  return Response.redirect(target, 302);
}

export async function GET(request: Request) {
  const origin = getRequestOrigin(request);
  let scanId: string | null = null;
  try {
    assertRateLimit(request, "reddit:callback", { limit: 20, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const url = new URL(request.url);
    const configuration = await requireRedditOAuthConfiguration();
    const state = await verifyRedditOAuthState(url.searchParams.get("state") ?? "", configuration);
    scanId = state.scanId;
    if (state.workspaceId !== actor.workspaceId) throw new Error("Reddit OAuth workspace mismatch.");
    const scan = scanId ? await requireOwnedScan(actor.workspaceId, scanId) : null;
    const access = await presentAccess(actor.workspaceId, scan?.websiteUrl);
    if (!access.unlocked) throw new Error("Paid Reddit connection access expired.");
    if (url.searchParams.get("error")) return redirectResult(origin, "denied", scanId);
    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!code || code.length > 2_048) throw new Error("Reddit OAuth code is invalid.");
    await connectRedditAccount(actor.workspaceId, code, configuration);
    return redirectResult(origin, "connected", scanId);
  } catch (error) {
    console.error("Reddit OAuth callback failed", error instanceof Error ? error.message : "unknown_error");
    return redirectResult(origin, "error", scanId);
  }
}
