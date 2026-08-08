import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { presentAccess } from "@/lib/server/presenter";

export async function GET(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    return Response.json(
      { access: await presentAccess(actor.workspaceId) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
