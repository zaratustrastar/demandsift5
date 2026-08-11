import type {
  RedditDiscoveryResponse,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchRequest,
  RedditSearchResponse,
} from "@/lib/providers/contracts";
import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditDiscoveryCandidate,
} from "@/lib/domain/types";
import { contentFingerprint, normalizeSearchText } from "@/lib/intelligence/opportunity-ranking";

interface MockFixture {
  id: string;
  subreddit: string;
  title: (topic: string) => string;
  body: (topic: string, alternative: string) => string;
  ageDays: number;
  score: number;
  comments: number;
  lane: RedditDiscoveryCandidate["discoveryLanes"][number];
}

const FIXTURES: readonly MockFixture[] = [
  {
    id: "mock_buyer_01",
    subreddit: "smallbusiness",
    title: (topic) => `What are people using for ${topic}?`,
    body: (topic) =>
      `I have outgrown my spreadsheet for ${topic}. I need something a small team can set up quickly without a long sales call. What has worked for you?`,
    ageDays: 1,
    score: 19,
    comments: 11,
    lane: "direct_buying_intent",
  },
  {
    id: "mock_problem_02",
    subreddit: "Entrepreneur",
    title: () => "There has to be a less manual way to do this",
    body: (topic) =>
      `Our team loses a few hours every week copying information between tools just to manage ${topic}. Has anyone found a reliable workflow that does not require constant maintenance?`,
    ageDays: 2,
    score: 34,
    comments: 16,
    lane: "problem_pain",
  },
  {
    id: "mock_competitor_03",
    subreddit: "SaaS",
    title: () => "Looking for a simpler alternative",
    body: (topic, alternative) =>
      `We tried ${alternative}, but the setup and pricing are difficult to justify for our use case. I mainly need ${topic} and clear reporting. Any lighter alternatives?`,
    ageDays: 3,
    score: 12,
    comments: 9,
    lane: "competitor_switching",
  },
  {
    id: "mock_question_04",
    subreddit: "marketing",
    title: (topic) => `How do you evaluate tools for ${topic}?`,
    body: (topic) =>
      `I am comparing a few options for ${topic}. Which capabilities actually matter in practice, and what should I avoid paying extra for?`,
    ageDays: 5,
    score: 8,
    comments: 14,
    lane: "category_recommendation",
  },
  {
    id: "mock_switch_05",
    subreddit: "startups",
    title: () => "Our current process stopped scaling",
    body: (topic, alternative) =>
      `At ten people, our current ${topic} process is breaking down. ${alternative} looks powerful but feels aimed at much larger teams. I would appreciate recommendations from people with a similar setup.`,
    ageDays: 6,
    score: 27,
    comments: 21,
    lane: "brand_competitor_mentions",
  },
  {
    id: "mock_research_06",
    subreddit: "productmanagement",
    title: (topic) => `Best practices for ${topic}`,
    body: (topic) =>
      `I am documenting how teams approach ${topic}. I am not buying right now, but I would like to understand the common failure points and useful metrics.`,
    ageDays: 8,
    score: 41,
    comments: 25,
    lane: "category_recommendation",
  },
  {
    id: "mock_noise_07",
    subreddit: "technology",
    title: () => "Weekly general discussion thread",
    body: () =>
      "What products have you tried this week? Share launches, hiring updates, and anything else the community might find interesting.",
    ageDays: 1,
    score: 3,
    comments: 42,
    lane: "brand_competitor_mentions",
  },
];

function pickTopic(request: RedditSearchRequest): string {
  const candidates = [
    ...(request.queries.productCategories ?? []),
    ...request.queries.customerProblems,
    ...request.queries.productTerms.slice(1),
    ...request.queries.productTerms.slice(0, 1),
  ];
  const selected = candidates.find((term) => normalizeSearchText(term).length >= 4) ?? "this workflow";
  const concise = selected.replace(/\s+/g, " ").trim();
  return concise.length > 88 ? `${concise.slice(0, 85).replace(/\s+\S*$/, "")}…` : concise;
}

function pickAlternative(request: RedditSearchRequest): string {
  return request.queries.competitors.find((term) => term.trim().length > 1) ?? "the market leader";
}

function fixtureDate(ageDays: number): string {
  // Stable clock keeps screenshots/tests deterministic while remaining realistic.
  const reference = Date.UTC(2026, 7, 5, 12, 0, 0);
  return new Date(reference - ageDays * 86_400_000).toISOString();
}

function enrichMock(candidate: RedditDiscoveryCandidate): EnrichedRedditConversation {
  const matched: RedditContextMessage = {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  return {
    ...candidate,
    structuredContext: {
      originalPost: candidate.kind === "post" ? matched : undefined,
      matched,
      parentChain: [],
      replies: [],
      surroundingComments: [],
    },
  };
}

/** Development fallback. Each record is marked mock and intentionally has no Reddit permalink. */
export class MockRedditProvider implements RedditProvider {
  readonly name = "mock-reddit";
  readonly sourceMode = "mock" as const;

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const topic = pickTopic(request);
    const alternative = pickAlternative(request);
    const start = Number.parseInt(request.cursor ?? "0", 10);
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const limit = Math.max(1, Math.min(request.limit, 100));
    const slice = FIXTURES.slice(safeStart, safeStart + limit);

    const candidates: RedditDiscoveryCandidate[] = slice.map((fixture) => {
      const title = fixture.title(topic);
      const body = fixture.body(topic, alternative);
      const contentHash = contentFingerprint(`${title}\n${body}`);
      return {
        provider: this.name,
        sourceMode: this.sourceMode,
        externalId: fixture.id,
        kind: "post",
        subreddit: fixture.subreddit,
        title,
        body,
        author: `mock_user_${fixture.id}`,
        createdAt: fixtureDate(fixture.ageDays),
        metrics: { score: fixture.score, comments: fixture.comments },
        matchedQuery: topic,
        matchedQueries: [topic],
        discoveryLanes: [fixture.lane],
        provenance: {
          id: `mock-source-${fixture.id}`,
          kind: "mock_reddit",
          provider: this.name,
          providerExternalId: fixture.id,
          title,
          excerpt: body.slice(0, 280),
          contentHash,
          observedAt: "2026-08-05T12:00:00.000Z",
          isMock: true,
          metadata: { subreddit: fixture.subreddit, fixture: true },
        },
      };
    });

    const nextOffset = safeStart + candidates.length;
    return {
      candidates,
      nextCursor: nextOffset < FIXTURES.length ? String(nextOffset) : undefined,
      searchPlan: [],
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: 0,
        fetchedCandidates: candidates.length,
        normalizedCandidates: candidates.length,
        verifiedRecentCandidates: candidates.length,
        rejectedByReason: {
          invalid_record: 0,
          invalid_url: 0,
          query_mismatch: 0,
          bot_author: 0,
          deleted: 0,
          nsfw: 0,
          missing_timestamp: 0,
          outside_window: 0,
        },
        laneQueryCounts: {},
      },
    };
  }

  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const conversations = request.candidates.map(enrichMock);
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: request.candidates.length,
        enriched: conversations.length,
        failed: 0,
        fallbackUsed: 0,
      },
    };
  }

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const discovery = await this.discover(request);
    return {
      conversations: discovery.candidates.map(enrichMock),
      nextCursor: discovery.nextCursor,
      sourceMode: this.sourceMode,
    };
  }
}
