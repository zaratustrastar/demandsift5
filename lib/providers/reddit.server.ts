import { MockRedditProvider } from "@/lib/providers/mock-reddit";
import {
  contentFingerprint,
  isUsefulSearchPhrase,
  normalizeSearchText,
} from "@/lib/intelligence/opportunity-ranking";
import type {
  ProviderRejectionReason,
  RedditDiscoveryDiagnostics,
  RedditDiscoveryResponse,
  RedditEnrichmentRequest,
  RedditEnrichmentResponse,
  RedditProvider,
  RedditSearchConcepts,
  RedditSearchPlanEntry,
  RedditSearchRequest,
  RedditSearchResponse,
} from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";
import type {
  EnrichedRedditConversation,
  RedditContextMessage,
  RedditConversation,
  RedditDiscoveryCandidate,
  RedditSearchLane,
  RedditStructuredContext,
} from "@/lib/domain/types";

type ApprovedProviderConversation = {
  externalId?: unknown;
  kind?: unknown;
  subreddit?: unknown;
  title?: unknown;
  body?: unknown;
  author?: unknown;
  permalink?: unknown;
  createdAt?: unknown;
  score?: unknown;
  comments?: unknown;
};

type ApprovedProviderResponse = {
  conversations?: unknown;
  nextCursor?: unknown;
};

type ApifyRedditItem = {
  id?: unknown;
  parsedId?: unknown;
  url?: unknown;
  username?: unknown;
  title?: unknown;
  communityName?: unknown;
  parsedCommunityName?: unknown;
  category?: unknown;
  body?: unknown;
  postId?: unknown;
  parentId?: unknown;
  numberOfComments?: unknown;
  numberOfReplies?: unknown;
  upVotes?: unknown;
  isAd?: unknown;
  over18?: unknown;
  createdAt?: unknown;
  scrapedAt?: unknown;
  dataType?: unknown;
};

type ApifySearchActorInput = {
  searches: string[];
  ignoreStartUrls: true;
  skipUserPosts: true;
  skipCommunity: true;
  includeMediaLinks: false;
  searchPosts: true;
  searchComments: true;
  searchCommunities: false;
  searchUsers: false;
  searchMedia: false;
  sort: "relevance" | "new";
  time: "day" | "week" | "month" | "year" | "all";
  postDateLimit?: string;
  commentDateLimit?: string;
  includeNSFW: false;
  maxItems: number;
  maxPostCount: number;
  maxComments: number;
  maxCommunitiesCount: 0;
  maxUserCount: 0;
  scrollTimeout: number;
  navigationTimeout: number;
  debugMode: false;
  searchCommunityName?: string;
  proxy: {
    useApifyProxy: true;
    apifyProxyGroups: ["RESIDENTIAL"];
  };
};

type ApifyEnrichmentActorInput = {
  startUrls: Array<{ url: string }>;
  skipComments: false;
  skipUserPosts: true;
  skipCommunity: true;
  includeMediaLinks: true;
  includeNSFW: false;
  maxItems: number;
  maxPostCount: number;
  maxComments: number;
  maxCommunitiesCount: 0;
  maxUserCount: 0;
  scrollTimeout: number;
  navigationTimeout: number;
  debugMode: false;
  proxy: {
    useApifyProxy: true;
    apifyProxyGroups: ["RESIDENTIAL"];
  };
};

export type ApifyRedditActorInput = ApifySearchActorInput | ApifyEnrichmentActorInput;

/**
 * Trudax charges for at least ten initialized items and rejects smaller
 * maxItems values even when a startUrls run only opens one selected thread.
 */
export const APIFY_REDDIT_ENRICHMENT_MIN_ITEMS = 10;

type ApifyCandidate = RedditDiscoveryCandidate & { item: ApifyRedditItem };

type CandidateParseResult =
  | { candidate: ApifyCandidate; reason?: never }
  | { candidate?: never; reason: ProviderRejectionReason };

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for the configured Reddit provider.`);
  return normalized;
}

function redditPermalink(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The Reddit provider returned an invalid permalink.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    (host !== "reddit.com" && !host.endsWith(".reddit.com") && host !== "redd.it")
  ) {
    throw new Error("The approved provider returned a non-Reddit permalink.");
  }
  return url.toString();
}

function safeRedditPermalink(value: unknown): string | undefined {
  try {
    return redditPermalink(value);
  } catch {
    return undefined;
  }
}

function stringValue(value: unknown, maximumLength = 10_000): string {
  return typeof value === "string" ? value.trim().slice(0, maximumLength) : "";
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function cleanSearchTerm(value: string): string {
  const withoutControls = Array.from(value.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127 ? " " : character;
  }).join("");
  return withoutControls.replace(/\s+/g, " ").trim().slice(0, 120);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi, (entity, code: string) => {
    if (code[0] !== "#") return named[code.toLowerCase()] ?? entity;
    const numeric = code[1]?.toLowerCase() === "x"
      ? Number.parseInt(code.slice(2), 16)
      : Number.parseInt(code.slice(1), 10);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff) return entity;
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return entity;
    }
  });
}

function cleanRedditText(value: unknown, maximumLength = 12_000): string {
  return decodeHtmlEntities(stringValue(value, maximumLength * 2))
    .replace(/\u00a0/g, " ")
    .replace(/\s+submitted by\s+\/?u\/[^\s]+\s+\[link\]\s+\[comments\]\s*$/i, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maximumLength);
}

function wordCount(value: string): number {
  return cleanSearchTerm(value).split(/\s+/).filter(Boolean).length;
}

function usefulShortPhrase(value: string, maximumWords = 8): boolean {
  return wordCount(value) <= maximumWords && isUsefulSearchPhrase(value);
}

const PROBLEM_TOKEN_STOP_WORDS = new Set([
  "about", "across", "and", "are", "can", "for", "from", "have", "into", "our", "that",
  "the", "their", "this", "using", "with", "without", "your", "a", "an", "to", "of",
  "or", "is", "be", "being", "been", "lengthy", "new", "start", "starts", "starting",
  "am", "as", "at", "by", "do", "go", "he", "if", "in", "it", "me", "my", "no",
  "on", "so", "up", "us", "we",
]);

/**
 * Cross-industry concept synonyms. Keys are canonical concept phrases; values
 * are the surface forms real posts actually use. This exists because a market
 * qualifier is rarely written the same way twice: someone shopping for an
 * Android TV parental control writes "television", "smart TV" or "Chromecast"
 * far more often than the vendor's own category label.
 *
 * Business-specific vocabulary is derived from the crawled profile at runtime;
 * this table only supplies the generic equivalences that no profile states.
 */
type ConceptKind = "market" | "problem";

interface ConceptEntry {
  kind: ConceptKind;
  variants: readonly string[];
}

/**
 * Cross-industry concept synonyms, each tagged with the kind of evidence it
 * supplies. The tagging matters: a category label such as "Android TV parental
 * control app" contains both a market concept ("tv") and a problem concept
 * ("parental control"). If they are pooled, a phone thread mentioning parental
 * controls satisfies the market requirement and the gate is back where it
 * started. Market evidence and problem evidence must come from different
 * concepts to be independent.
 *
 * Business-specific vocabulary is derived from the crawled profile at runtime;
 * this table only supplies generic equivalences no profile states.
 */
const CONCEPT_SYNONYMS: ReadonlyMap<string, ConceptEntry> = new Map([
  // Market concepts - devices, platforms, domains.
  ["tv", { kind: "market", variants: ["tv", "tvs", "television", "televisions", "smart tv", "google tv", "android tv", "apple tv", "fire tv", "firestick", "chromecast", "roku", "set top box", "streaming box", "living room tv"] }],
  ["vr", { kind: "market", variants: ["vr", "virtual reality", "headset", "oculus", "meta quest", "quest"] }],
  ["ar", { kind: "market", variants: ["ar", "augmented reality"] }],
  ["pc", { kind: "market", variants: ["pc", "desktop", "windows machine"] }],
  ["os", { kind: "market", variants: ["os", "operating system"] }],
  ["phone", { kind: "market", variants: ["phone", "phones", "mobile", "smartphone", "handset"] }],
  ["tablet", { kind: "market", variants: ["tablet", "tablets", "ipad"] }],
  ["ai", { kind: "market", variants: ["ai", "artificial intelligence", "llm", "llms", "gpt", "machine learning", "chatbot"] }],
  ["hr", { kind: "market", variants: ["hr", "human resources", "people ops", "hris"] }],
  ["crm", { kind: "market", variants: ["crm", "customer relationship", "sales pipeline"] }],
  ["seo", { kind: "market", variants: ["seo", "search rankings", "organic traffic", "serp"] }],
  ["ui", { kind: "market", variants: ["ui", "user interface"] }],
  ["ux", { kind: "market", variants: ["ux", "user experience", "usability"] }],
  ["qa", { kind: "market", variants: ["qa", "quality assurance"] }],
  ["bi", { kind: "market", variants: ["bi", "business intelligence", "dashboards"] }],
  ["b2b", { kind: "market", variants: ["b2b", "business to business"] }],
  // Problem and use-case concepts.
  ["parental control", { kind: "problem", variants: ["parental control", "parental controls", "parental lock", "child lock", "kids mode", "restricted mode", "content restrictions", "block apps", "lock apps"] }],
  ["screen time", { kind: "problem", variants: ["screen time", "screentime", "time limit", "time limits", "daily limit", "usage limit", "watching too long", "too much time", "hours a day", "outside allowed hours"] }],
  ["kids watching", { kind: "problem", variants: ["kids watching", "kid watching", "children watching", "kids watch", "kid watches", "children watch", "my kids watch", "my son watches", "my daughter watches"] }],
  ["block youtube", { kind: "problem", variants: ["block youtube", "blocking youtube", "restrict youtube", "youtube kids"] }],
  ["time tracking", { kind: "problem", variants: ["time tracking", "timesheet", "log hours"] }],
  ["scheduling", { kind: "problem", variants: ["scheduling", "book a time", "appointments"] }],
  ["invoicing", { kind: "problem", variants: ["invoicing", "invoices", "billing", "get paid"] }],
]);

/** Generic words that cannot on their own identify a market. */
const GENERIC_CONCEPT_TOKENS = new Set([
  "app", "apps", "business", "company", "online", "platform", "product",
  "service", "services", "software", "solution", "solutions", "system",
  "systems", "tool", "tools", "best", "top", "free", "new",
]);

const BUILT_IN_INTENT_VARIANTS: readonly string[] = [
  "recommend", "recommendation", "recommendations", "looking for", "any suggestions",
  "suggestions", "alternative", "alternatives", "how can i", "how do i", "need a",
  "need help", "what do you use", "anyone using", "which tool", "worth it",
];

/** Adjacent word pairs, so "android tv" survives as a unit. */
function adjacentBigrams(value: string): string[] {
  const words = normalizeSearchText(value).split(" ").filter(Boolean);
  const pairs: string[] = [];
  for (let index = 0; index + 1 < words.length; index += 1) {
    pairs.push(`${words[index]} ${words[index + 1]}`);
  }
  return pairs;
}

/** Function words that carry no concept meaning on their own. */
const CONCEPT_FUNCTION_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "do", "for", "from",
  "get", "has", "have", "how", "in", "is", "it", "its", "my", "no", "not", "of",
  "on", "or", "our", "so", "the", "their", "this", "to", "too", "up", "was",
  "what", "when", "why", "with", "you", "your",
]);

/** Singular form, so "parental controls" reaches the "parental control" entry. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("ses")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function lemmatize(phrase: string): string {
  return phrase.split(" ").map(singular).join(" ");
}

/**
 * Every lexicon key a phrase touches. Both the literal and the lemmatised form
 * are tried: profiles say "parental controls" while the lexicon is keyed on the
 * singular, and missing that hit used to collapse the phrase to bare tokens.
 */
function lexiconHits(normalized: string): Array<[string, ConceptEntry]> {
  const candidates = [normalized, ...adjacentBigrams(normalized), ...normalized.split(" ")];
  const hits: Array<[string, ConceptEntry]> = [];
  for (const candidate of candidates) {
    for (const key of [candidate, lemmatize(candidate)]) {
      const entry = CONCEPT_SYNONYMS.get(key);
      if (entry && !hits.some(([seen]) => seen === key)) hits.push([key, entry]);
    }
  }
  return hits;
}

/**
 * Expand grounded phrases into the surface forms a real post might use,
 * restricted to one kind of evidence. Tokens belonging to the opposite kind
 * are excluded so the two requirements stay independent.
 */
function conceptVariants(phrases: readonly string[], kind: ConceptKind): string[] {
  const variants = new Set<string>();
  const add = (value: string) => {
    const normalized = normalizeSearchText(value);
    if (normalized.length >= 2) variants.add(normalized);
  };

  for (const phrase of phrases) {
    const normalized = normalizeSearchText(phrase);
    if (!normalized) continue;

    const hits = lexiconHits(normalized);
    const matching = hits.filter(([, entry]) => entry.kind === kind);
    for (const [, entry] of matching) {
      for (const variant of entry.variants) add(variant);
    }

    // Words already claimed by the opposite kind must not leak across.
    const claimedByOther = new Set(
      hits
        .filter(([, entry]) => entry.kind !== kind)
        .flatMap(([key]) => key.split(" ")),
    );
    const distinctive = normalized
      .split(" ")
      .filter(
        (token) =>
          token.length >= 2 &&
          !PROBLEM_TOKEN_STOP_WORDS.has(token) &&
          !GENERIC_CONCEPT_TOKENS.has(token) &&
          !claimedByOther.has(token),
      );

    if (matching.length > 0) continue;

    // No lexicon hit: fall back to the profile's own wording. Bigrams are used
    // in preference to single tokens, because one bare token ("android") is
    // usually the neighbouring market rather than this problem.
    const bigrams = adjacentBigrams(normalized).filter((bigram) => {
      const words = bigram.split(" ");
      if (words.some((word) => claimedByOther.has(word))) return false;
      if (words.some((word) => CONCEPT_FUNCTION_WORDS.has(word))) return false;
      if (words.every((word) => GENERIC_CONCEPT_TOKENS.has(word))) return false;
      return true;
    });
    if (bigrams.length > 0) {
      for (const bigram of bigrams) add(bigram);
      continue;
    }
    for (const token of distinctive.filter((token) => !CONCEPT_FUNCTION_WORDS.has(token))) {
      add(token);
    }
  }
  return [...variants].slice(0, 40);
}

/** True when any variant appears in the text as a whole word or phrase. */
function matchesAnyVariant(text: string, variants: readonly string[]): boolean {
  const padded = ` ${text} `;
  return variants.some((variant) => {
    if (!variant) return false;
    return padded.includes(` ${variant} `);
  });
}

function problemTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 2 && !PROBLEM_TOKEN_STOP_WORDS.has(token));
}

function naturalKeywordPhrase(value: string, maximumWords = 5): string {
  return problemTokens(value).slice(0, maximumWords).join(" ");
}

function automatedAuthor(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "automoderator" ||
    normalized === "[deleted]" ||
    normalized === "reddit" ||
    /(?:^|[-_])(bot|moderator)(?:$|[-_])/i.test(normalized) ||
    normalized.endsWith("bot")
  );
}

function boundedPlanEntry(
  lane: RedditSearchLane,
  query: string,
  seed?: string,
  concepts?: RedditSearchConcepts,
): RedditSearchPlanEntry | null {
  const cleaned = query.replace(/\s+/g, " ").trim().slice(0, 300);
  return cleaned.length >= 2
    ? { lane, query: cleaned, ...(seed ? { seed } : {}), ...(concepts ? { concepts } : {}) }
    : null;
}

/**
 * Build a bounded high-recall search plan around observable demand signals.
 *
 * The website/AI layer supplies grounded search hypotheses. This layer keeps
 * Reddit syntax deterministic and deliberately avoids over-constraining those
 * hypotheses with extra "pain words".
 */
export function buildApifyRedditSearchPlan(request: RedditSearchRequest): RedditSearchPlanEntry[] {
  type DemandLane =
    | "direct_buying_intent"
    | "problem_pain"
    | "competitor_switching"
    | "category_recommendation"
    | "brand_competitor_mentions"
    | "workaround"
    | "timing";

  const cleanUnique = (values: readonly string[], maximumWords: number): string[] => {
    const seen = new Set<string>();
    return values.flatMap((value) => {
      const cleaned = cleanSearchTerm(value);
      if (!usefulShortPhrase(cleaned, maximumWords)) return [];
      const key = normalizeSearchText(cleaned);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [cleaned];
    });
  };

  const manifestationExpression = (value: string): string => {
    return naturalKeywordPhrase(value, 5);
  };

  const categoryExpression = (value: string): string => {
    const tokens = problemTokens(value);
    if (tokens.length === 0) return "";

    // Preserve enough grounded category language to keep market qualifiers.
    // Example: "Android TV parental control app" must not collapse to
    // "android parental app".
    const selected = tokens.slice(0, 5);
    const descriptor = tokens.find((token) =>
      /^(?:app|apps|platform|software|system|tool|tools)$/.test(token),
    );
    if (descriptor && !selected.includes(descriptor)) {
      if (selected.length >= 5) selected[selected.length - 1] = descriptor;
      else selected.push(descriptor);
    }
    return selected.join(" ");
  };

  const categorySearchExpressions = (value: string): string[] => {
    const normalized = normalizeSearchText(value);
    const descriptor = problemTokens(value).find((token) =>
      /^(?:app|apps|platform|software|system|tool|tools)$/.test(token),
    ) ?? "software";
    const fragments = normalized
      .split(/\band\b/g)
      .map((fragment) => categoryExpression(fragment))
      .filter(Boolean)
      .map((fragment) =>
        /\b(?:app|apps|platform|software|system|tool|tools)\b/.test(fragment)
          ? fragment
          : `${fragment} ${descriptor}`,
      );
    const variants = [...fragments];

    /* "Team work apps" is common customer language for the formal category
     * "team collaboration software". Keeping this deterministic synonym here
     * lets discovery retrieve that wording without teaching the classifier to
     * accept unrelated app discussions. */
    if (/\bteam\b/.test(normalized) && /\bcollaborat\w*\b/.test(normalized)) {
      variants.splice(Math.min(1, variants.length), 0, "team work apps");
    }

    return [...new Set(variants.map((variant) => variant.trim()).filter(Boolean))].slice(0, 3);
  };

  const triggerExpression = (value: string): string => {
    return naturalKeywordPhrase(value, 5);
  };

  const contextOrExpression = (value: string): string => {
    const generic = new Set([
      "keep", "keeping", "manage", "managing", "organize", "organized",
      "organizing", "coordinate", "coordinating", "use", "using",
      "help", "helps", "solve", "solves", "make", "makes",
    ]);
    const tokens = problemTokens(value)
      .filter((token) => !generic.has(token))
      .slice(0, 2);

    if (tokens.length === 0) return "";
    return tokens.join(" ");
  };

  const productTerms = cleanUnique(request.queries.productTerms, 8);
  const categories = cleanUnique(request.queries.productCategories ?? [], 6);
  const problems = cleanUnique(request.queries.customerProblems, 8);
  const jobs = cleanUnique(request.queries.jobsToBeDone ?? [], 10);
  const workarounds = cleanUnique(request.queries.workarounds ?? [], 8);
  const triggers = cleanUnique(request.queries.triggerEvents ?? [], 10);
  const competitors = cleanUnique(request.queries.competitors, 6);
  const brandTerms = cleanUnique(
    request.queries.brandTerms?.length
      ? request.queries.brandTerms
      : productTerms.slice(0, 1),
    6,
  );

  const pools: Record<DemandLane, RedditSearchPlanEntry[]> = {
    direct_buying_intent: [],
    problem_pain: [],
    competitor_switching: [],
    category_recommendation: [],
    brand_competitor_mentions: [],
    workaround: [],
    timing: [],
  };

  const seenQueries = new Set<string>();

  /**
   * Market evidence is shared by every entry and comes from the category the
   * business actually sells into. Problem evidence is specific to the seed the
   * entry was built from, so each search demands its own use case rather than
   * any use case.
   */
  const marketVariants = conceptVariants(
    [...categories.slice(0, 2), ...productTerms.slice(0, 2)],
    "market",
  );
  const intentVariants = [
    ...new Set([...conceptVariants(request.queries.buyerIntent ?? [], "problem"), ...BUILT_IN_INTENT_VARIANTS]),
  ];

  /**
   * Problem evidence is the union of the business's use-case vocabulary rather
   * than only the seed that produced this query. A thread about screen time is
   * relevant to a parental-control product even when the search that surfaced
   * it was seeded from a different pain. Precision still comes from the market
   * requirement; seed specificity continues to influence score, not admission.
   */
  const problemVariants = conceptVariants(
    [
      ...problems.slice(0, 6),
      ...jobs.slice(0, 4),
      ...categories.slice(0, 2),
    ],
    "problem",
  );

  /**
   * Concept gating applies only where the market has a distinguishing concept -
   * a device, platform or domain that posts actually name ("tv", "hr", "ai").
   * That is precisely where token counting failed, because the one qualifier
   * separating two markets was outvoted by shared generic words.
   *
   * A category like "project management software" has no such qualifier: buyers
   * describe the pain without ever naming the category, so demanding market
   * evidence in the text would discard real demand. Those profiles keep the
   * existing token behaviour.
   */
  const hasDistinguishingMarket = [...categories.slice(0, 2), ...productTerms.slice(0, 2)].some(
    (phrase) =>
      lexiconHits(normalizeSearchText(phrase)).some(([, entry]) => entry.kind === "market"),
  );

  const conceptsFor = (seed?: string): RedditSearchConcepts | undefined => {
    if (!seed || !hasDistinguishingMarket || marketVariants.length === 0) return undefined;
    const seedProblem = conceptVariants([seed], "problem");
    const problem = [...new Set([...problemVariants, ...seedProblem])];
    if (problem.length === 0) return undefined;
    return { market: marketVariants, problem, intent: intentVariants };
  };

  const push = (lane: DemandLane, query: string, seed?: string) => {
    const entry = boundedPlanEntry(lane, query, seed, conceptsFor(seed));
    if (!entry) return;

    const key = normalizeSearchText(entry.query);
    if (!key || seenQueries.has(key)) return;

    seenQueries.add(key);
    pools[lane].push(entry);
  };

  const categorySeed =
    categories[0] ??
    productTerms.find(
      (term) =>
        normalizeSearchText(term) !== normalizeSearchText(brandTerms[0] ?? ""),
    ) ??
    productTerms[0] ??
    "";

  const contextSeed =
    categories[0] ??
    jobs[0] ??
    problems[0] ??
    productTerms[0] ??
    "";

  const context = contextOrExpression(contextSeed);
  const categoryContext = categoryExpression(categorySeed) || context;

  /* Direct buying intent and category recommendations stay separate so a
   * result can be traced back to the signal we intended to retrieve. */
  const categorySearches = categorySearchExpressions(categorySeed);
  const category = categorySearches[0] ?? "";
  if (category) {
    push(
      "direct_buying_intent",
      `looking for ${category}`,
      categorySeed,
    );
    push(
      "category_recommendation",
      `${category} recommendations`,
      categorySeed,
    );
  }
  for (const customerCategory of categorySearches.slice(1, 2)) {
    push("direct_buying_intent", customerCategory, customerCategory);
  }

  for (const seed of [...problems, ...jobs].slice(0, 8)) {
    const manifestation = manifestationExpression(seed);
    if (!manifestation) continue;

    push(
      "direct_buying_intent",
      `need help ${manifestation}`,
      seed,
    );
  }

  /*
   * PAIN
   *
   * The problem manifestation itself is evidence. Do not require a second
   * generic word such as "frustrated" or "problem".
   */
  for (const seed of problems.slice(0, 8)) {
    const manifestation = manifestationExpression(seed);
    if (manifestation) push("problem_pain", manifestation, seed);
  }

  /* Competitor switching and broader competitor-frustration discussions are
   * distinct. Only website-verified competitors reach this request. */
  for (const competitorName of competitors.slice(0, 4)) {
    const competitor = cleanSearchTerm(competitorName);
    if (!competitor) continue;

    push(
      "competitor_switching",
      `${competitor} alternative${categoryContext ? ` ${categoryContext}` : ""}`,
      competitorName,
    );
    push(
      "brand_competitor_mentions",
      `${competitor} problem${categoryContext ? ` ${categoryContext}` : ""}`,
      competitorName,
    );
  }

  /*
   * WORKAROUNDS
   *
   * Workaround hypotheses are allowed to be broad, but connect them to a small
   * OR-context rather than requiring an entire formal JTBD phrase.
   */
  for (const seed of workarounds.slice(0, 6)) {
    const workaround = manifestationExpression(seed);
    if (!workaround) continue;

    push(
      "workaround",
      `${workaround}${context ? ` ${context}` : ""}`,
      seed,
    );
  }

  /*
   * TIMING
   *
   * Keep only the strongest part of the trigger and connect it to broad
   * business context. Do not search an AI-written sentence verbatim.
   */
  for (const seed of triggers.slice(0, 6)) {
    const trigger = triggerExpression(seed);
    if (!trigger) continue;

    push(
      "timing",
      `${trigger}${context ? ` ${context}` : ""}`,
      seed,
    );
  }

  const quotas: Array<[DemandLane, number]> = [
    ["direct_buying_intent", 2],
    ["problem_pain", 2],
    ["competitor_switching", 1],
    ["category_recommendation", 1],
    ["brand_competitor_mentions", 1],
    ["workaround", 1],
    ["timing", 1],
  ];

  const selected: RedditSearchPlanEntry[] = [];
  const selectedKeys = new Set<string>();

  const selectEntry = (entry: RedditSearchPlanEntry | undefined): boolean => {
    if (!entry) return false;
    const key = `${entry.lane}:${normalizeSearchText(entry.query)}`;
    if (selectedKeys.has(key)) return false;
    selectedKeys.add(key);
    selected.push(entry);
    return true;
  };

  for (const [lane, quota] of quotas) {
    for (const entry of pools[lane].slice(0, quota)) selectEntry(entry);
  }

  const laneOrder: DemandLane[] = [
    "direct_buying_intent",
    "problem_pain",
    "competitor_switching",
    "category_recommendation",
    "brand_competitor_mentions",
    "workaround",
    "timing",
  ];

  while (selected.length < 9) {
    let added = false;

    for (const lane of laneOrder) {
      const next = pools[lane].find((entry) => {
        const key = `${entry.lane}:${normalizeSearchText(entry.query)}`;
        return !selectedKeys.has(key);
      });

      if (selectEntry(next)) {
        added = true;
        if (selected.length >= 9) break;
      }
    }

    if (!added) break;
  }

  return selected.slice(0, 9);
}

/** Compatibility helper for tests/callers that only need query strings. */
export function buildApifyRedditSearches(request: RedditSearchRequest): string[] {
  return buildApifyRedditSearchPlan(request).map((entry) => entry.query);
}

export function searchPlanMatches(
  title: string | undefined,
  body: string,
  plan: readonly RedditSearchPlanEntry[],
): RedditSearchPlanEntry[] {
  const text = normalizeSearchText(`${title ?? ""}\n${body}`);
  const textTokens = text.split(" ").filter(Boolean);
  const textTokenSet = new Set(textTokens);

  const matchesWithinWindow = (
    targets: readonly string[],
    required: number,
    windowSize = 18,
  ): boolean => {
    if (required <= 0) return true;
    for (let start = 0; start < textTokens.length; start += 1) {
      const present = new Set(textTokens.slice(start, start + windowSize));
      if (targets.filter((token) => present.has(token)).length >= required) return true;
    }
    return false;
  };

  const scored = plan.flatMap((entry) => {
    const seed = normalizeSearchText(entry.seed ?? "");
    if (!seed) return [];

    const seedTokens = problemTokens(seed).slice(0, 6);

    if (seedTokens.length === 0) return [];

    let seedScore = 0;

    const matched = seedTokens.filter((token) => textTokenSet.has(token)).length;
    const isCompetitorLane =
      entry.lane === "competitor_switching" ||
      entry.lane === "switching" ||
      entry.lane === "brand_competitor_mentions";
    const isBrandLane = entry.lane === "brand_competitor_mentions";
    const isDemandLane =
      entry.lane === "direct_buying_intent" ||
      entry.lane === "explicit_demand" ||
      entry.lane === "category_recommendation";
    const required = isCompetitorLane
      ? seedTokens.length
      : isDemandLane
        ? Math.min(seedTokens.length, 2)
        : seedTokens.length <= 4
          ? seedTokens.length
          : Math.min(seedTokens.length, Math.max(2, Math.ceil(seedTokens.length * 0.75)));

    const concepts = entry.concepts;
    if (concepts && concepts.market.length > 0) {
      /**
       * Concept gate. Counting how many seed tokens appear cannot tell one
       * market from its neighbour - "android tv parental control app" matches
       * an Android *phone* thread on most of its tokens, and requiring "2 of N"
       * let exactly that through. Require the two things that actually make a
       * conversation ours: evidence of the market, and evidence of the problem.
       * Each accepts synonyms, so "television" or "screen time" still count.
       */
      const marketMatched = matchesAnyVariant(text, concepts.market);
      if (!marketMatched) return [];

      // Concepts add requirements; they never relax existing ones. A competitor
      // or brand lane still has to see the name itself, otherwise market plus
      // generic intent would admit any on-topic chatter.
      if ((isCompetitorLane || isBrandLane) && matched < seedTokens.length) return [];

      const problemMatched =
        concepts.problem.length === 0 || matchesAnyVariant(text, concepts.problem);
      const intentMatched = matchesAnyVariant(text, concepts.intent ?? []);

      // Naming a competitor or the brand is itself use-case evidence, so those
      // lanes may substitute buying intent for an explicit problem statement.
      const problemSatisfied =
        problemMatched || ((isCompetitorLane || isBrandLane) && intentMatched);
      if (!problemSatisfied) return [];

      const exactSeed = seed.length >= 4 && text.includes(seed);
      seedScore =
        (exactSeed ? 4 : 0) +
        2 + // market evidence
        (problemMatched ? 2 : 0) +
        (intentMatched ? 1 : 0) +
        Math.min(matched, 3);
    } else if (seed.length >= 4 && text.includes(seed)) {
      seedScore = seedTokens.length + 4;
    } else {
      if (matched < required) return [];
      if (!isCompetitorLane && !isDemandLane && !matchesWithinWindow(seedTokens, required)) return [];
      seedScore = matched;
    }

    if (isCompetitorLane && seedTokens.length === 1) {
      const signalWords = new Set([
        "alternative", "alternatives", "expensive", "frustrated", "issue", "limitation",
        "missing", "moving", "overkill", "problem", "replace", "switch", "switching",
      ]);
      const contextTokens = problemTokens(entry.query)
        .filter((token) => !seedTokens.includes(token) && !signalWords.has(token))
        .slice(0, 4);
      const contextRequired = Math.min(2, contextTokens.length);
      if (contextRequired > 0 && contextTokens.filter((token) => textTokenSet.has(token)).length < contextRequired) {
        return [];
      }
    }

    const explicitDemandSignal =
      /\b(?:advice|any suggestions|anyone using|hoping someone|looking for|need help|recommend|recommendation|suggestions?|alternative|which tool|what do you use)\b/.test(text);
    const categoryRecommendationSignal =
      /\b(?:advice|any suggestions|anyone using|hoping someone|recommend|recommendation|suggestions?|which tool|what do you use|best tool)\b/.test(text);
    const competitorSwitchingSignal =
      /\b(?:alternative|switch|switching|replace|moving away|frustrated|expensive|overkill)\b/.test(text);
    const competitorProblemSignal =
      /\b(?:problem|issue|frustrat|hate|missing|limitation|expensive|overkill)\w*\b/.test(text);

    const requiresSignal =
      entry.lane === "direct_buying_intent" ||
      entry.lane === "explicit_demand" ||
      entry.lane === "category_recommendation" ||
      entry.lane === "competitor_switching" ||
      entry.lane === "switching" ||
      entry.lane === "brand_competitor_mentions";
    const signalMatched =
      entry.lane === "direct_buying_intent" || entry.lane === "explicit_demand"
        ? explicitDemandSignal
        : entry.lane === "category_recommendation"
          ? categoryRecommendationSignal
          : entry.lane === "competitor_switching" || entry.lane === "switching"
            ? competitorSwitchingSignal
            : entry.lane === "brand_competitor_mentions"
              ? competitorProblemSignal
              : true;

    if (requiresSignal && !signalMatched) return [];

    const signalBoost =
      explicitDemandSignal &&
      (entry.lane === "direct_buying_intent" || entry.lane === "explicit_demand")
        ? 2
        : categoryRecommendationSignal && entry.lane === "category_recommendation"
          ? 2
          : competitorSwitchingSignal &&
            (entry.lane === "competitor_switching" || entry.lane === "switching")
          ? 2
          : (entry.lane === "problem_pain" || entry.lane === "pain") &&
              /\b(?:missed|buried|scattered|struggl|frustrat|messy|manual|difficult|overwhelm|nightmare)\w*\b/.test(text)
            ? 1
            : competitorProblemSignal && entry.lane === "brand_competitor_mentions"
              ? 1
            : entry.lane === "workaround" &&
                /\b(?:spreadsheet|email|manual|workaround|copy paste)\w*\b/.test(text)
              ? 1
              : entry.lane === "timing" &&
                  /\b(?:grow|grew|growth|outgrown|outgrowing|scal|more clients|new clients)\w*\b/.test(text)
                ? 1
                : 0;

    return [{ entry, score: seedScore + signalBoost }];
  });

  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((row) => row.score));
  return scored
    .filter((row) => row.score >= Math.max(1, best - 2))
    .map((row) => row.entry);
}

function subredditFromItem(item: ApifyRedditItem, permalink: string | undefined): string {
  const fromUrl = permalink?.match(/\/r\/([^/]+)/i)?.[1] ?? "";
  const candidate =
    fromUrl ||
    stringValue(item.parsedCommunityName, 80) ||
    stringValue(item.communityName, 80).replace(/^r\//i, "") ||
    stringValue(item.category, 80).replace(/^r\//i, "");
  return /^[A-Za-z0-9_]{1,32}$/.test(candidate) ? candidate : "";
}

function candidateFromApify(
  value: unknown,
  plan: readonly RedditSearchPlanEntry[] = [],
): CandidateParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { reason: "invalid_record" };
  }
  const item = value as ApifyRedditItem;
  const dataType = stringValue(item.dataType, 20).toLowerCase();
  if (dataType !== "post" && dataType !== "comment") return { reason: "invalid_record" };
  if (item.isAd === true) return { reason: "invalid_record" };
  if (item.over18 === true) return { reason: "nsfw" };

  const title = cleanRedditText(item.title, 500) || undefined;
  const body = cleanRedditText(item.body) || title || "";
  const permalink = safeRedditPermalink(item.url);
  if (!permalink) return { reason: "invalid_url" };
  const subreddit = subredditFromItem(item, permalink);
  if (!body || !subreddit) return { reason: "invalid_record" };

  const author = cleanRedditText(item.username, 100) || undefined;
  if (author && automatedAuthor(author)) return { reason: "bot_author" };
  if (/^\[(?:deleted|removed)\]$/i.test(body)) return { reason: "deleted" };

  const rawCreatedAt = stringValue(item.createdAt, 80);
  const parsedCreatedAt = Date.parse(rawCreatedAt);
  if (!Number.isFinite(parsedCreatedAt)) return { reason: "missing_timestamp" };

  const externalId =
    stringValue(item.parsedId, 200) ||
    stringValue(item.id, 200).replace(/^t[13]_/i, "") ||
    `derived_${contentFingerprint(`${permalink}\n${body}`)}`;
  const matches = searchPlanMatches(title, body, plan);
  /* The Actor already returned this structurally valid, recent Reddit record
   * from one of our searches. Local matching is attribution metadata only; it
   * must not become a semantic rejection gate that can hide real demand before
   * AI triage. */
  const matchedQueries = [...new Set(matches.map((entry) => entry.query))];
  const discoveryLanes = [...new Set(matches.map((entry) => entry.lane))];
  const provider = "apify-test";
  const observedAt = new Date().toISOString();

  return {
    candidate: {
      item,
      provider,
      sourceMode: "apify-test",
      externalId,
      kind: dataType,
      parentExternalId: stringValue(item.parentId, 200) || stringValue(item.postId, 200) || undefined,
      subreddit,
      title,
      body,
      author,
      permalink,
      createdAt: new Date(parsedCreatedAt).toISOString(),
      metrics: {
        score: nonNegativeInteger(item.upVotes),
        comments: dataType === "comment"
          ? nonNegativeInteger(item.numberOfReplies)
          : nonNegativeInteger(item.numberOfComments),
      },
      matchedQuery: matchedQueries[0],
      matchedQueries,
      discoveryLanes,
      provenance: {
        id: `reddit_apify_${contentFingerprint(externalId)}`,
        kind: "reddit",
        provider,
        providerExternalId: externalId,
        url: permalink,
        title,
        excerpt: body.slice(0, 280),
        contentHash: contentFingerprint(`${title ?? ""}\n${body}`),
        observedAt,
        isMock: false,
        metadata: {
          testOnly: true,
          acquisitionMethod: "web-scraping",
        },
      },
    },
  };
}

function redditPostIdFromPermalink(value: string): string | undefined {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
    const id = commentsIndex >= 0 ? segments[commentsIndex + 1] : undefined;
    return id && /^[a-z0-9]+$/i.test(id) ? id.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

function redditThreadPermalink(value: string | undefined): string | undefined {
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

function rawExternalId(item: ApifyRedditItem): string {
  return stringValue(item.parsedId, 200) || stringValue(item.id, 200).replace(/^t[13]_/i, "");
}

function contextMessage(value: unknown): RedditContextMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as ApifyRedditItem;
  const dataType = stringValue(item.dataType, 20).toLowerCase();
  if (dataType !== "post" && dataType !== "comment") return null;
  if (item.isAd === true || item.over18 === true) return null;
  const body = cleanRedditText(item.body) || cleanRedditText(item.title, 500);
  const externalId = rawExternalId(item);
  if (!body || !externalId || /^\[(?:deleted|removed)\]$/i.test(body)) return null;
  const createdAtRaw = stringValue(item.createdAt, 80);
  const createdAtMs = Date.parse(createdAtRaw);
  return {
    externalId,
    kind: dataType,
    author: cleanRedditText(item.username, 100) || undefined,
    body,
    parentExternalId: stringValue(item.parentId, 200) || stringValue(item.postId, 200) || undefined,
    createdAt: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : undefined,
  };
}

function postIdForItem(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as ApifyRedditItem;
  const direct = stringValue(item.postId, 200).replace(/^t3_/i, "");
  if (direct) return direct.toLowerCase();
  const permalink = safeRedditPermalink(item.url);
  return permalink ? redditPostIdFromPermalink(permalink) : undefined;
}

function structuredContextForCandidate(
  candidate: RedditDiscoveryCandidate,
  payload: readonly unknown[],
): RedditStructuredContext {
  const postId = candidate.permalink ? redditPostIdFromPermalink(candidate.permalink) : undefined;
  const messages = payload.flatMap((value) => {
    const message = contextMessage(value);
    if (!message || (postId && postIdForItem(value) !== postId)) return [];
    return [{ value, message }];
  });
  const byId = new Map(messages.map((row) => [row.message.externalId.replace(/^t[13]_/i, ""), row.message]));
  const matched = byId.get(candidate.externalId.replace(/^t[13]_/i, "")) ?? {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  const originalPost = messages.find((row) => row.message.kind === "post")?.message ??
    (candidate.kind === "post" ? matched : undefined);

  const parentChain: RedditContextMessage[] = [];
  let parentId = matched.parentExternalId?.replace(/^t[13]_/i, "");
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId) && parentChain.length < 6) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    parentChain.unshift(parent);
    parentId = parent.parentExternalId?.replace(/^t[13]_/i, "");
  }

  const replies = messages
    .map((row) => row.message)
    .filter((message) =>
      message.kind === "comment" &&
      message.parentExternalId?.replace(/^t[13]_/i, "") === candidate.externalId.replace(/^t[13]_/i, ""),
    )
    .slice(0, 6);
  const used = new Set([
    matched.externalId,
    ...parentChain.map((message) => message.externalId),
    ...replies.map((message) => message.externalId),
    ...(originalPost ? [originalPost.externalId] : []),
  ]);
  const surroundingComments = messages
    .map((row) => row.message)
    .filter((message) => message.kind === "comment" && !used.has(message.externalId))
    .slice(0, 6);

  return { originalPost, matched, parentChain, replies, surroundingComments };
}

function flattenStructuredContext(context: RedditStructuredContext): string {
  const sections: string[] = [];
  if (context.originalPost && context.originalPost.externalId !== context.matched.externalId) {
    sections.push(`Original post${context.originalPost.author ? ` by ${context.originalPost.author}` : ""}: ${context.originalPost.body}`);
  }
  if (context.parentChain.length > 0) {
    sections.push(`Parent chain:\n${context.parentChain.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  if (context.replies.length > 0) {
    sections.push(`Replies:\n${context.replies.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  if (context.surroundingComments.length > 0) {
    sections.push(`Other comments:\n${context.surroundingComments.map((row) => `${row.author ?? "Reddit user"}: ${row.body}`).join("\n")}`);
  }
  return sections.join("\n\n").slice(0, 8_000);
}

function enrichedItemForCandidate(
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

function enrichedConversation(
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
    `${candidate.title ?? ""}
${candidate.body}
${JSON.stringify(context)}`,
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
 * Preserve a verified discovery record when the optional thread-opening call
 * fails. This does not invent replies or surrounding context: deep
 * qualification receives only the selected author's already verified words.
 */
function discoveryFallbackConversation(
  candidate: RedditDiscoveryCandidate,
  provider: string,
): EnrichedRedditConversation {
  const matched: RedditContextMessage = {
    externalId: candidate.externalId,
    kind: candidate.kind,
    author: candidate.author,
    body: candidate.body,
    parentExternalId: candidate.parentExternalId,
    createdAt: candidate.createdAt,
  };
  return {
    provider,
    sourceMode: candidate.sourceMode,
    externalId: candidate.externalId,
    kind: candidate.kind,
    parentExternalId: candidate.parentExternalId,
    subreddit: candidate.subreddit,
    title: candidate.title,
    body: candidate.body,
    structuredContext: {
      originalPost: candidate.kind === "post" ? matched : undefined,
      matched,
      parentChain: [],
      replies: [],
      surroundingComments: [],
    },
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
      observedAt: new Date().toISOString(),
      metadata: {
        ...(candidate.provenance.metadata ?? {}),
        enriched: false,
        enrichmentFallback: "verified_discovery_record",
      },
    },
  };
}

/**
 * Give the Actor a shorter runtime budget than the client request. That lets
 * us observe a terminal Actor status instead of aborting the HTTP poll at the
 * exact instant the remote timeout is reached.
 */
export function apifyActorTimeoutSeconds(clientTimeoutMs: number): number {
  const boundedClientMs = Math.max(20_000, Math.trunc(clientTimeoutMs));
  return Math.max(20, Math.floor((boundedClientMs - 30_000) / 1_000));
}

/**
 * Thread opening is optional context after discovery has already retained the
 * matched author's verified words. Keep this call short so a blocked Reddit
 * page cannot add another full discovery-length wait to the user journey.
 */
export function apifyEnrichmentTimeoutMs(configuredTimeoutMs: number): number {
  return Math.max(20_000, Math.min(Math.trunc(configuredTimeoutMs), 120_000));
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(parsed)))
    : fallback;
}

function apifyActorId(value: string): string {
  const normalized = value.trim().replace("/", "~");
  if (!/^(?:[A-Za-z0-9_-]{5,80}|[A-Za-z0-9_-]{1,80}~[A-Za-z0-9_-]{1,100})$/.test(normalized)) {
    throw new Error("APIFY_REDDIT_ACTOR_ID is invalid.");
  }
  return normalized;
}

function emptyProviderRejections(): Record<ProviderRejectionReason, number> {
  return {
    invalid_record: 0,
    invalid_url: 0,
    query_mismatch: 0,
    bot_author: 0,
    deleted: 0,
    nsfw: 0,
    missing_timestamp: 0,
    outside_window: 0,
  };
}

function boundedSearchTime(
  configured: ApifySearchActorInput["time"],
  since: string | undefined,
  now = Date.now(),
): ApifySearchActorInput["time"] {
  const sinceMs = since ? Date.parse(since) : Number.NaN;
  if (!Number.isFinite(sinceMs) || sinceMs > now) return configured;

  const ageDays = (now - sinceMs) / 86_400_000;
  const requested: ApifySearchActorInput["time"] =
    ageDays <= 1.25 ? "day" : ageDays <= 8 ? "week" : ageDays <= 32 ? "month" : configured;
  const order: ApifySearchActorInput["time"][] = ["day", "week", "month", "year", "all"];
  return order.indexOf(requested) < order.indexOf(configured) ? requested : configured;
}

/**
 * Real-data MVP test adapter for Trudax's Reddit Scraper family. Discovery and
 * enrichment are intentionally separate; the scan workflow owns the budget.
 */
export class ApifyRedditTestProvider implements RedditProvider {
  readonly name = "apify-reddit-test";
  readonly sourceMode = "apify-test" as const;
  private readonly actorId: string;
  private readonly token: string;
  private readonly maximumItems: number;
  private readonly enrichmentLimit: number;
  private readonly enrichmentComments: number;
  private readonly timeoutMs: number;
  private readonly timeRange: ApifySearchActorInput["time"];
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    actorId: string;
    token: string;
    maximumItems?: number;
    enrichmentLimit?: number;
    enrichmentComments?: number;
    timeoutMs?: number;
    timeRange?: ApifySearchActorInput["time"];
    fetchImpl?: typeof fetch;
  }) {
    this.actorId = apifyActorId(input.actorId);
    this.token = input.token.trim();
    if (!this.token) throw new Error("APIFY_TOKEN is required for the Apify Reddit test provider.");
    this.maximumItems = Math.max(1, Math.min(100, Math.trunc(input.maximumItems ?? 50)));
    this.enrichmentLimit = Math.max(1, Math.min(20, Math.trunc(input.enrichmentLimit ?? 8)));
    this.enrichmentComments = Math.max(0, Math.min(20, Math.trunc(input.enrichmentComments ?? 6)));
    this.timeoutMs = Math.max(20_000, Math.min(600_000, Math.trunc(input.timeoutMs ?? 360_000)));
    this.timeRange = input.timeRange ?? "month";
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async runActor(
    actorInput: ApifyRedditActorInput,
    timeoutMs = this.timeoutMs,
  ): Promise<unknown[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
    };

    const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
      const declaredBytes = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
        throw new Error("The Apify Reddit test response exceeded the size limit.");
      }
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > maximumBytes) {
        throw new Error("The Apify Reddit test response exceeded the size limit.");
      }
      if (!response.ok) {
        throw new Error(`Apify Reddit test request failed with HTTP ${response.status}.`);
      }
      try {
        return raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error("The Apify Reddit test provider returned invalid JSON.");
      }
    };

    const safeGet = async (endpoint: URL): Promise<Response> => {
      const retryableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await this.fetchImpl(endpoint, {
            method: "GET",
            headers,
            signal: controller.signal,
          });
          if (response.ok || !retryableStatuses.has(response.status) || attempt === 2) return response;

          const retryAfterHeader = response.headers.get("retry-after");
          const retryAfterSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
          await response.text().catch(() => "");
          const delayMs = Number.isFinite(retryAfterSeconds)
            ? Math.min(Math.max(0, retryAfterSeconds * 1_000), 5_000)
            : Math.min(500 * 2 ** attempt, 2_000);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted || attempt === 2) throw error;
          await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** attempt, 2_000)));
        }
      }
      throw lastError ?? new Error("Apify Reddit test GET request failed.");
    };

    const runData = (payload: unknown): Record<string, unknown> => {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("The Apify Reddit test provider returned invalid run metadata.");
      }
      const data = (payload as { data?: unknown }).data;
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("The Apify Reddit test provider returned invalid run metadata.");
      }
      return data as Record<string, unknown>;
    };

    let runId = "";
    let status = "NOT_STARTED";
    let pollCount = 0;

    try {
      const startEndpoint = new URL(
        `/v2/actors/${encodeURIComponent(this.actorId)}/runs`,
        "https://api.apify.com",
      );
      // Start asynchronously and obtain the run ID immediately. Holding this
      // non-idempotent POST open while the Actor works makes a transient gateway
      // 502 ambiguous: retrying could create and charge for a duplicate run.
      // Once we have runId, all waiting/reading happens through retry-safe GETs.
      startEndpoint.searchParams.set("waitForFinish", "0");
      startEndpoint.searchParams.set("timeout", String(apifyActorTimeoutSeconds(timeoutMs)));
      startEndpoint.searchParams.set("maxItems", String(Math.min(100, actorInput.maxItems)));
      startEndpoint.searchParams.set("maxTotalChargeUsd", "0.50");

      const startResponse = await this.fetchImpl(startEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(actorInput),
        signal: controller.signal,
      });
      const started = runData(await readJson(startResponse, 1_000_000));
      runId = stringValue(started.id, 120);
      status = stringValue(started.status, 40).toUpperCase();
      let statusMessage = stringValue(started.statusMessage, 500);
      let datasetId = stringValue(started.defaultDatasetId, 120);
      if (!runId || !status) {
        throw new Error("The Apify Reddit test provider returned incomplete run metadata.");
      }

      const terminalStatuses = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
      while (!terminalStatuses.has(status)) {
        pollCount += 1;
        const statusEndpoint = new URL(
          `/v2/actor-runs/${encodeURIComponent(runId)}`,
          "https://api.apify.com",
        );
        statusEndpoint.searchParams.set("waitForFinish", "60");
        const statusResponse = await safeGet(statusEndpoint);
        const current = runData(await readJson(statusResponse, 1_000_000));
        status = stringValue(current.status, 40).toUpperCase();
        statusMessage = stringValue(current.statusMessage, 500);
        datasetId = stringValue(current.defaultDatasetId, 120) || datasetId;
        if (!status) {
          throw new Error("The Apify Reddit test provider returned incomplete run status.");
        }
      }

      const usablePartialDataset = status === "TIMED-OUT" && Boolean(datasetId);
      if (status !== "SUCCEEDED" && !usablePartialDataset) {
        throw new Error(
          `The Apify Reddit test run ended with status ${status}${statusMessage ? `: ${statusMessage}` : ""}.`,
        );
      }
      if (!datasetId) {
        throw new Error("The Apify Reddit test run completed without a dataset.");
      }

      const datasetEndpoint = new URL(
        `/v2/datasets/${encodeURIComponent(datasetId)}/items`,
        "https://api.apify.com",
      );
      datasetEndpoint.searchParams.set("clean", "true");
      datasetEndpoint.searchParams.set("format", "json");
      datasetEndpoint.searchParams.set("limit", String(Math.min(100, actorInput.maxItems)));

      const datasetResponse = await safeGet(datasetEndpoint);
      const payload = await readJson(datasetResponse, 5_000_000);
      if (!Array.isArray(payload)) {
        throw new Error("The Apify Reddit test provider returned an invalid dataset.");
      }
      if (usablePartialDataset && payload.length === 0) {
        throw new Error("The timed-out Apify Reddit test run did not retain any usable records.");
      }
      if (usablePartialDataset) {
        console.warn("Using bounded partial Apify Reddit results after Actor timeout", {
          actorStatus: status,
          datasetItems: payload.length,
        });
      }
      return payload;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `The Apify Reddit test run timed out after ${Math.ceil(timeoutMs / 1_000)} seconds ` +
          `(actor status ${status || "UNKNOWN"}, polls ${pollCount}, run ${runId || "not-started"}).`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const searchPlan = buildApifyRedditSearchPlan(request);
    if (searchPlan.length === 0) {
      throw new Error("The company context did not produce any usable Reddit search lanes.");
    }
    const searches = searchPlan.map((entry) => entry.query);
    const maxItems = Math.min(
      this.maximumItems,
      Math.max(40, Math.min(50, request.limit * 2)),
    );
    const sinceMs = request.since && Number.isFinite(Date.parse(request.since))
      ? Date.parse(request.since)
      : null;
    const dateLimit = sinceMs === null
      ? undefined
      : new Date(sinceMs).toISOString().slice(0, 10);
    const subreddit = request.subreddits?.length === 1
      ? request.subreddits[0]?.replace(/^r\//i, "").trim()
      : undefined;
    const discoveryInput: ApifySearchActorInput = {
      searches,
      ignoreStartUrls: true,
      skipComments: true,
      skipUserPosts: true,
      skipCommunity: true,
      includeMediaLinks: false,
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      // Rank by semantic relevance, but bound both posts and comments by the
      // explicit recent cutoff. skipComments only prevents traversing every
      // matched post; direct comment search remains enabled.
      sort: "relevance",
      time: boundedSearchTime(this.timeRange, request.since),
      ...(dateLimit ? { postDateLimit: dateLimit, commentDateLimit: dateLimit } : {}),
      includeNSFW: false,
      maxItems,
      maxPostCount: maxItems,
      // This bounds direct comment result pages while skipComments prevents
      // unrelated thread traversal from consuming the global discovery budget.
      maxComments: 10,
      maxCommunitiesCount: 0,
      maxUserCount: 0,
      scrollTimeout: 20,
      navigationTimeout: 30,
      debugMode: false,
      proxy: {
        useApifyProxy: true,
        apifyProxyGroups: ["RESIDENTIAL"],
      },
      ...(subreddit && /^[A-Za-z0-9_]{1,32}$/.test(subreddit)
        ? { searchCommunityName: subreddit }
        : {}),
    };

    // Nine bounded searches with a residential proxy can legitimately run
    // longer than the old eight-minute client budget. Items and per-run charge
    // remain capped; the remote Actor receives a 570-second budget and the
    // client gets 30 seconds to observe its terminal status and dataset.
    const discoveryTimeoutMs = Math.min(600_000, Math.max(this.timeoutMs, 600_000));
    const payload = await this.runActor(discoveryInput, discoveryTimeoutMs);
    const rejectedByReason = emptyProviderRejections();
    const parsed: ApifyCandidate[] = [];
    for (const value of payload) {
      const result = candidateFromApify(value, searchPlan);
      if (!result.candidate) {
        rejectedByReason[result.reason] += 1;
        continue;
      }
      if (sinceMs !== null && Date.parse(result.candidate.createdAt) < sinceMs) {
        rejectedByReason.outside_window += 1;
        continue;
      }
      parsed.push(result.candidate);
    }

    const byKey = new Map<string, ApifyCandidate>();
    for (const candidate of parsed) {
      const key = `${candidate.kind}:${candidate.externalId}`;
      const current = byKey.get(key);
      if (!current) {
        byKey.set(key, candidate);
        continue;
      }
      byKey.set(key, {
        ...current,
        matchedQuery: current.matchedQuery ?? candidate.matchedQuery,
        matchedQueries: [...new Set([...current.matchedQueries, ...candidate.matchedQueries])],
        discoveryLanes: [...new Set([...current.discoveryLanes, ...candidate.discoveryLanes])],
      });
    }

    const candidates = [...byKey.values()].slice(0, maxItems).map((candidate) => {
      const normalized = { ...candidate };
      Reflect.deleteProperty(normalized, "item");
      return normalized;
    });
    const laneQueryCounts: Partial<Record<RedditSearchLane, number>> = {};
    for (const entry of searchPlan) laneQueryCounts[entry.lane] = (laneQueryCounts[entry.lane] ?? 0) + 1;
    const diagnostics: RedditDiscoveryDiagnostics = {
      queryCount: searchPlan.length,
      fetchedCandidates: payload.length,
      normalizedCandidates: parsed.length,
      verifiedRecentCandidates: candidates.length,
      rejectedByReason,
      laneQueryCounts,
    };
    return { candidates, searchPlan, sourceMode: this.sourceMode, diagnostics };
  }

  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
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

  /** Deprecated compatibility path. The active scan uses discover -> AI -> enrich. */
  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const discovery = await this.discover(request);
    const selected = discovery.candidates.slice(0, Math.min(this.enrichmentLimit, request.limit));
    const enrichment = await this.enrich({ candidates: selected });
    return {
      conversations: enrichment.conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: discovery.diagnostics.queryCount,
        fetchedCandidates: discovery.diagnostics.fetchedCandidates,
        normalizedCandidates: discovery.diagnostics.normalizedCandidates,
        locallyMatchedCandidates: discovery.candidates.length,
        enrichmentAttempts: enrichment.diagnostics.requested,
        enrichedConversations: enrichment.diagnostics.enriched,
        verifiedRecentConversations: enrichment.conversations.length,
        missingVerifiedTimestamps: discovery.diagnostics.rejectedByReason.missing_timestamp,
        rejectedCandidates: Object.values(discovery.diagnostics.rejectedByReason).reduce((sum, count) => sum + count, 0),
        enrichmentFallbacks: enrichment.diagnostics.fallbackUsed,
      },
    };
  }
}

function normalizedConversation(
  value: ApprovedProviderConversation,
  providerName: string,
): RedditConversation {
  const externalId = typeof value.externalId === "string" ? value.externalId.trim() : "";
  const subreddit = typeof value.subreddit === "string" ? value.subreddit.trim() : "";
  const body = typeof value.body === "string" ? value.body.trim() : "";
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : "";
  if (!externalId || !subreddit || !body || !Number.isFinite(Date.parse(createdAt))) {
    throw new Error("The approved provider returned an incomplete Reddit conversation.");
  }
  const kind = value.kind === "comment" ? "comment" : "post";
  const title = typeof value.title === "string" && value.title.trim() ? value.title.trim() : undefined;
  const author = typeof value.author === "string" && value.author.trim() ? value.author.trim() : undefined;
  const score = Number(value.score);
  const comments = Number(value.comments);
  const permalink = redditPermalink(value.permalink);
  const observedAt = new Date().toISOString();
  const hash = contentFingerprint(`${title ?? ""}\n${body}`);
  return {
    provider: providerName,
    sourceMode: "live",
    externalId,
    kind,
    subreddit: subreddit.replace(/^r\//i, ""),
    title,
    body,
    author,
    permalink,
    createdAt: new Date(createdAt).toISOString(),
    metrics: {
      score: Number.isFinite(score) ? Math.max(0, Math.trunc(score)) : 0,
      comments: Number.isFinite(comments) ? Math.max(0, Math.trunc(comments)) : 0,
    },
    matchedQueries: [],
    discoveryLanes: [],
    provenance: {
      id: `reddit_${providerName}_${contentFingerprint(externalId)}`,
      kind: "reddit",
      provider: providerName,
      providerExternalId: externalId,
      url: permalink,
      title,
      excerpt: body.slice(0, 280),
      contentHash: hash,
      observedAt,
      isMock: false,
    },
  };
}

function discoveryCandidateFromConversation(conversation: RedditConversation): RedditDiscoveryCandidate {
  return {
    provider: conversation.provider,
    sourceMode: conversation.sourceMode,
    externalId: conversation.externalId,
    kind: conversation.kind,
    parentExternalId: conversation.parentExternalId,
    subreddit: conversation.subreddit,
    title: conversation.title,
    body: conversation.body,
    author: conversation.author,
    permalink: conversation.permalink,
    createdAt: conversation.createdAt,
    metrics: conversation.metrics,
    matchedQuery: conversation.matchedQuery,
    matchedQueries: conversation.matchedQueries ?? (conversation.matchedQuery ? [conversation.matchedQuery] : []),
    discoveryLanes: conversation.discoveryLanes ?? [],
    provenance: conversation.provenance,
  };
}

function matchedOnlyEnriched(candidate: RedditDiscoveryCandidate): EnrichedRedditConversation {
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

/**
 * Normalized adapter for an approved Reddit API provider. Discovery uses its
 * existing /search contract. Until an approved provider exposes a thread API,
 * enrichment preserves the matched record as structured context without
 * inventing surrounding comments.
 */
export class ApprovedHttpRedditProvider implements RedditProvider {
  readonly name: string;
  readonly sourceMode = "live" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(input: {
    baseUrl: string;
    apiKey: string;
    name?: string;
    fetchImpl?: typeof fetch;
  }) {
    const base = new URL(input.baseUrl);
    if (base.protocol !== "https:" || base.username || base.password) {
      throw new Error("REDDIT_API_BASE_URL must be a credential-free HTTPS URL.");
    }
    this.baseUrl = base.toString().replace(/\/$/, "");
    this.apiKey = input.apiKey;
    this.name = input.name ?? "approved-http";
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async rawSearch(request: RedditSearchRequest): Promise<{ conversations: RedditConversation[]; nextCursor?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...request, limit: Math.max(1, Math.min(request.limit, 100)) }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const declaredBytes = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredBytes) && declaredBytes > 2_000_000) {
      throw new Error("The approved Reddit provider response exceeded the size limit.");
    }
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error("The approved Reddit provider response exceeded the size limit.");
    if (!response.ok) throw new Error(`Approved Reddit provider request failed with HTTP ${response.status}.`);
    const payload = JSON.parse(raw) as ApprovedProviderResponse;
    if (!Array.isArray(payload.conversations)) {
      throw new Error("The approved Reddit provider returned an invalid response.");
    }
    return {
      conversations: payload.conversations.map((value) =>
        normalizedConversation(value as ApprovedProviderConversation, this.name),
      ),
      nextCursor: typeof payload.nextCursor === "string" ? payload.nextCursor : undefined,
    };
  }

  async discover(request: RedditSearchRequest): Promise<RedditDiscoveryResponse> {
    const raw = await this.rawSearch(request);
    const candidates = raw.conversations.map(discoveryCandidateFromConversation);
    return {
      candidates,
      nextCursor: raw.nextCursor,
      searchPlan: [],
      sourceMode: this.sourceMode,
      diagnostics: {
        queryCount: 0,
        fetchedCandidates: candidates.length,
        normalizedCandidates: candidates.length,
        verifiedRecentCandidates: candidates.length,
        rejectedByReason: emptyProviderRejections(),
        laneQueryCounts: {},
      },
    };
  }

  async enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse> {
    const conversations = request.candidates.map(matchedOnlyEnriched);
    return {
      conversations,
      sourceMode: this.sourceMode,
      diagnostics: {
        requested: request.candidates.length,
        enriched: conversations.length,
        failed: 0,
        fallbackUsed: conversations.length,
      },
    };
  }

  async search(request: RedditSearchRequest): Promise<RedditSearchResponse> {
    const discovery = await this.discover(request);
    return {
      conversations: discovery.candidates.map(matchedOnlyEnriched),
      nextCursor: discovery.nextCursor,
      sourceMode: this.sourceMode,
    };
  }
}

/** Provider selection is deliberately explicit; missing credentials never masquerade as live data. */
export function createRedditProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  liveProviders: Readonly<Record<string, RedditProvider>> = {},
): RedditProvider {
  const selected =
    env.REDDIT_PROVIDER?.trim().toLocaleLowerCase("en-US") ||
    (isProductionRuntime(env) ? "" : "mock");
  if (!selected) {
    throw new Error(
      "REDDIT_PROVIDER must explicitly select `mock`, `apify-test`, or an approved live provider.",
    );
  }
  if (selected === "mock") return new MockRedditProvider();
  if (selected === "apify-test" || selected === "apify") {
    if (env.APIFY_REDDIT_TEST_MODE?.trim().toLowerCase() !== "true") {
      throw new Error(
        "The Apify Reddit scraper is test-only. Set APIFY_REDDIT_TEST_MODE=true to opt in explicitly.",
      );
    }
    const allowedTimeRanges = new Set(["day", "week", "month", "year", "all"] as const);
    const configuredTimeRange = env.APIFY_REDDIT_TIME_RANGE?.trim().toLowerCase() || "month";
    if (!allowedTimeRanges.has(configuredTimeRange as "day" | "week" | "month" | "year" | "all")) {
      throw new Error("APIFY_REDDIT_TIME_RANGE must be day, week, month, year, or all.");
    }
    return new ApifyRedditTestProvider({
      actorId: required(env.APIFY_REDDIT_ACTOR_ID, "APIFY_REDDIT_ACTOR_ID"),
      token: required(env.APIFY_TOKEN, "APIFY_TOKEN"),
      maximumItems: positiveInteger(env.APIFY_REDDIT_MAX_RESULTS, 50, 1, 100),
      enrichmentLimit: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_LIMIT, 8, 1, 20),
      enrichmentComments: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_COMMENTS, 6, 0, 20),
      timeoutMs: positiveInteger(env.APIFY_REDDIT_TIMEOUT_MS, 360_000, 20_000, 600_000),
      timeRange: configuredTimeRange as "day" | "week" | "month" | "year" | "all",
    });
  }
  if (selected === "approved-http") {
    return new ApprovedHttpRedditProvider({
      baseUrl: required(env.REDDIT_API_BASE_URL, "REDDIT_API_BASE_URL"),
      apiKey: required(env.REDDIT_API_KEY, "REDDIT_API_KEY"),
    });
  }

  const provider = liveProviders[selected];
  if (!provider) throw new Error(`The configured Reddit provider ${selected} is not registered.`);
  if (provider.sourceMode !== "live") {
    throw new Error(`The configured provider ${selected} is not a live Reddit API provider.`);
  }
  return provider;
}
