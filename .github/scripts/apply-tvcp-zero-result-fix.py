from pathlib import Path


def one(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"{path}: expected one literal match, found {n}")
    p.write_text(text.replace(old, new, 1))


pipeline = Path("lib/intelligence/reddit-pipeline.ts")
text = pipeline.read_text()
old = '''function zeroResultAuditSignalWeight(value: ConversationTriage["demandSignal"]): number {
  if (value === "explicit_demand") return 40;
  if (value === "switching") return 35;
  if (value === "pain") return 30;
  if (value === "workaround") return 25;
  if (value === "timing") return 20;
  return 0;
}

/**
 * Acquisition-only false-zero guard. Lightweight triage is intentionally cheap
 * and high recall, but it can still under-estimate product fit from a short
 * discovery snippet. If it selects nobody, escalate only a tiny number of
 * candidates where triage itself observed current demand/pain/switching evidence.
 * Deep qualification remains the only path that can create an opportunity.
 */
export function selectZeroResultAuditCandidates(input: {
  candidates: readonly RedditDiscoveryCandidate[];
  triageById: ReadonlyMap<string, ConversationTriage>;
  budget?: number;
}): RedditDiscoveryCandidate[] {
  const budget = Math.max(1, Math.min(Math.trunc(input.budget ?? 3), 3));
  const auditableIntents = new Set<TriageIntent>([
    "actively_looking",
    "evaluating",
    "switching",
    "problem_aware",
  ]);

  return input.candidates
    .flatMap((candidate) => {
      const triage = input.triageById.get(candidate.externalId);
      if (!triage || triage.worthEnriching || triage.demandSignal === "none") return [];
      if (!auditableIntents.has(triage.intent)) return [];
      if (triage.timing !== "current" && triage.timing !== "near_term") return [];

      let priority = intentSelectionWeight(triage.intent);
      priority += zeroResultAuditSignalWeight(triage.demandSignal);
      priority += fitSelectionWeight(triage.productFit) / 4;
      priority += fitSelectionWeight(triage.replyability) / 4;
      priority += triage.timing === "current" ? 12 : 8;
      return [{ candidate, priority }];
    })
    .sort((left, right) => right.priority - left.priority)
    .slice(0, budget)
    .map(({ candidate }) => candidate);
}
'''
new = '''function zeroResultAuditSignalWeight(value: ConversationTriage["demandSignal"]): number {
  if (value === "explicit_demand") return 40;
  if (value === "switching") return 35;
  if (value === "pain") return 30;
  if (value === "workaround") return 25;
  if (value === "timing") return 20;
  return 0;
}

function zeroResultAuditLaneWeight(candidate: RedditDiscoveryCandidate): number {
  let strongest = 0;
  for (const lane of candidate.discoveryLanes) {
    if (lane === "explicit_demand" || lane === "direct_buying_intent") strongest = Math.max(strongest, 45);
    else if (lane === "switching" || lane === "competitor_switching") strongest = Math.max(strongest, 40);
    else if (lane === "pain" || lane === "problem_pain") strongest = Math.max(strongest, 35);
    else if (lane === "category_recommendation") strongest = Math.max(strongest, 32);
    else if (lane === "workaround") strongest = Math.max(strongest, 30);
    else if (lane === "timing") strongest = Math.max(strongest, 25);
  }
  return strongest;
}

/**
 * False-zero guard. Lightweight triage is intentionally cheap and high recall,
 * but the exact failure we need to defend against is triage missing the demand
 * signal itself. Therefore the audit has two independent inputs: triage evidence
 * and the bounded high-signal retrieval lane that produced the candidate.
 *
 * This function never creates a lead. It only spends a tiny enrichment/deep-
 * qualification budget so the strict full-context classifier can confirm or
 * reject the candidate. Promotional noise is never escalated, and an explicit
 * triage rejection is only auditable when retrieval came from the strongest
 * buying/switching lanes.
 */
export function selectZeroResultAuditCandidates(input: {
  candidates: readonly RedditDiscoveryCandidate[];
  triageById: ReadonlyMap<string, ConversationTriage>;
  budget?: number;
}): RedditDiscoveryCandidate[] {
  const budget = Math.max(1, Math.min(Math.trunc(input.budget ?? 3), 3));
  const auditableIntents = new Set<TriageIntent>([
    "actively_looking",
    "evaluating",
    "switching",
    "problem_aware",
    "informational",
  ]);

  return input.candidates
    .flatMap((candidate) => {
      const triage = input.triageById.get(candidate.externalId);
      if (!triage || triage.worthEnriching || triage.intent === "promotional") return [];

      const laneWeight = zeroResultAuditLaneWeight(candidate);
      const hasTriageSignal = triage.demandSignal !== "none";
      const highSignalRetrieval = laneWeight >= 30;
      const strongestRetrieval = laneWeight >= 40;
      if (!hasTriageSignal && !highSignalRetrieval) return [];
      if (triage.intent === "irrelevant" && !strongestRetrieval) return [];
      if (!auditableIntents.has(triage.intent) && triage.intent !== "irrelevant") return [];

      const currentTiming = triage.timing === "current" || triage.timing === "near_term";
      if (!currentTiming && !highSignalRetrieval) return [];

      let priority = laneWeight;
      priority += intentSelectionWeight(triage.intent);
      priority += zeroResultAuditSignalWeight(triage.demandSignal);
      priority += fitSelectionWeight(triage.productFit) / 4;
      priority += fitSelectionWeight(triage.replyability) / 4;
      if (triage.timing === "current") priority += 12;
      else if (triage.timing === "near_term") priority += 8;
      return [{ candidate, priority }];
    })
    .sort((left, right) => right.priority - left.priority)
    .slice(0, budget)
    .map(({ candidate }) => candidate);
}
'''
if text.count(old) != 1:
    raise SystemExit("reddit-pipeline.ts zero-result block did not match exactly")
pipeline.write_text(text.replace(old, new, 1))

one(
    "lib/server/scan-workflow.ts",
    '''    const zeroResultAuditCandidates = !previousResult && worthEnriching.length === 0
      ? selectZeroResultAuditCandidates({
          candidates: cleaned.survivors,
          triageById,
          budget: Math.min(3, enrichmentBudget()),
        })
      : [];
    const triageDetail = zeroResultAuditCandidates.length > 0
      ? `${cleaned.survivors.length} of ${cleaned.survivors.length} credible candidates were accounted for; lightweight triage selected none, so ${zeroResultAuditCandidates.length} current demand-signal candidate${zeroResultAuditCandidates.length === 1 ? " was" : "s were"} escalated for a bounded full-context audit.`
      : `${cleaned.survivors.length} of ${cleaned.survivors.length} credible candidates were accounted for; ${worthEnriching.length} warranted full-context review.`;
''',
    '''    const zeroResultAuditCandidates = worthEnriching.length === 0
      ? selectZeroResultAuditCandidates({
          candidates: cleaned.survivors,
          triageById,
          // Acquisition gets a three-candidate audit. Incremental scans get one
          // independent deep check so a cached/cheap triage false-negative cannot
          // silently turn real demand into a valid-looking zero.
          budget: Math.min(previousResult ? 1 : 3, enrichmentBudget()),
        })
      : [];
    const triageDetail = zeroResultAuditCandidates.length > 0
      ? `${cleaned.survivors.length} of ${cleaned.survivors.length} credible candidates were accounted for; lightweight triage selected none, so ${zeroResultAuditCandidates.length} high-signal candidate${zeroResultAuditCandidates.length === 1 ? " was" : "s were"} escalated for an independent full-context audit.`
      : `${cleaned.survivors.length} of ${cleaned.survivors.length} credible candidates were accounted for; ${worthEnriching.length} warranted full-context review.`;
''',
)

one(
    "lib/server/contracts.ts",
    "  worthEnriching: number;\n  requestedForEnrichment: number;\n",
    "  worthEnriching: number;\n  zeroResultAuditEscalated: number;\n  requestedForEnrichment: number;\n",
)

one(
    "lib/server/scan-workflow.ts",
    "      worthEnriching: worthEnriching.length,\n      requestedForEnrichment: enrichment.diagnostics.requested,\n",
    "      worthEnriching: worthEnriching.length,\n      zeroResultAuditEscalated: zeroResultAuditCandidates.length,\n      requestedForEnrichment: enrichment.diagnostics.requested,\n",
)

test_path = Path("tests/reddit-intelligence-pipeline.test.mjs")
test_text = test_path.read_text()
marker = 'test("ranking happens after categorical qualification and does not change leadStatus", () => {'
if marker not in test_text:
    raise SystemExit("test insertion marker not found")
addition = '''test("zero-result audit independently checks a high-signal retrieval false negative", () => {
  const rows = [
    candidate({ externalId: "missed", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "promo2", discoveryLanes: ["direct_buying_intent"] }),
    candidate({ externalId: "weak", discoveryLanes: ["timing"] }),
  ];
  const triage = new Map([
    ["missed", { externalId: "missed", relevant: false, intent: "irrelevant", demandSignal: "none", productFit: "unknown", timing: "unknown", replyability: "unknown", worthEnriching: false, reason: "cheap triage missed the signal" }],
    ["promo2", { externalId: "promo2", relevant: false, intent: "promotional", demandSignal: "none", productFit: "unknown", timing: "current", replyability: "low", worthEnriching: false, reason: "promotion" }],
    ["weak", { externalId: "weak", relevant: false, intent: "informational", demandSignal: "none", productFit: "unknown", timing: "unknown", replyability: "low", worthEnriching: false, reason: "weak timing-only retrieval" }],
  ]);

  const selected = pipeline.selectZeroResultAuditCandidates({ candidates: rows, triageById: triage, budget: 3 });
  assert.deepEqual(selected.map((row) => row.externalId), ["missed"]);
});

'''
test_path.write_text(test_text.replace(marker, addition + marker, 1))

route = Path("app/api/internal/diagnostics/recent-scans/route.ts")
route.parent.mkdir(parents=True, exist_ok=True)
route.write_text('''import { desc, ilike } from "drizzle-orm";

import { getDb } from "@/db";
import { runtimeScans } from "@/db/postgres/schema";
import { apiErrorResponse, ApiError } from "@/lib/server/http";

function safeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function requireWorker(request: Request) {
  const secret = process.env.BACKGROUND_WORKER_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new ApiError("Background worker authentication is not configured.", 503, "worker_unavailable");
  }
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
  if (!safeEqual(secret, supplied)) throw new ApiError("Worker authentication failed.", 401, "unauthorized");
}

function triageBreakdown(record: (typeof runtimeScans.$inferSelect)["record"]) {
  const states = record.result?.processedRedditState ?? [];
  return states.reduce<Record<string, number>>((counts, state) => {
    const key = [
      state.triage.worthEnriching ? "selected" : "not_selected",
      state.triage.intent,
      state.triage.demandSignal,
      state.triage.productFit,
      state.triage.timing,
    ].join("|");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function deepBreakdown(record: (typeof runtimeScans.$inferSelect)["record"]) {
  const states = record.result?.processedRedditState ?? [];
  return states.reduce<Record<string, number>>((counts, state) => {
    const deep = state.deepQualification;
    if (!deep) return counts;
    const key = [deep.leadStatus, deep.intent, deep.productFit, deep.timing, deep.evidenceQuality].join("|");
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

export async function GET(request: Request) {
  try {
    requireWorker(request);
    const domain = new URL(request.url).searchParams.get("domain")?.trim().toLowerCase() ?? "";
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$/.test(domain)) {
      throw new ApiError("domain is invalid.", 400, "invalid_domain");
    }

    const rows = await getDb()
      .select({
        id: runtimeScans.id,
        status: runtimeScans.status,
        record: runtimeScans.record,
        createdAt: runtimeScans.createdAt,
        updatedAt: runtimeScans.updatedAt,
      })
      .from(runtimeScans)
      .where(ilike(runtimeScans.websiteUrl, `%${domain}%`))
      .orderBy(desc(runtimeScans.createdAt))
      .limit(8);

    return Response.json({
      scans: rows.map((row) => {
        const result = row.record.result;
        return {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          progress: row.record.progress.map((stage) => ({ id: stage.id, status: stage.status, detail: stage.detail })),
          windowDays: result?.potentialCustomers.windowDays ?? null,
          diagnostics: result?.diagnostics ?? null,
          retrieval: result?.retrievalDiagnostics
            ? {
                queryCount: result.retrievalDiagnostics.queryCount,
                matchedCandidatesByLane: result.retrievalDiagnostics.matchedCandidatesByLane,
                worthEnrichingByLane: result.retrievalDiagnostics.worthEnrichingByLane,
                fetchedCandidates: result.retrievalDiagnostics.fetchedCandidates,
                normalizedCandidates: result.retrievalDiagnostics.normalizedCandidates,
                locallyMatchedCandidates: result.retrievalDiagnostics.locallyMatchedCandidates,
                enrichmentAttempts: result.retrievalDiagnostics.enrichmentAttempts,
                enrichedConversations: result.retrievalDiagnostics.enrichedConversations,
              }
            : null,
          triageBreakdown: triageBreakdown(row.record),
          deepBreakdown: deepBreakdown(row.record),
          output: result
            ? {
                opportunities: result.opportunities.length,
                insights: result.insights.length,
                marketIntelligence: result.marketIntelligence.length,
                competitorSignals: result.competitorWeakness.verified ? 1 : 0,
                replies: result.replies.filter((reply) => reply.content.trim()).length,
              }
            : null,
        };
      }),
    }, { headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
''')
