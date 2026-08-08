import { validatePublicWebsiteUrl, UnsafeWebsiteUrlError } from "@/lib/security/website-crawler";
import { apiErrorResponse, ApiError, createWorkspace, readJson, requireWorkspace, workspaceCookie, type WorkspaceActor } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { createScan, enqueueScanRun, runScan } from "@/lib/server/scan-workflow";
import { getStateRepository } from "@/lib/server/repository";

type CreateScanBody = { websiteUrl?: unknown; website?: unknown; defer?: unknown };

function responseWithWorkspace(payload: unknown, status: number, cookie: string): Response {
  return Response.json(payload, {
    status,
    headers: { "Set-Cookie": cookie, "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let actor: WorkspaceActor | null = null;
  try {
    assertRateLimit(request, "scan:create", { limit: 6, windowMs: 10 * 60_000 });
    const body = await readJson<CreateScanBody>(request);
    const candidate =
      typeof body.websiteUrl === "string"
        ? body.websiteUrl
        : typeof body.website === "string"
          ? body.website
          : "";
    if (!candidate.trim()) {
      throw new ApiError("Enter a business website URL.", 400, "website_required");
    }
    if (candidate.length > 2_048) {
      throw new ApiError("Website URL is too long.", 400, "invalid_website_url");
    }

    let validated;
    try {
      validated = await validatePublicWebsiteUrl(candidate);
    } catch (error) {
      if (error instanceof UnsafeWebsiteUrlError) {
        throw new ApiError(error.message, 400, "unsafe_website_url");
      }
      throw error;
    }

    try {
      actor = await requireWorkspace(request);
    } catch {
      actor = await createWorkspace();
    }
    const scan = await createScan(actor.workspaceId, validated.url.toString());
    const workerMode = process.env.BACKGROUND_WORKER_MODE?.trim().toLowerCase();
    const canDefer =
      body.defer === true && workerMode === "queue" && getStateRepository().kind === "postgres";
    if (canDefer) {
      const job = await enqueueScanRun(scan);
      return responseWithWorkspace(
        { ...(await presentScan(scan)), job: { id: job.id, status: job.status } },
        202,
        workspaceCookie(actor),
      );
    }
    let completed;
    try {
      completed = await runScan(scan.id);
    } catch (error) {
      const failed = await presentScan(await requireOwnedScan(actor.workspaceId, scan.id));
      const message = error instanceof Error ? error.message : "Website analysis failed.";
      return responseWithWorkspace(
        { ...failed, error: { code: "scan_failed", message } },
        422,
        workspaceCookie(actor),
      );
    }
    return responseWithWorkspace(await presentScan(completed), 201, workspaceCookie(actor));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
