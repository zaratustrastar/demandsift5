import { apiErrorResponse, ApiError, requireWorkspace } from "@/lib/server/http";
import { presentAccess, presentReply, requireAccessibleReply } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import {
  RedditApiError,
  requireRedditOAuthConfiguration,
  submitRedditComment,
  validRedditAccessToken,
} from "@/lib/server/reddit-oauth";
import { getStateRepository } from "@/lib/server/repository";
import type { RedditPublicationRecord, ReplyRecord } from "@/lib/server/contracts";

type RouteContext = { params: Promise<{ replyId: string }> | { replyId: string } };

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(digest).toString("hex");
}

function publishedReply(reply: ReplyRecord, publication: RedditPublicationRecord): ReplyRecord {
  return {
    ...reply,
    status: "published",
    publishedAt: publication.updatedAt,
    publishedUrl: publication.publishedUrl,
    publishedVia: "reddit",
    redditCommentId: publication.redditCommentId,
    updatedAt: publication.updatedAt,
  };
}

export async function POST(request: Request, context: RouteContext) {
  let claimedReplyId: string | null = null;
  try {
    assertRateLimit(request, "reddit:publish", { limit: 10, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { replyId } = await context.params;
    const { scan, reply, opportunity } = await requireAccessibleReply(actor.workspaceId, replyId);
    const access = await presentAccess(actor.workspaceId, scan.websiteUrl);
    if (!access.unlocked) {
      throw new ApiError("Paid access is required to post through Reddit.", 402, "upgrade_required");
    }
    if (
      !opportunity.redditThingId ||
      !/^t[13]_[a-z\d]+$/i.test(opportunity.redditThingId) ||
      opportunity.synthetic ||
      !opportunity.permalink
    ) {
      throw new ApiError("This opportunity cannot receive a direct Reddit reply.", 422, "reddit_target_unavailable");
    }

    const repository = getStateRepository();
    const connection = await repository.getRedditConnection(actor.workspaceId);
    if (!connection) {
      throw new ApiError("Connect a Reddit account before posting.", 409, "reddit_not_connected");
    }
    if (!connection.scopes.includes("submit")) {
      throw new ApiError("Reconnect Reddit to grant reply permission.", 409, "reddit_submit_scope_missing");
    }

    const configuration = await requireRedditOAuthConfiguration();
    let credentials = await validRedditAccessToken(connection, configuration);

    const now = new Date().toISOString();
    const claim = await repository.claimRedditPublication({
      replyId: reply.id,
      workspaceId: actor.workspaceId,
      redditThingId: opportunity.redditThingId,
      contentHash: await sha256(reply.content),
      status: "pending",
      attempts: 1,
      redditCommentId: null,
      publishedUrl: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    if (claim.state === "succeeded") {
      const updated = publishedReply(reply, claim.record);
      await repository.saveReply(updated);
      return Response.json({ reply: presentReply(updated), publication: { mode: "reddit", duplicate: true } });
    }
    if (claim.state === "pending" || claim.state === "unknown") {
      throw new ApiError(
        claim.state === "unknown"
          ? "The previous Reddit result is uncertain. Check the thread before trying again to avoid a duplicate reply."
          : "This Reddit reply is already being submitted.",
        409,
        claim.state === "unknown" ? "reddit_publication_uncertain" : "reddit_publication_pending",
      );
    }
    claimedReplyId = reply.id;

    let result;
    try {
      result = await submitRedditComment({
        accessToken: credentials.accessToken,
        redditThingId: opportunity.redditThingId,
        text: reply.content,
        configuration,
      });
    } catch (error) {
      if (error instanceof RedditApiError && error.code === "reddit_token_expired") {
        credentials = await validRedditAccessToken(credentials.connection, configuration, true);
        result = await submitRedditComment({
          accessToken: credentials.accessToken,
          redditThingId: opportunity.redditThingId,
          text: reply.content,
          configuration,
        });
      } else {
        throw error;
      }
    }

    const completedAt = new Date().toISOString();
    const completed: RedditPublicationRecord = {
      ...claim.record,
      status: "succeeded",
      redditCommentId: result.commentId,
      publishedUrl: result.url,
      lastError: null,
      updatedAt: completedAt,
    };
    await repository.saveRedditPublication(completed);
    const updated = publishedReply(reply, completed);
    await repository.saveReply(updated);
    return Response.json({
      reply: presentReply(updated),
      publication: { mode: "reddit", duplicate: false, url: result.url },
    });
  } catch (error) {
    if (error instanceof RedditApiError) {
      if (claimedReplyId) {
        try {
          const repository = getStateRepository();
          const publication = await repository.getRedditPublication(claimedReplyId);
          if (publication?.status === "pending") {
            await repository.saveRedditPublication({
              ...publication,
              status: error.outcome === "unknown" ? "unknown" : "failed",
              lastError: error.code,
              updatedAt: new Date().toISOString(),
            });
          }
        } catch {
          // The original error remains the useful response.
        }
      }
      return apiErrorResponse(new ApiError(error.message, error.status, error.code));
    }
    return apiErrorResponse(error);
  }
}
