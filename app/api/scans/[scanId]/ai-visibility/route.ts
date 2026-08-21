import { apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getAiVisibilitySettings, listAiVisibilityScans } from "@/lib/server/ai-visibility-repository";

type RouteContext = { params: Promise<{ scanId: string }> | { scanId: string } };

/**
 * Read-only view of AI Visibility Tracking for a scan's workspace: the
 * weekly schedule (if tracking has started) and scan history (most recent
 * first), so weekly results can be compared. MVP -- returns raw scan
 * history rather than any derived trend/GEO scoring; a richer dashboard is
 * explicitly out of scope for now.
 *
 * Deliberately isolated from the Reddit discovery/monitoring routes: this
 * only reads from ai-visibility-repository.ts, never from scan.result or
 * the Reddit monitor tables.
 */
export async function GET(request: Request, context: RouteContext) {
  try {
    assertRateLimit(request, "scan:ai-visibility", { limit: 60, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const { scanId } = await context.params;
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    const [settings, scans] = await Promise.all([
      getAiVisibilitySettings(scan.workspaceId),
      listAiVisibilityScans(scan.workspaceId, 20),
    ]);

    return Response.json(
      {
        enabled: settings?.enabled ?? false,
        nextRunAt: settings?.nextRunAt ?? null,
        lastSuccessfulScanAt: settings?.lastSuccessfulScanAt ?? null,
        scans: scans.map((entry) => ({
          id: entry.id,
          status: entry.status,
          questions: entry.questions,
          metrics: entry.metrics,
          answers: entry.answers,
          error: entry.error,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
