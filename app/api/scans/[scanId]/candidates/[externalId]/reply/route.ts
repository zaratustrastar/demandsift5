import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { createCandidateReply } from "@/lib/server/candidate-reply-service";
import { presentReply } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";

type RouteContext = {
  params: Promise<{ scanId: string; externalId: string }> | { scanId: string; externalId: string };
};

/**
 * Drafts a first reply, on demand, for any Reddit candidate the scan already
 * deep-qualified -- the "Create reply" button on the unified carousel. See
 * lib/server/candidate-reply-service.ts for why this never runs deep
 * qualification itself, only reuses a review the scan already did.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "candidate:create-reply", { limit: 12, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId, externalId } = await context.params;
    const { reply } = await createCandidateReply({
      workspaceId: actor.workspaceId,
      scanId,
      externalId: decodeURIComponent(externalId),
    });
    return Response.json({ reply: presentReply(reply) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
