import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { presentAccess, requireOwnedScan } from "@/lib/server/presenter";
import { redditAuthorizationUrl, requireRedditOAuthConfiguration } from "@/lib/server/reddit-oauth";
import { assertRateLimit } from "@/lib/server/rate-limit";

export async function GET(request: Request) {
  try {
    assertRateLimit(request, "reddit:connect", { limit: 12, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const scanId = new URL(request.url).searchParams.get("scanId");
    const scan = scanId ? await requireOwnedScan(actor.workspaceId, scanId) : null;
    const access = await presentAccess(actor.workspaceId, scan?.websiteUrl);
    if (!access.unlocked) {
      throw new ApiError(
        "An active Full Access Pass or Core plan is required to connect Reddit.",
        402,
        "upgrade_required",
      );
    }
    const configuration = await requireRedditOAuthConfiguration();
    return Response.redirect(
      await redditAuthorizationUrl(actor.workspaceId, scan?.id ?? null, configuration),
      302,
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
