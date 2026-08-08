import type {
  RedditProvider,
  RedditSearchRequest,
  RedditSearchResponse,
} from "@/lib/providers/contracts";
import type { RedditConversation } from "@/lib/domain/types";
import { contentFingerprint, normalizeSearchText } from "@/lib/intelligence/opportunity-ranking";

interface MockFixture {
  id: string;
  subreddit: string;
  title: (topic: string) => string;
  body: (topic: string, alternative: string) => string;
  ageDays: number;
  score: number;
  comments: number;
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
  },
];

function pickTopic(request: RedditSearchRequest): string {
  const candidates = [
    ...request.queries.productTerms.slice(1),
    ...request.queries.customerProblems,
    ...request.queries.productTerms.slice(0, 1),
    ...request.queries.buyerIntent,
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

/**
 * Development fallback. Every record is marked mock and intentionally has no
 * Reddit permalink, so it cannot be mistaken for a real public conversation.
 */
export class MockRedditProvider implements RedditProvider {
  readonly name = "mock-reddit";
  readonly sourceMode = "mock" as const;

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const topic = pickTopic(request);
    const alternative = pickAlternative(request);
    const start = Number.parseInt(request.cursor ?? "0", 10);
    const safeStart = Number.isFinite(start) && start >= 0 ? start : 0;
    const limit = Math.max(1, Math.min(request.limit, 100));
    const slice = FIXTURES.slice(safeStart, safeStart + limit);

    const conversations: RedditConversation[] = slice.map((fixture) => {
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
        createdAt: fixtureDate(fixture.ageDays),
        metrics: { score: fixture.score, comments: fixture.comments },
        matchedQuery: topic,
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

    const nextOffset = safeStart + conversations.length;
    return {
      conversations,
      nextCursor: nextOffset < FIXTURES.length ? String(nextOffset) : undefined,
      sourceMode: this.sourceMode,
    };
  }
}
