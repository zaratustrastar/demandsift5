import { validatePublicWebsiteUrl, UnsafeWebsiteUrlError } from "@/lib/security/website-crawler";
import { apiErrorResponse, ApiError, createWorkspace, readJson, requireWorkspace, workspaceCookie, type WorkspaceActor } from "@/lib/server/http";
import { presentScan, requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { createScan, enqueueScanRun, runScan, type CreateScanInput } from "@/lib/server/scan-workflow";
import { getStateRepository } from "@/lib/server/repository";

type CreateScanBody = {
  websiteUrl?: unknown;
  website?: unknown;
  /** Freeform "describe your market / idea" text -- the alternative to websiteUrl. */
  contextText?: unknown;
  defer?: unknown;
  /** Create only. The client then analyzes, lets the user review, and starts the scan. */
  reviewFirst?: unknown;
};

const MIN_CONTEXT_TEXT_LENGTH = 20;
const MAX_CONTEXT_TEXT_LENGTH = 4_000;

function responseWithWorkspace(payload: unknown, status: number, cookie: string | undefined): Response {
  // cookie is undefined for a session-resolved actor (see http.ts's
  // workspaceCookie) -- rd_session is already the durable credential in
  // that case, so there's nothing to refresh here.
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (cookie) headers.set("Set-Cookie", cookie);
  return Response.json(payload, { status, headers });
}

export async function POST(request: Request) {
  let actor: WorkspaceActor | null = null;
  try {
    assertRateLimit(request, "scan:create", { limit: 6, windowMs: 10 * 60_000 });
    const body = await readJson<CreateScanBody>(request);

    // "Describe your market / idea" and a website are two sources for the
    // same downstream pipeline (see scan-workflow.ts's runScan); a non-empty
    // contextText selects that path regardless of whether websiteUrl was
    // also sent, so the client only ever needs to send the field for the tab
    // the user actually has open.
    const contextCandidate = typeof body.contextText === "string" ? body.contextText.trim() : "";
    const isContextMode = contextCandidate.length > 0;

    let scanInput: CreateScanInput;
    if (isContextMode) {
      if (contextCandidate.length < MIN_CONTEXT_TEXT_LENGTH) {
        throw new ApiError(
          "Tell us a bit more -- a sentence or two about your business, market or idea.",
          400,
          "context_text_too_short",
        );
      }
      if (contextCandidate.length > MAX_CONTEXT_TEXT_LENGTH) {
        throw new ApiError("That description is too long.", 400, "context_text_too_long");
      }
      scanInput = { contextText: contextCandidate };
    } else {
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
      scanInput = { websiteUrl: validated.url.toString() };
    }

    try {
      actor = await requireWorkspace(request);
    } catch {
      actor = await createWorkspace();
    }
    const scan = await createScan(actor.workspaceId, scanInput);
    if (body.reviewFirst === true) {
      // The discovery-profile step sits between analysis and Reddit retrieval,
      // so creation must not start the scan. Enqueuing here would have the
      // worker searching Reddit before the user has seen what we plan to
      // look for.
      return responseWithWorkspace(await presentScan(scan), 201, workspaceCookie(actor));
    }
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
