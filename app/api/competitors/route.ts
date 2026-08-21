import { ApiError, apiErrorResponse, requireWorkspace } from "@/lib/server/http";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getStateRepository } from "@/lib/server/repository";
import type { CompetitorProfile } from "@/lib/server/contracts";

const MAX_PHRASES = 8;
const MAX_PHRASE_LENGTH = 120;

function sanitizePhraseList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const phrase = entry.replace(/\s+/g, " ").trim();
    if (!phrase || phrase.length > MAX_PHRASE_LENGTH) continue;
    const key = phrase.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push(phrase);
    if (cleaned.length >= MAX_PHRASES) break;
  }
  return cleaned;
}

/**
 * Applies user edits to already-analyzed competitor profiles. Only
 * keyphrases/painPhrases are user-editable -- name, summary, productCategory
 * and status/error are what analysis actually found on the competitor's
 * site, so this never lets a request silently rewrite them. Edits are
 * matched to an existing profile by url; unknown urls (not previously
 * analyzed) are ignored rather than allowing arbitrary new competitor
 * entries to bypass analyzeCompetitorUrls entirely.
 */
function applyCompetitorEdits(
  existing: readonly CompetitorProfile[],
  edits: unknown,
): CompetitorProfile[] {
  if (!Array.isArray(edits)) return [...existing];
  const editsByUrl = new Map<string, unknown>();
  for (const entry of edits) {
    if (entry && typeof entry === "object" && typeof (entry as { url?: unknown }).url === "string") {
      editsByUrl.set((entry as { url: string }).url, entry);
    }
  }
  return existing.map((profile) => {
    const edit = editsByUrl.get(profile.url) as
      | { keyphrases?: unknown; painPhrases?: unknown }
      | undefined;
    if (!edit) return profile;
    return {
      ...profile,
      keyphrases: "keyphrases" in edit ? sanitizePhraseList(edit.keyphrases) : profile.keyphrases,
      painPhrases: "painPhrases" in edit ? sanitizePhraseList(edit.painPhrases) : profile.painPhrases,
    };
  });
}

/**
 * Saves the user's edits to already-analyzed competitor phrases. Split from
 * POST /api/competitors/analyze the same way discovery-terms splits analyze
 * from edit: analysis costs a crawl and an AI call and should only happen
 * on request, edits are free and should be cheap to save repeatedly.
 */
export async function PUT(request: Request) {
  try {
    assertRateLimit(request, "competitors:edit", { limit: 30, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = (await request.json().catch(() => null)) as
      | { scanId?: unknown; competitorProfiles?: unknown }
      | null;

    const scanId = typeof body?.scanId === "string" ? body.scanId.trim() : "";
    if (!scanId) throw new ApiError("scanId is required.", 400, "scan_id_required");
    const scan = await requireOwnedScan(actor.workspaceId, scanId);

    if (scan.status === "running" || scan.status === "retrying" || scan.status === "complete") {
      throw new ApiError(
        "Competitors can only be edited before the Reddit scan starts.",
        409,
        "scan_already_started",
      );
    }

    const competitorProfiles = applyCompetitorEdits(
      scan.competitorProfiles ?? [],
      body?.competitorProfiles,
    );
    await getStateRepository().saveScan({
      ...scan,
      competitorProfiles,
      updatedAt: new Date().toISOString(),
    });

    return Response.json({ competitorProfiles }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
