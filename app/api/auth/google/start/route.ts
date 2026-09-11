import { apiErrorResponse, createWorkspace, requireWorkspace, workspaceCookie, type WorkspaceActor } from "@/lib/server/http";
import { googleAuthorizationUrl, requireGoogleOAuthConfiguration } from "@/lib/server/google-oauth";
import { assertRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  try {
    assertRateLimit(request, "auth:google:start", { limit: 12, windowMs: 10 * 60_000 });

    // Unlike Reddit connect (which only ever runs from an existing scan),
    // "Log in" is reachable with no workspace at all yet -- a fresh visitor,
    // or a returning user opening the site on a new device with no
    // rd_workspace cookie of its own. Fall back to creating one, exactly
    // like POST /api/scans already does, so there's always something valid
    // to carry through the state param.
    let actor: WorkspaceActor;
    try {
      actor = await requireWorkspace(request);
    } catch {
      actor = await createWorkspace();
    }

    const configuration = await requireGoogleOAuthConfiguration();
    const url = await googleAuthorizationUrl(actor.workspaceId, configuration);

    const headers = new Headers({ Location: url });
    const cookie = workspaceCookie(actor);
    if (cookie) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
