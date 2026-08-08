import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { presentReply, requireAccessibleReply } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

type RouteContext = { params: Promise<{ replyId: string }> | { replyId: string } };
type PublishReplyBody = { publishedUrl?: unknown };

function validatedRedditUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ApiError("Published URL is invalid.", 400, "invalid_published_url");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError("Published URL is invalid.", 400, "invalid_published_url");
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (host !== "reddit.com" && !host.endsWith(".reddit.com") && host !== "redd.it")) {
    throw new ApiError("Published URL must be a secure Reddit URL.", 400, "invalid_published_url");
  }
  return url.toString();
}

export async function POST(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "reply:publish", { limit: 30, windowMs: 60_000 });
    const actor = await requireWorkspace(request);
    const { replyId } = await context.params;
    const { reply } = await requireAccessibleReply(actor.workspaceId, replyId);
    const body = await readJson<PublishReplyBody>(request);
    const publishedUrl = validatedRedditUrl(body.publishedUrl);
    if (reply.status === "published") {
      return Response.json({ reply: presentReply(reply), publication: { mode: "recorded", duplicate: true } });
    }
    const publishedAt = new Date().toISOString();
    const updated = {
      ...reply,
      status: "published" as const,
      publishedAt,
      publishedUrl,
      publishedVia: "manual" as const,
      redditCommentId: null,
      updatedAt: publishedAt,
    };
    await getStateRepository().saveReply(updated);
    return Response.json({
      reply: presentReply(updated),
      publication: {
        mode: "recorded",
        duplicate: false,
        notice: publishedUrl
          ? "Published reply recorded with its Reddit URL."
          : "Published reply recorded. Add the Reddit URL later to retain a direct source link.",
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
