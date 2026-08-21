/**
 * Recurring-theme aggregation over the relevant conversation corpus.
 *
 * The report needs "what customers are struggling with" and "what they are
 * asking for" as recurring themes rather than a list of individual posts. Those
 * themes are produced here deterministically from the conversations' own
 * wording, so every theme label is traceable to text that actually appeared and
 * carries the sources that support it. Nothing is invented: a theme exists only
 * where several conversations independently share a phrase.
 */

const THEME_STOP_WORDS = new Set([
  "a", "able", "about", "after", "all", "also", "am", "an", "and", "any", "anyone",
  "are", "around", "as", "at", "back", "be", "because", "been", "being", "but",
  "by", "can", "cant", "could", "did", "do", "does", "doing", "dont", "down",
  "each", "even", "every", "for", "from", "get", "getting", "go", "going", "got",
  "had", "has", "have", "having", "he", "her", "here", "him", "his", "how", "i",
  "if", "im", "in", "into", "is", "it", "its", "ive", "just", "keep", "know",
  "like", "look", "looking", "lot", "make", "makes", "many", "me", "more", "most",
  "much", "my", "need", "no", "not", "now", "of", "on", "one", "only", "or",
  "other", "our", "out", "over", "really", "right", "said", "same", "see", "she",
  "should", "so", "some", "someone", "something", "still", "such", "sure", "take",
  "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "thing", "things", "think", "this", "those", "through", "time", "to", "too",
  "try", "trying", "up", "us", "use", "used", "using", "very", "want", "was",
  "way", "we", "well", "were", "what", "when", "where", "which", "while", "who",
  "why", "will", "with", "without", "would", "you", "your",
]);

export type ThemeKind = "struggle" | "request";

export interface ThemeConversationInput {
  sourceId: string;
  /** Text the theme is drawn from: the problem summary, or title plus body. */
  text: string;
  kind: ThemeKind;
  /** Ordering weight, e.g. evidence quality or pain severity. */
  weight?: number;
}

export interface ConversationTheme {
  label: string;
  kind: ThemeKind;
  conversationCount: number;
  /** Provenance ids backing this theme, so the UI can show the evidence. */
  sourceIds: string[];
}

export interface ThemeClusteringOptions {
  maxThemes: number;
  /**
   * Conversations required before a shared phrase counts as recurring. Two is
   * the floor: a single conversation is an anecdote, not a theme.
   */
  minimumConversations: number;
}

/**
 * Words that carry no meaning even inside a phrase. Deliberately smaller than
 * THEME_STOP_WORDS: words like "time" are noise on their own but essential
 * inside "screen time", which is exactly the kind of theme worth reporting.
 */
const PHRASE_FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "for", "from", "had",
  "has", "have", "i", "in", "is", "it", "its", "me", "my", "no", "not", "of",
  "on", "or", "our", "so", "that", "the", "them", "they", "this", "to",
  "was", "we", "were", "with", "you", "your",
]);

function allTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function themeTokens(value: string): string[] {
  return allTokens(value).filter(
    (token) => token.length >= 3 && !THEME_STOP_WORDS.has(token),
  );
}

/**
 * Bigrams are taken from adjacent words in the *original* text, never from the
 * filtered token list. Pairing survivors of a filter would invent phrases like
 * "screen limits" that no conversation actually contains, and a theme label
 * has to be traceable to real wording.
 */
function candidatePhrases(value: string): string[] {
  const sequence = allTokens(value);
  const phrases = new Set<string>();
  for (let index = 0; index + 1 < sequence.length; index += 1) {
    const left = sequence[index];
    const right = sequence[index + 1];
    if (left.length < 3 || right.length < 3) continue;
    if (PHRASE_FUNCTION_WORDS.has(left) || PHRASE_FUNCTION_WORDS.has(right)) continue;
    phrases.add(`${left} ${right}`);
  }
  for (const token of themeTokens(value)) phrases.add(token);
  return [...phrases];
}

function titleCase(value: string): string {
  return value.charAt(0).toLocaleUpperCase("en-US") + value.slice(1);
}

/**
 * Greedy set cover over shared phrases.
 *
 * Each round takes the phrase covering the most not-yet-assigned
 * conversations, so themes are distinct rather than many rewordings of the
 * same pattern. A conversation belongs to one theme, which keeps the reported
 * counts honest and additive.
 */
export function clusterThemes(
  conversations: readonly ThemeConversationInput[],
  kind: ThemeKind,
  options: ThemeClusteringOptions,
): ConversationTheme[] {
  const maxThemes = Math.max(0, Math.trunc(options.maxThemes));
  const minimum = Math.max(2, Math.trunc(options.minimumConversations));
  if (maxThemes === 0) return [];

  const pool = conversations.filter((row) => row.kind === kind && row.text.trim().length > 0);
  // Deduplicate by source so one conversation cannot inflate a theme.
  const bySource = new Map<string, ThemeConversationInput>();
  for (const row of pool) if (!bySource.has(row.sourceId)) bySource.set(row.sourceId, row);

  const phrasesBySource = new Map<string, Set<string>>();
  for (const [sourceId, row] of bySource) {
    phrasesBySource.set(sourceId, new Set(candidatePhrases(row.text)));
  }

  const unassigned = new Set(bySource.keys());
  const themes: ConversationTheme[] = [];

  while (themes.length < maxThemes && unassigned.size >= minimum) {
    const coverage = new Map<string, string[]>();
    for (const sourceId of unassigned) {
      for (const phrase of phrasesBySource.get(sourceId) ?? []) {
        const bucket = coverage.get(phrase) ?? [];
        bucket.push(sourceId);
        coverage.set(phrase, bucket);
      }
    }

    let bestPhrase: string | null = null;
    let bestSources: string[] = [];
    for (const [phrase, sources] of coverage) {
      if (sources.length < minimum) continue;
      const isBetter =
        sources.length > bestSources.length ||
        // Prefer the more specific phrase when coverage ties.
        (sources.length === bestSources.length &&
          bestPhrase !== null &&
          phrase.includes(" ") &&
          !bestPhrase.includes(" "));
      if (isBetter) {
        bestPhrase = phrase;
        bestSources = sources;
      }
    }

    if (!bestPhrase) break;

    const ordered = bestSources
      .map((sourceId) => bySource.get(sourceId)!)
      .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
      .map((row) => row.sourceId);

    themes.push({
      label: titleCase(bestPhrase),
      kind,
      conversationCount: ordered.length,
      sourceIds: ordered,
    });
    for (const sourceId of bestSources) unassigned.delete(sourceId);
  }

  return themes;
}
