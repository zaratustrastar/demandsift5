import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentAccess } from "@/lib/server/presenter";
import {
  redditOAuthConfiguration,
  revokeRedditConnection,
} from "@/lib/server/reddit-oauth";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const [configuration, connection, access] = await Promise.all([
      redditOAuthConfiguration().catch(() => null),
      getStateRepository().getRedditConnection(actor.workspaceId),
      presentAccess(actor.workspaceId),
    ]);
    return Response.json({
      reddit: {
        configured: Boolean(configuration),
        connected: Boolean(configuration && connection),
        username: configuration && connection ? connection.username : null,
        canConnect: Boolean(configuration && access.unlocked),
        requiresPaidAccess: !access.unlocked,
      },
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    assertRateLimit(request, "reddit:disconnect", { limit: 12, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const repository = getStateRepository();
    const connection = await repository.getRedditConnection(actor.workspaceId);
    const configuration = await redditOAuthConfiguration().catch(() => null);
    if (connection && configuration) await revokeRedditConnection(connection, configuration);
    await repository.deleteRedditConnection(actor.workspaceId);
    return Response.json({
      reddit: { configured: Boolean(configuration), connected: false, username: null },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
