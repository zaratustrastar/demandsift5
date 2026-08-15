from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing expected fragment in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# ---- Server contracts -------------------------------------------------
replace_once(
    "lib/server/contracts.ts",
    '  contextHash: string | null;\n  firstSeenAt: string;',
    '  contextHash: string | null;\n  /** True only when the provider returned enough thread data to verify context. */\n  threadContextVerified?: boolean;\n  firstSeenAt: string;',
)
replace_once(
    "lib/server/contracts.ts",
    '  enrichmentFailures: number;\n  enrichmentFailureReason?: string;\n  submittedForDeepQualification: number;',
    '  enrichmentFailures: number;\n  enrichmentFailureReason?: string;\n  requiredFullContextReviews: number;\n  coverageLimited: boolean;\n  enrichmentReplacementAttempts: number;\n  enrichmentReplacementSuccesses: number;\n  unverifiedPotentialCustomerSignals: number;\n  submittedForDeepQualification: number;',
)

# ---- Scan workflow: retry a different candidate instead of aborting ---
p = Path("lib/server/scan-workflow.ts")
text = p.read_text()
start_marker = '    const selectedForEnrichment = [\n'
end_marker = '    await setStage(scan, "qualification", "active");'
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise SystemExit("could not locate enrichment block")
replacement = r'''    let selectedForEnrichment = [
      ...primaryEnrichmentCandidates,
      ...intelligenceReviewCandidates,
    ];
    let intelligenceCoverageReviews = intelligenceReviewCandidates.length;
    const requiredFullContextReviews = Math.min(
      minimumFullContextReviews(lookbackDays),
      cleaned.survivors.length,
      enrichmentBudget(),
    );
    const hasVerifiedThreadContext = (conversation: EnrichedRedditConversation): boolean =>
      conversation.sourceMode !== "apify-test" || conversation.provenance.metadata?.enriched === true;

    // Enrichment is useful context, not an all-or-nothing website-analysis gate.
    // If one selected Reddit URL cannot be expanded, try the next-best candidate
    // within the existing bounded budget. This protects zero-result confidence
    // without throwing away the website profile, discovery, and triage already done.
    const initialEnrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
    });
    const enrichmentById = new Map<string, EnrichedRedditConversation>();
    let enrichmentRequested = 0;
    const enrichmentFailureReasons: string[] = [];
    const absorbEnrichment = (batch: typeof initialEnrichment) => {
      enrichmentRequested += batch.diagnostics.requested;
      if (batch.diagnostics.failureReason) enrichmentFailureReasons.push(batch.diagnostics.failureReason);
      for (const conversation of batch.conversations) {
        const current = enrichmentById.get(conversation.externalId);
        if (!current || (!hasVerifiedThreadContext(current) && hasVerifiedThreadContext(conversation))) {
          enrichmentById.set(conversation.externalId, conversation);
        }
      }
    };
    absorbEnrichment(initialEnrichment);

    const selectedIds = new Set(selectedForEnrichment.map((candidate) => candidate.externalId));
    const verifiedContextCount = () =>
      [...enrichmentById.values()].filter(hasVerifiedThreadContext).length;
    let enrichmentReplacementAttempts = 0;
    let enrichmentReplacementSuccesses = 0;

    while (
      verifiedContextCount() < requiredFullContextReviews &&
      selectedForEnrichment.length < Math.min(enrichmentBudget(), cleaned.survivors.length)
    ) {
      const remaining = cleaned.survivors.filter((candidate) => !selectedIds.has(candidate.externalId));
      if (remaining.length === 0) break;
      const remainingWorthEnriching = remaining.filter(
        (candidate) => triageById.get(candidate.externalId)?.worthEnriching === true,
      );
      const replacementCandidate = (
        worthEnriching.length === 0
          ? selectZeroResultAuditCandidates({ candidates: remaining, triageById, budget: 1 })[0]
          : selectCandidatesForEnrichment({
              candidates: remainingWorthEnriching,
              triageById,
              budget: 1,
            })[0]
      ) ?? selectCandidatesForIntelligenceReview({
        candidates: remaining,
        triageById,
        budget: 1,
      })[0];
      if (!replacementCandidate) break;

      selectedForEnrichment.push(replacementCandidate);
      selectedIds.add(replacementCandidate.externalId);
      if (triageById.get(replacementCandidate.externalId)?.worthEnriching !== true) {
        intelligenceCoverageReviews += 1;
      }
      enrichmentReplacementAttempts += 1;
      const before = verifiedContextCount();
      const replacementEnrichment = await redditProvider.enrich({
        candidates: [replacementCandidate],
        maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
      });
      absorbEnrichment(replacementEnrichment);
      if (verifiedContextCount() > before) enrichmentReplacementSuccesses += 1;
    }

    const enrichmentConversations = selectedForEnrichment.flatMap((candidate) => {
      const conversation = enrichmentById.get(candidate.externalId);
      return conversation ? [conversation] : [];
    });
    const enrichedSuccessfully = enrichmentConversations.filter(hasVerifiedThreadContext).length;
    const enrichmentFailures = Math.max(0, selectedForEnrichment.length - enrichedSuccessfully);
    const coverageLimited = enrichedSuccessfully < requiredFullContextReviews;
    const enrichment = {
      conversations: enrichmentConversations,
      sourceMode: discovery.sourceMode,
      diagnostics: {
        requested: enrichmentRequested,
        enriched: enrichedSuccessfully,
        failed: enrichmentFailures,
        fallbackUsed: enrichmentFailures,
        ...(enrichmentFailureReasons.length > 0
          ? { failureReason: enrichmentFailureReasons.join(" | ").slice(0, 1_500) }
          : {}),
      },
    };

    await setStage(
      scan,
      "enrichment",
      "complete",
      coverageLimited
        ? `${enrichedSuccessfully} conversation${enrichedSuccessfully === 1 ? "" : "s"} received verified thread context; the ${requiredFullContextReviews}-conversation confidence target was not fully reached after ${enrichmentReplacementAttempts} replacement attempt${enrichmentReplacementAttempts === 1 ? "" : "s"}. The scan will continue and will not present a definitive zero.`
        : `${enrichedSuccessfully} conversation${enrichedSuccessfully === 1 ? "" : "s"} received verified thread context; ${enrichmentFailures} selected conversation${enrichmentFailures === 1 ? "" : "s"} remained discovery-only after bounded recovery.`,
    );

'''
text = text[:start] + replacement + text[end:]
p.write_text(text)

replace_once(
    "lib/server/scan-workflow.ts",
    '    const hasVerifiedThreadContext = (conversation: EnrichedRedditConversation): boolean =>\n      conversation.sourceMode !== "apify-test" || conversation.provenance.metadata?.enriched === true;\n',
    '',
)
old_incomplete = '''    const incompleteQualifiedLead = deepRows.find((row) =>
      isQualifiedPotentialCustomer(row.qualification) && !hasVerifiedThreadContext(row.conversation),
    );
    if (incompleteQualifiedLead) {
      throw new ApiError(
        "A qualified Reddit candidate could not be verified with thread context. The scan will retry rather than publish an incomplete lead.",
        502,
        "reddit_enrichment_failed",
      );
    }
'''
new_incomplete = '''    // A discovery-only fallback may still look promising to deep AI. Keep that
    // provisional judgment in the transparent scan trace, but never promote it
    // to a public lead or market-intelligence claim without verified thread context.
    const unverifiedQualifiedCandidates = deepRows.filter((row) =>
      isQualifiedPotentialCustomer(row.qualification) && !hasVerifiedThreadContext(row.conversation),
    );
'''
replace_once("lib/server/scan-workflow.ts", old_incomplete, new_incomplete)

old_qualification_stage = '''    await setStage(
      scan,
      "qualification",
      "complete",
      `${aggregated.summary.total} unique potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${rawOpportunities.length} qualified conversation${rawOpportunities.length === 1 ? "" : "s"}; ranking was applied only after qualification.`,
    );
'''
new_qualification_stage = '''    await setStage(
      scan,
      "qualification",
      "complete",
      coverageLimited && aggregated.summary.total === 0
        ? `No verified potential customer was promoted from ${enrichedSuccessfully} full-context review${enrichedSuccessfully === 1 ? "" : "s"}. The confidence target was ${requiredFullContextReviews}, so this is a limited-coverage result rather than a definitive zero.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification.` : ""}`
        : `${aggregated.summary.total} unique potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${rawOpportunities.length} qualified conversation${rawOpportunities.length === 1 ? "" : "s"}; ranking was applied only after qualification.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification and was not promoted.` : ""}`,
    );
'''
replace_once("lib/server/scan-workflow.ts", old_qualification_stage, new_qualification_stage)

replace_once(
    "lib/server/scan-workflow.ts",
    '        contextHash,\n        firstSeenAt: previous?.firstSeenAt ?? scan.createdAt,',
    '        contextHash,\n        threadContextVerified: deep ? hasVerifiedThreadContext(deep.conversation) : false,\n        firstSeenAt: previous?.firstSeenAt ?? scan.createdAt,',
)
replace_once(
    "lib/server/scan-workflow.ts",
    '      enrichmentFailures: enrichment.diagnostics.failed,\n      ...(enrichment.diagnostics.failureReason\n        ? { enrichmentFailureReason: enrichment.diagnostics.failureReason }\n        : {}),\n      submittedForDeepQualification: conversationsNeedingDeep.length,',
    '      enrichmentFailures: enrichment.diagnostics.failed,\n      ...(enrichment.diagnostics.failureReason\n        ? { enrichmentFailureReason: enrichment.diagnostics.failureReason }\n        : {}),\n      requiredFullContextReviews,\n      coverageLimited,\n      enrichmentReplacementAttempts,\n      enrichmentReplacementSuccesses,\n      unverifiedPotentialCustomerSignals: unverifiedQualifiedCandidates.length,\n      submittedForDeepQualification: conversationsNeedingDeep.length,',
)

# ---- Presenter: expose the full MVP scan trace ------------------------
replace_once(
    "lib/server/presenter.ts",
    '''      qualificationCoverage: {
        credibleCandidates: result.diagnostics.deterministicSurvivors,
        // Only provider-confirmed thread enrichment counts as context coverage.
        // Discovery-only fallbacks may still be classified internally, but are
        // never presented to the user as full-context review.
        fullContextReviewed: result.diagnostics.enrichedSuccessfully,
      },
''',
    '''      qualificationCoverage: {
        credibleCandidates: result.diagnostics.deterministicSurvivors,
        // Only provider-confirmed thread enrichment counts as context coverage.
        // Discovery-only fallbacks may still be classified internally, but are
        // never presented to the user as full-context review.
        fullContextReviewed: result.diagnostics.enrichedSuccessfully,
        requiredFullContextReviews: result.diagnostics.requiredFullContextReviews ?? 0,
        limited: result.diagnostics.coverageLimited ?? false,
      },
      // MVP transparency: expose every credible candidate that reached AI triage,
      // its exact public Reddit destination, search attribution, and decisions.
      // This is intentionally not paywalled while retrieval/qualification quality
      // is being validated. Raw provider-invalid records remain counts only.
      scanEvidence: {
        searchPlan: result.retrievalDiagnostics?.searchPlan ?? [],
        diagnostics: result.diagnostics,
        candidates: result.processedRedditState.map((state) => ({
          externalId: state.externalId,
          title: state.title,
          excerpt: state.excerpt,
          subreddit: state.subreddit,
          author: state.author,
          permalink: state.canonicalPermalink,
          sourceCreatedAt: state.sourceCreatedAt,
          matchedQueries: state.matchedQueries,
          discoveryLanes: state.discoveryLanes,
          fullContextVerified:
            state.threadContextVerified ?? Boolean(state.contextHash && state.deepQualification),
          triage: state.triage,
          deepQualification: state.deepQualification,
        })),
      },
''',
)

# ---- Client data types ------------------------------------------------
replace_once(
    "components/demand-intelligence/types.ts",
    '''export interface RedditDemandDemoData {
''',
    '''export interface ScanEvidenceCandidate {
  externalId: string;
  title: string | null;
  excerpt: string;
  subreddit: string;
  author: string | null;
  permalink: string | null;
  sourceCreatedAt: string;
  matchedQueries: string[];
  discoveryLanes: string[];
  fullContextVerified: boolean;
  triage: {
    relevant: boolean;
    intent: string;
    demandSignal: string;
    productFit: string;
    timing: string;
    replyability: string;
    worthEnriching: boolean;
    reason: string;
  };
  deepQualification: null | {
    leadStatus: string;
    demandSignals: string[];
    intelligenceTags: string[];
    productFit: string;
    painSeverity: string;
    intent: string;
    timing: string;
    evidenceQuality: string;
    replyability: string;
    whyItMatters: string;
    shouldReply: boolean;
  };
}

export interface ScanEvidence {
  searchPlan: Array<{ lane: string; query: string; seed?: string }>;
  diagnostics: {
    retrieved: number;
    normalized: number;
    deterministicSurvivors: number;
    providerRejectedByReason: Record<string, number>;
    deterministicRejectedByReason: Record<string, number>;
    submittedForTriage: number;
    triageReturned: number;
    worthEnriching: number;
    requestedForEnrichment: number;
    enrichedSuccessfully: number;
    enrichmentFailures: number;
    requiredFullContextReviews?: number;
    coverageLimited?: boolean;
    enrichmentReplacementAttempts?: number;
    enrichmentReplacementSuccesses?: number;
    unverifiedPotentialCustomerSignals?: number;
    submittedForDeepQualification: number;
    deepQualificationsReturned: number;
    potentialCustomerConversations: number;
    uniquePotentialCustomers: number;
  };
  candidates: ScanEvidenceCandidate[];
}

export interface RedditDemandDemoData {
''',
)
replace_once(
    "components/demand-intelligence/types.ts",
    '''  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
  };
''',
    '''  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
    requiredFullContextReviews?: number;
    limited?: boolean;
  };
  scanEvidence?: ScanEvidence;
''',
)

# ---- API-to-dashboard mapping -----------------------------------------
replace_once(
    "components/demand-intelligence/from-scan.ts",
    '''  RedditDemandDemoData,
  RedditOpportunity,
} from "./types";
''',
    '''  RedditDemandDemoData,
  RedditOpportunity,
  ScanEvidence,
} from "./types";
''',
)
replace_once(
    "components/demand-intelligence/from-scan.ts",
    '''  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
  };
''',
    '''  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
    requiredFullContextReviews?: number;
    limited?: boolean;
  };
  scanEvidence?: ScanEvidence;
''',
)
replace_once(
    "components/demand-intelligence/from-scan.ts",
    '    qualificationCoverage: report.qualificationCoverage,\n    lockedResults,',
    '    qualificationCoverage: report.qualificationCoverage,\n    scanEvidence: report.scanEvidence,\n    lockedResults,',
)

# ---- Dashboard: show all queries/candidates/decisions with links -------
replace_once(
    "components/demand-intelligence/ProductDashboard.tsx",
    '''  RedditOpportunity,
  RelevantConversation,
} from "./types";
''',
    '''  RedditOpportunity,
  RelevantConversation,
  ScanEvidence,
} from "./types";
''',
)
p = Path("components/demand-intelligence/ProductDashboard.tsx")
text = p.read_text()
boundary = '\nexport function DemandInsightCard({ insight }: { insight: DemandInsight }) {'
idx = text.find(boundary)
if idx < 0:
    raise SystemExit("could not locate dashboard trace insertion boundary")
trace_component = r'''

export function ScanEvidencePanel({ evidence }: { evidence: ScanEvidence }) {
  const rejected = [
    ...Object.entries(evidence.diagnostics.providerRejectedByReason ?? {}),
    ...Object.entries(evidence.diagnostics.deterministicRejectedByReason ?? {}),
  ].filter(([, count]) => count > 0);

  return (
    <section className={styles.dashboardSection}>
      <div className={styles.sectionHeadingRow}>
        <div>
          <span className={styles.eyebrow}>MVP scan trace</span>
          <h2>Everything this scan found and analyzed</h2>
        </div>
        <span className={styles.qualityNote}>{evidence.candidates.length} credible candidates shown</span>
      </div>

      <section className={`${styles.card} ${styles.profileCard}`}>
        <div className={styles.opportunityMeta}>
          <span><b>{evidence.diagnostics.retrieved}</b> provider records found</span>
          <span><b>{evidence.diagnostics.deterministicSurvivors}</b> credible candidates analyzed</span>
          <span><b>{evidence.diagnostics.worthEnriching}</b> selected by lightweight AI</span>
          <span><b>{evidence.diagnostics.enrichedSuccessfully}</b> full threads verified</span>
          <span><b>{evidence.diagnostics.deepQualificationsReturned}</b> deep AI decisions</span>
        </div>
        {evidence.diagnostics.coverageLimited && (
          <p className={styles.provenanceFootnote}>
            Full-context coverage was limited: {evidence.diagnostics.enrichedSuccessfully} verified versus a target of {evidence.diagnostics.requiredFullContextReviews ?? 0}. This report therefore does not treat zero potential customers as definitive.
          </p>
        )}
        <details>
          <summary><strong>Search plan ({evidence.searchPlan.length} queries)</strong></summary>
          <ul className={styles.cleanList}>
            {evidence.searchPlan.map((entry, index) => (
              <li key={`${entry.lane}-${entry.query}-${index}`}>
                <span className={styles.listDot} />
                <span><b>{intelligenceLabel(entry.lane)}</b>: {entry.query}</span>
              </li>
            ))}
          </ul>
        </details>
        {rejected.length > 0 && (
          <details>
            <summary><strong>Rejected before AI ({rejected.reduce((sum, [, count]) => sum + count, 0)})</strong></summary>
            <div className={styles.opportunityMeta}>
              {rejected.map(([reason, count]) => (
                <span key={reason}><b>{count}</b> {intelligenceLabel(reason)}</span>
              ))}
            </div>
          </details>
        )}
      </section>

      <div className={styles.opportunityStack}>
        {evidence.candidates.map((candidate, index) => {
          const deep = candidate.deepQualification;
          const status = deep
            ? deep.leadStatus === "potential_customer" && !candidate.fullContextVerified
              ? "Provisional customer signal — context not verified"
              : intelligenceLabel(deep.leadStatus)
            : candidate.triage.worthEnriching
              ? "Selected for full-context review"
              : candidate.triage.relevant
                ? "Relevant at lightweight triage"
                : "Not selected by lightweight triage";
          return (
            <details className={styles.opportunityCard} key={candidate.externalId}>
              <summary>
                <strong>{index + 1}. {candidate.title || "Reddit comment"}</strong>
                <span> · r/{candidate.subreddit} · {status}</span>
              </summary>
              <div className={styles.mockExcerpt}>
                <span>Public message excerpt</span>
                <p>“{candidate.excerpt}”</p>
              </div>
              <div className={styles.opportunityMeta}>
                <span><b>{candidate.fullContextVerified ? "Yes" : "No"}</b> full thread context</span>
                <span><b>{intelligenceLabel(candidate.triage.intent)}</b> triage intent</span>
                <span><b>{intelligenceLabel(candidate.triage.productFit)}</b> triage fit</span>
                {deep && <span><b>{intelligenceLabel(deep.leadStatus)}</b> deep result</span>}
              </div>
              <div className={styles.fitReasonGrid}>
                <div>
                  <span className={styles.fieldLabel}>Why lightweight AI made this decision</span>
                  <p>{candidate.triage.reason}</p>
                </div>
                <div>
                  <span className={styles.fieldLabel}>Deep review</span>
                  <p>{deep?.whyItMatters ?? "Not sent to deep qualification."}</p>
                </div>
              </div>
              {candidate.matchedQueries.length > 0 && (
                <div>
                  <span className={styles.fieldLabel}>Matched search attribution</span>
                  <p>{candidate.matchedQueries.join(" · ")}</p>
                </div>
              )}
              {candidate.permalink && (
                <div className={styles.opportunityAction}>
                  <span>Exact discovery message retained from the provider.</span>
                  <a
                    className={styles.secondaryButton}
                    href={candidate.permalink}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Open exact Reddit message <Icon name="external" size={14} />
                  </a>
                </div>
              )}
            </details>
          );
        })}
      </div>
    </section>
  );
}
'''
text = text[:idx] + trace_component + text[idx:]
p.write_text(text)

replace_once(
    "components/demand-intelligence/ProductDashboard.tsx",
    '''                <h1>No candidates passed qualification in this scan.</h1>
                <p>
                  {strongestFallback} Reviewed {data.qualificationCoverage?.fullContextReviewed ?? 0} of {data.qualificationCoverage?.credibleCandidates ?? 0} credible recent candidates with additional Reddit thread context.
                </p>
''',
    '''                <h1>{data.qualificationCoverage?.limited ? "No verified potential customers yet." : "No candidates passed qualification in this scan."}</h1>
                <p>
                  {strongestFallback} Reviewed {data.qualificationCoverage?.fullContextReviewed ?? 0} of {data.qualificationCoverage?.credibleCandidates ?? 0} credible recent candidates with additional Reddit thread context.
                  {data.qualificationCoverage?.limited
                    ? ` The full-context confidence target was ${data.qualificationCoverage.requiredFullContextReviews ?? 0}, so this is not a definitive zero.`
                    : ""}
                </p>
''',
)
market_business = '''        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Why these people were matched</span>
              <h2>Business understanding</h2>
            </div>
          </div>
          <BusinessProfilePanel profile={data.business} />
        </section>

        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Where alternatives leave room</span>
'''
market_business_new = '''        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Why these people were matched</span>
              <h2>Business understanding</h2>
            </div>
          </div>
          <BusinessProfilePanel profile={data.business} />
        </section>

        {data.scanEvidence && <ScanEvidencePanel evidence={data.scanEvidence} />}

        <section className={styles.dashboardSection}>
          <div className={styles.sectionHeadingRow}>
            <div>
              <span className={styles.eyebrow}>Where alternatives leave room</span>
'''
replace_once("components/demand-intelligence/ProductDashboard.tsx", market_business, market_business_new)
replace_once(
    "components/demand-intelligence/ProductDashboard.tsx",
    '      <BusinessProfilePanel profile={data.business} />\n\n      <section className={styles.dashboardSection}>',
    '      <BusinessProfilePanel profile={data.business} />\n\n      {data.scanEvidence && <ScanEvidencePanel evidence={data.scanEvidence} />}\n\n      <section className={styles.dashboardSection}>',
)

# ---- Never blame late Reddit/provider failures on website analysis -----
replace_once(
    "components/ThreadlineExperience.tsx",
    '<h1>We couldn’t analyze that website</h1>',
    '<h1>The scan stopped before every check finished</h1>',
)
replace_once(
    "components/ThreadlineExperience.tsx",
    '<button className={styles.tryAgain} type="button" onClick={() => setView("landing")}>Try another website</button>\n          <div className={styles.domainSafety}>No Reddit results or business claims were created for this failed scan.</div>',
    '<button className={styles.tryAgain} type="button" onClick={() => setView("landing")}>Run another scan</button>\n          <div className={styles.domainSafety}>Completed stages remain recorded. Unverified findings are never promoted as definitive leads.</div>',
)
text = Path("components/ThreadlineExperience.tsx").read_text()
text = text.replace('"Website analysis failed."', '"The scan stopped before completion."')
Path("components/ThreadlineExperience.tsx").write_text(text)

# ---- Tests -------------------------------------------------------------
replace_once(
    "tests/scan-pipeline-architecture.test.mjs",
    '''test("incomplete Reddit thread expansion fails closed before a definitive report", () => {
  assert.ok(source.includes("enrichment.diagnostics.fallbackUsed"));
  assert.ok(source.includes("requiredFullContextReviews"));
  assert.ok(source.includes("enrichment.diagnostics.enriched < requiredFullContextReviews"));
  assert.ok(source.includes('"reddit_enrichment_failed"'));
  assert.ok(source.includes("hasVerifiedThreadContext"));
});
''',
    '''test("incomplete Reddit thread expansion retries replacements and continues with limited coverage", () => {
  assert.ok(source.includes("requiredFullContextReviews"));
  assert.ok(source.includes("enrichmentReplacementAttempts"));
  assert.ok(source.includes("enrichmentReplacementSuccesses"));
  assert.ok(source.includes("coverageLimited"));
  assert.ok(source.includes("hasVerifiedThreadContext"));
  assert.equal(source.includes('throw new ApiError(detail, 502, "reddit_enrichment_failed")'), false);
});
''',
)
Path("tests/mvp-scan-transparency.test.mjs").write_text(r'''import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const presenter = await readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const workflow = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");

test("MVP report exposes every triaged candidate with its exact provider permalink and decisions", () => {
  assert.match(presenter, /scanEvidence:/);
  assert.match(presenter, /result\.processedRedditState\.map/);
  assert.match(presenter, /permalink: state\.canonicalPermalink/);
  assert.match(presenter, /triage: state\.triage/);
  assert.match(presenter, /deepQualification: state\.deepQualification/);
  assert.match(dashboard, /Everything this scan found and analyzed/);
  assert.match(dashboard, /Open exact Reddit message/);
});

test("late Reddit context shortfall does not masquerade as website-analysis failure", () => {
  assert.equal(experience.includes("We couldn’t analyze that website"), false);
  assert.match(experience, /The scan stopped before every check finished/);
  assert.match(workflow, /The scan will continue and will not present a definitive zero/);
  assert.match(workflow, /limited-coverage result rather than a definitive zero/);
});
''')
