import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentReply, requireAccessibleReply } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { regenerateReply } from "@/lib/server/reply-service";

type RouteContext = { params: Promise<{ replyId: string }> | { replyId: string } };

export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "reply:regenerate", { limit: 12, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { replyId } = await context.params;
    const { scan, reply, opportunity } = await requireAccessibleReply(actor.workspaceId, replyId);
    if (!scan.result) throw new Error("Scan result is unavailable");
    const updated = await regenerateReply({ reply, opportunity, profile: scan.result.profile });
    return Response.json({ reply: presentReply(updated) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
