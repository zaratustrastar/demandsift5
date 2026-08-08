import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { presentReply, requireAccessibleReply } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ replyId: string }> | { replyId: string } };
type EditReplyBody = { content?: unknown };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "reply:edit", { limit: 60, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { replyId } = await context.params;
    const { reply } = await requireAccessibleReply(actor.workspaceId, replyId);
    if (reply.status === "published") {
      throw new ApiError("Published replies cannot be edited.", 409, "reply_already_published");
    }
    const body = await readJson<EditReplyBody>(request);
    if (typeof body.content !== "string") {
      throw new ApiError("Reply content is required.", 400, "reply_content_required");
    }
    const content = body.content.trim();
    if (content.length < 20 || content.length > 5_000) {
      throw new ApiError(
        "Reply content must be between 20 and 5,000 characters.",
        400,
        "invalid_reply_content",
      );
    }
    const updated = { ...reply, content, updatedAt: new Date().toISOString() };
    await getStateRepository().saveReply(updated);
    return Response.json({ reply: presentReply(updated) });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
