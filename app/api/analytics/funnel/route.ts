import type { FunnelEventName } from "@/lib/server/contracts";
import { captureFunnelEvent } from "@/lib/server/funnel";
import { apiErrorResponse, ApiError, readJson, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";

type FunnelBody = { scanId?: unknown; name?: unknown };

const CLIENT_EVENTS = new Set<FunnelEventName>([
  "potential_customer_count_revealed",
  "opportunity_preview_viewed",
  "suggested_reply_viewed",
  "locked_results_viewed",
  "unlock_cta_clicked",
]);

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "analytics:funnel", { limit: 60, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = await readJson<FunnelBody>(request);
    if (typeof body.scanId !== "string" || typeof body.name !== "string") {
      throw new ApiError("scanId and name are required.", 400, "invalid_funnel_event");
    }
    if (!CLIENT_EVENTS.has(body.name as FunnelEventName)) {
      throw new ApiError("Funnel event is not allowed from the browser.", 400, "invalid_funnel_event");
    }
    const scan = await requireOwnedScan(actor.workspaceId, body.scanId);
    if (scan.status !== "complete" || !scan.result) {
      throw new ApiError("The Market Scan is not complete.", 409, "scan_not_complete");
    }
    const event = await captureFunnelEvent(scan, body.name as FunnelEventName);
    return Response.json({ recorded: true, event: { name: event.name } }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
