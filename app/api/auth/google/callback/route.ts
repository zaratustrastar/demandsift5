import { getRequestOrigin, requireWorkspace, sessionCookie } from "@/lib/server/http";
import {
  completeGoogleSignIn,
  requireGoogleOAuthConfiguration,
  verifyGoogleOAuthState,
} from "@/lib/server/google-oauth";
import { assertRateLimit } from "@/lib/server/rate-limit";

function redirectResult(origin: string, result: "connected" | "denied" | "error"): Response {
  const target = new URL("/", origin);
  target.searchParams.set("account", result);
  return Response.redirect(target, 302);
}

export async function GET(request: Request) {
  const origin = getRequestOrigin(request);
  try {
    assertRateLimit(request, "auth:google:callback", { limit: 20, windowMs: 10 * 60_000 });

    // /api/auth/google/start always sets rd_workspace before redirecting
    // here (creating one first if the browser had none), so this can
    // require it rather than fall back the way start does.
    const actor = await requireWorkspace(request);
    const configuration = await requireGoogleOAuthConfiguration();
    const url = new URL(request.url);
    const state = await verifyGoogleOAuthState(url.searchParams.get("state") ?? "", configuration);
    if (state.workspaceId !== actor.workspaceId) throw new Error("Google sign-in workspace mismatch.");
    if (url.searchParams.get("error")) return redirectResult(origin, "denied");

    const code = url.searchParams.get("code")?.trim() ?? "";
    if (!code || code.length > 2_048) throw new Error("Google sign-in code is invalid.");

    const session = await completeGoogleSignIn(actor.workspaceId, code, configuration);
    const target = new URL("/", origin);
    target.searchParams.set("account", "connected");
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        "Set-Cookie": sessionCookie(session.token, session.expiresAt),
      },
    });
  } catch (error) {
    console.error("Google sign-in callback failed", error instanceof Error ? error.message : "unknown_error");
    return redirectResult(origin, "error");
  }
}
