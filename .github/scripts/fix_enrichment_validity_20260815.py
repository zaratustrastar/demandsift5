from pathlib import Path
import re

provider = Path('lib/providers/reddit.server.ts')
text = provider.read_text()

marker = "function rawExternalId(item: ApifyRedditItem): string {\n"
helper = '''function redditThreadPermalink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "redd.it") {
      url.hash = "";
      url.search = "";
      return url.toString();
    }
    if (host !== "reddit.com" && !host.endsWith(".reddit.com")) return undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    if (commentsIndex < 0 || !segments[commentsIndex + 1]) return undefined;
    const titleIndex = commentsIndex + 2;
    const end = segments[titleIndex] ? titleIndex + 1 : commentsIndex + 2;
    url.pathname = `/${segments.slice(0, end).join("/")}/`;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

'''
if 'function redditThreadPermalink(' not in text:
    if marker not in text:
        raise SystemExit('rawExternalId marker not found')
    text = text.replace(marker, helper + marker, 1)

pattern = re.compile(r'''function enrichedItemForCandidate\(\n  candidate: RedditDiscoveryCandidate,\n  payload: readonly unknown\[\],\n\): unknown \| undefined \{.*?\n\}\n\nfunction enrichedConversation''', re.S)
replacement = '''function enrichedItemForCandidate(
  candidate: RedditDiscoveryCandidate,
  payload: readonly unknown[],
): unknown | undefined {
  const candidateId = candidate.externalId.replace(/^t[13]_/i, "").toLowerCase();
  const exact = payload.find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as ApifyRedditItem;
    const dataType = stringValue(item.dataType, 20).toLowerCase();
    if (dataType !== candidate.kind) return false;
    const itemId = rawExternalId(item).replace(/^t[13]_/i, "").toLowerCase();
    return Boolean(itemId && itemId === candidateId);
  });
  if (exact) return exact;

  // Comment deep-links are not guaranteed to be emitted as an item by the Actor
  // even when the Actor successfully opens the parent thread. Discovery already
  // verified the matched author's words, so any item from the same Reddit thread
  // is a safe anchor for adding surrounding context without substituting content.
  const postId = candidate.permalink ? redditPostIdFromPermalink(candidate.permalink) : undefined;
  if (!postId) return undefined;
  return payload.find((value) => postIdForItem(value) === postId);
}

function enrichedConversation'''
text, n = pattern.subn(replacement, text, count=1)
if n != 1:
    raise SystemExit(f'enrichedItemForCandidate replacement count={n}')

pattern = re.compile(r'''function enrichedConversation\(\n  candidate: RedditDiscoveryCandidate,\n  enrichedValue: unknown,\n  payload: readonly unknown\[\],\n  provider: string,\n\): EnrichedRedditConversation \| null \{.*?\n\}\n\n/\*\*\n \* Preserve a verified discovery record''', re.S)
replacement = '''function enrichedConversation(
  candidate: RedditDiscoveryCandidate,
  enrichedValue: unknown,
  payload: readonly unknown[],
  provider: string,
): EnrichedRedditConversation | null {
  if (!enrichedValue || typeof enrichedValue !== "object" || Array.isArray(enrichedValue)) return null;
  const item = enrichedValue as ApifyRedditItem;
  const anchorId = rawExternalId(item).replace(/^t[13]_/i, "").toLowerCase();
  const candidateId = candidate.externalId.replace(/^t[13]_/i, "").toLowerCase();
  const anchorKind = stringValue(item.dataType, 20).toLowerCase();
  const exactItemMatch = anchorKind === candidate.kind && Boolean(anchorId && anchorId === candidateId);
  const context = structuredContextForCandidate(candidate, payload);
  const threadContext = flattenStructuredContext(context);
  const contentHash = contentFingerprint(
    `${candidate.title ?? ""}\n${candidate.body}\n${JSON.stringify(context)}`,
  );
  return {
    provider,
    sourceMode: candidate.sourceMode,
    externalId: candidate.externalId,
    kind: candidate.kind,
    parentExternalId: candidate.parentExternalId,
    subreddit: candidate.subreddit,
    // The discovery candidate remains authoritative. A same-thread Actor item is
    // only an anchor for surrounding context and must never overwrite the matched
    // author's title/body/identity with another comment from the thread.
    title: candidate.title ?? (cleanRedditText(item.title, 500) || undefined),
    body: candidate.body,
    threadContext: threadContext || undefined,
    structuredContext: context,
    author: candidate.author,
    permalink: candidate.permalink,
    createdAt: candidate.createdAt,
    metrics: candidate.metrics,
    matchedQuery: candidate.matchedQuery,
    matchedQueries: candidate.matchedQueries,
    discoveryLanes: candidate.discoveryLanes,
    provenance: {
      ...candidate.provenance,
      provider,
      contentHash,
      observedAt: new Date().toISOString(),
      metadata: {
        ...(candidate.provenance.metadata ?? {}),
        enriched: true,
        enrichmentMatch: exactItemMatch ? "exact-item" : "same-thread-anchor",
      },
    },
  };
}

/**
 * Preserve a verified discovery record'''
text, n = pattern.subn(replacement, text, count=1)
if n != 1:
    raise SystemExit(f'enrichedConversation replacement count={n}')

start = text.index('  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {')
end = text.index('  /** Deprecated compatibility path. The active scan uses discover -> AI -> enrich. */', start)
method = '''  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const candidates = request.candidates.slice(0, this.enrichmentLimit);
    if (candidates.length === 0) {
      return {
        conversations: [],
        sourceMode: this.sourceMode,
        diagnostics: { requested: 0, enriched: 0, failed: 0, fallbackUsed: 0 },
      };
    }
    const maxComments = Math.max(
      0,
      Math.min(request.maxComments ?? this.enrichmentComments, 20),
    );
    const buildInput = (batch: readonly RedditDiscoveryCandidate[]): ApifyEnrichmentActorInput => {
      const threadUrls = [...new Set(batch.flatMap((candidate) => {
        const url = redditThreadPermalink(candidate.permalink);
        return url ? [url] : [];
      }))];
      return {
        startUrls: threadUrls.map((url) => ({ url })),
        skipComments: false,
        skipUserPosts: true,
        skipCommunity: true,
        includeMediaLinks: true,
        includeNSFW: false,
        maxItems: Math.min(
          100,
          Math.max(
            APIFY_REDDIT_ENRICHMENT_MIN_ITEMS,
            Math.max(1, threadUrls.length) * (maxComments + 1),
          ),
        ),
        maxPostCount: Math.max(1, threadUrls.length),
        maxComments,
        maxCommunitiesCount: 0,
        maxUserCount: 0,
        scrollTimeout: 20,
        navigationTimeout: 30,
        debugMode: false,
        proxy: {
          useApifyProxy: true,
          apifyProxyGroups: ["RESIDENTIAL"],
        },
      };
    };

    const primaryInput = buildInput(candidates);
    if (primaryInput.startUrls.length === 0) {
      return {
        conversations: candidates.map((candidate) =>
          discoveryFallbackConversation(candidate, `apify:${this.actorId}`),
        ),
        sourceMode: this.sourceMode,
        diagnostics: {
          requested: candidates.length,
          enriched: 0,
          failed: candidates.length,
          fallbackUsed: candidates.length,
          failureReason: "missing_reddit_thread_urls",
        },
      };
    }

    let payload: unknown[];
    try {
      payload = await this.runActor(primaryInput, apifyEnrichmentTimeoutMs(this.timeoutMs));
    } catch (error) {
      console.error("Apify Reddit thread enrichment failed", error);
      const message = error instanceof Error ? error.message : "Unknown Apify enrichment failure.";
      return {
        conversations: candidates.map((candidate) =>
          discoveryFallbackConversation(candidate, `apify:${this.actorId}`),
        ),
        sourceMode: this.sourceMode,
        diagnostics: {
          requested: candidates.length,
          enriched: 0,
          failed: candidates.length,
          fallbackUsed: candidates.length,
          failureReason: `actor_error:${message.slice(0, 500)}`,
        },
      };
    }

    const mapped = new Map<string, EnrichedRedditConversation>();
    const mapFromPayload = (batch: readonly RedditDiscoveryCandidate[], sourcePayload: readonly unknown[]) => {
      for (const candidate of batch) {
        if (mapped.has(candidate.externalId)) continue;
        const anchor = enrichedItemForCandidate(candidate, sourcePayload);
        if (!anchor) continue;
        const conversation = enrichedConversation(
          candidate,
          anchor,
          sourcePayload,
          `apify:${this.actorId}`,
        );
        if (conversation) mapped.set(candidate.externalId, conversation);
      }
    };

    mapFromPayload(candidates, payload);
    const initiallyUnmatched = candidates.filter((candidate) => !mapped.has(candidate.externalId));
    let recoveryAttempted = false;
    let recovered = 0;
    let recoveryPayloadItems = 0;
    let recoveryError = false;

    // A single bounded recovery run protects future scans from partial multi-URL
    // Actor datasets. It runs only after a successful paid run whose dataset did
    // not map completely, so normal scans keep the one-run cost profile.
    if (initiallyUnmatched.length > 0) {
      const recoveryInput = buildInput(initiallyUnmatched);
      if (recoveryInput.startUrls.length > 0) {
        recoveryAttempted = true;
        try {
          const recoveryPayload = await this.runActor(
            recoveryInput,
            apifyEnrichmentTimeoutMs(this.timeoutMs),
          );
          recoveryPayloadItems = recoveryPayload.length;
          const before = mapped.size;
          mapFromPayload(initiallyUnmatched, recoveryPayload);
          recovered = mapped.size - before;
        } catch (error) {
          recoveryError = true;
          console.error("Apify Reddit thread enrichment recovery failed", error);
        }
      }
    }

    const conversations = candidates.map((candidate) =>
      mapped.get(candidate.externalId) ??
        discoveryFallbackConversation(candidate, `apify:${this.actorId}`),
    );
    const failed = candidates.length - mapped.size;
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: candidates.length,
        enriched: mapped.size,
        failed,
        fallbackUsed: failed,
        ...(failed > 0
          ? {
              failureReason:
                `actor_succeeded_mapping_failure:unmatched=${failed};payload_items=${payload.length};` +
                `recovery_attempted=${recoveryAttempted ? 1 : 0};recovered=${recovered};` +
                `recovery_payload_items=${recoveryPayloadItems};recovery_error=${recoveryError ? 1 : 0}`,
            }
          : {}),
      },
    };
  }

'''
text = text[:start] + method + text[end:]
provider.write_text(text)

workflow = Path('lib/server/scan-workflow.ts')
text = workflow.read_text()
old = '''    const enrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
    });
    await setStage(
      scan,
      "enrichment",
      "complete",
      `${enrichment.diagnostics.enriched} conversation${enrichment.diagnostics.enriched === 1 ? "" : "s"} enriched; ${enrichment.diagnostics.fallbackUsed} verified discovery fallback${enrichment.diagnostics.fallbackUsed === 1 ? "" : "s"} used.`,
    );

    await setStage(scan, "qualification", "active");
'''
new = '''    const enrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
    });
    const requiredFullContextReviews = Math.min(
      minimumFullContextReviews(lookbackDays),
      selectedForEnrichment.length,
    );
    if (enrichment.diagnostics.enriched < requiredFullContextReviews) {
      const detail =
        `Thread context could be verified for only ${enrichment.diagnostics.enriched} of ` +
        `${selectedForEnrichment.length} selected conversations; ${requiredFullContextReviews} are required. ` +
        "The scan will not publish a definitive zero or incomplete intelligence report.";
      await setStage(scan, "enrichment", "failed", detail);
      throw new ApiError(detail, 502, "reddit_enrichment_failed");
    }
    await setStage(
      scan,
      "enrichment",
      "complete",
      `${enrichment.diagnostics.enriched} conversation${enrichment.diagnostics.enriched === 1 ? "" : "s"} received additional thread context; ${enrichment.diagnostics.fallbackUsed} discovery-only fallback${enrichment.diagnostics.fallbackUsed === 1 ? "" : "s"} used.`,
    );

    await setStage(scan, "qualification", "active");
'''
if old not in text:
    raise SystemExit('scan enrichment block not found')
text = text.replace(old, new, 1)

old = '''    const deepRows = [...deepById.values()];
    const relevantCompetitorByExternalId = new Map<string, string | null>();
    const relevantDeepRows = deepRows.filter((row) => {
'''
new = '''    const deepRows = [...deepById.values()];
    const hasVerifiedThreadContext = (conversation: EnrichedRedditConversation): boolean =>
      conversation.sourceMode !== "apify-test" || conversation.provenance.metadata?.enriched === true;
    const incompleteQualifiedLead = deepRows.find((row) =>
      isQualifiedPotentialCustomer(row.qualification) && !hasVerifiedThreadContext(row.conversation),
    );
    if (incompleteQualifiedLead) {
      throw new ApiError(
        "A qualified Reddit candidate could not be verified with thread context. The scan will retry rather than publish an incomplete lead.",
        502,
        "reddit_enrichment_failed",
      );
    }
    const relevantCompetitorByExternalId = new Map<string, string | null>();
    const relevantDeepRows = deepRows.filter((row) => {
      if (!hasVerifiedThreadContext(row.conversation)) return false;
'''
if old not in text:
    raise SystemExit('deepRows block not found')
text = text.replace(old, new, 1)

old = '''      // A public acquisition opportunity must be both a plausible customer and
      // appropriate to answer. Non-replyable demand still contributes to the
      // source-backed intelligence layer, but it must not become a lead card
      // without the grounded reply promised by the product.
      if (!isQualifiedPotentialCustomer(qualification)) return [];
'''
new = '''      // A public acquisition opportunity must be both a plausible customer and
      // appropriate to answer. Non-replyable demand still contributes to the
      // source-backed intelligence layer, but it must not become a lead card
      // without the grounded reply promised by the product. Apify discovery-only
      // fallbacks are never promoted as reply-ready leads.
      if (!isQualifiedPotentialCustomer(qualification) || !hasVerifiedThreadContext(conversation)) return [];
'''
if old not in text:
    raise SystemExit('opportunity invariant block not found')
workflow.write_text(text.replace(old, new, 1))

presenter = Path('lib/server/presenter.ts')
text = presenter.read_text()
old = '''      qualificationCoverage: {
        credibleCandidates: result.diagnostics.deterministicSurvivors,
        fullContextReviewed:
          result.diagnostics.submittedForDeepQualification + result.diagnostics.reusedUnchanged,
      },
'''
new = '''      qualificationCoverage: {
        credibleCandidates: result.diagnostics.deterministicSurvivors,
        // Only provider-confirmed thread enrichment counts as context coverage.
        // Discovery-only fallbacks may still be classified internally, but are
        // never presented to the user as full-context review.
        fullContextReviewed: result.diagnostics.enrichedSuccessfully,
      },
'''
if old not in text:
    raise SystemExit('presenter qualificationCoverage block not found')
presenter.write_text(text.replace(old, new, 1))

dashboard = Path('components/demand-intelligence/ProductDashboard.tsx')
text = dashboard.read_text()
text = text.replace(
    'credible recent candidates with full conversation context.',
    'credible recent candidates with additional Reddit thread context.',
)
text = text.replace('Full-context reviewed · Source linked', 'Thread-context reviewed · Source linked')
dashboard.write_text(text)

tests = Path('tests/apify-reddit-provider.test.mjs')
text = tests.read_text()
insert_before = 'test("controlled live enrichment probe opens and maps one selected thread", {'
if insert_before not in text:
    raise SystemExit('live enrichment probe marker not found')
regression = r'''
test("comment enrichment uses same-thread context when Actor omits the exact comment item", async () => {
  const candidate = {
    provider: "apify-test",
    sourceMode: "apify-test",
    externalId: "missingcomment",
    kind: "comment",
    parentExternalId: "t3_abc123",
    subreddit: "SaaS",
    title: undefined,
    body: "I need something simpler for keeping family screen time under control.",
    author: "parent_user",
    permalink: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/missingcomment/",
    createdAt: documentedComment.createdAt,
    metrics: { score: 3, comments: 1 },
    matchedQueries: ["family screen time control"],
    discoveryLanes: ["direct_buying_intent"],
    provenance: {
      id: "reddit_apify_missingcomment",
      kind: "reddit",
      provider: "apify-test",
      providerExternalId: "missingcomment",
      url: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/missingcomment/",
      excerpt: "I need something simpler for keeping family screen time under control.",
      contentHash: "hash-missingcomment",
      observedAt: "2026-08-14T00:00:00.000Z",
      isMock: false,
      metadata: { testOnly: true },
    },
  };
  const calls = [];
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper-lite",
    token: "private-apify-token",
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      calls.push({ url: parsedUrl, init, input: init.body ? JSON.parse(init.body) : null });
      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        return new Response(JSON.stringify({
          data: { id: "run-comment-thread", status: "SUCCEEDED", defaultDatasetId: "dataset-comment-thread" },
        }), { status: 201 });
      }
      if (parsedUrl.pathname.includes("/datasets/dataset-comment-thread/items")) {
        // Exact candidate comment is deliberately absent. The post and another
        // comment prove the Actor opened the correct thread.
        return new Response(JSON.stringify([documentedActorItem, documentedComment]), { status: 200 });
      }
      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const result = await provider.enrich({ candidates: [candidate], maxComments: 6 });
  assert.equal(result.diagnostics.enriched, 1);
  assert.equal(result.diagnostics.failed, 0);
  assert.equal(result.conversations[0].externalId, "missingcomment");
  assert.equal(result.conversations[0].body, candidate.body, "same-thread anchor must not replace the matched author's words");
  assert.equal(result.conversations[0].structuredContext.matched.body, candidate.body);
  assert.equal(result.conversations[0].structuredContext.originalPost.externalId, "abc123");
  assert.equal(result.conversations[0].provenance.metadata.enriched, true);
  assert.equal(result.conversations[0].provenance.metadata.enrichmentMatch, "same-thread-anchor");
  const start = calls.find((call) => call.init.method === "POST");
  assert.ok(start);
  assert.deepEqual(start.input.startUrls, [{
    url: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/",
  }]);
});

'''
if 'comment enrichment uses same-thread context' not in text:
    text = text.replace(insert_before, regression + insert_before, 1)
text = text.replace(
    r'/^actor_succeeded_mapping_failure:unmatched=1;invalid=0;payload_items=1$/',
    r'/^actor_succeeded_mapping_failure:unmatched=1;payload_items=1;recovery_attempted=1;recovered=0;recovery_payload_items=1;recovery_error=0$/',
)
tests.write_text(text)

trust = Path('tests/demand-intelligence-trust.test.mjs')
text = trust.read_text()
append = r'''

test("context coverage counts only successful provider enrichment and incomplete floors fail closed", async () => {
  const [workflow, presenter, dashboard] = await Promise.all([
    source("lib/server/scan-workflow.ts"),
    source("lib/server/presenter.ts"),
    source("components/demand-intelligence/ProductDashboard.tsx"),
  ]);
  assert.match(workflow, /enrichment\.diagnostics\.enriched < requiredFullContextReviews/);
  assert.match(workflow, /reddit_enrichment_failed/);
  assert.match(workflow, /hasVerifiedThreadContext/);
  assert.match(presenter, /fullContextReviewed: result\.diagnostics\.enrichedSuccessfully/);
  assert.match(dashboard, /additional Reddit thread context/);
  assert.doesNotMatch(dashboard, /credible recent candidates with full conversation context/);
});
'''
if 'context coverage counts only successful provider enrichment' not in text:
    text += append
trust.write_text(text)
