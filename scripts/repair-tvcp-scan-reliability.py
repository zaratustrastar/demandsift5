from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label} anchor changed")
    return text.replace(old, new, 1)


# Reddit discovery: search recent posts AND recent comments.
path = Path("lib/providers/reddit.server.ts")
source = path.read_text()
source = replace_once(
    source,
    '''type ApifySearchActorInput = {
  searches: string[];
  ignoreStartUrls: true;
  skipComments: true;
  skipUserPosts: true;
  skipCommunity: true;
  includeMediaLinks: false;
  searchPosts: true;
  searchComments: true;
  searchCommunities: false;
  searchUsers: false;
  searchMedia: false;
  sort: "relevance";
  time: "day" | "week" | "month" | "year" | "all";
  includeNSFW: false;''',
    '''type ApifySearchActorInput = {
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
  includeNSFW: false;''',
    "Apify search input type",
)
source = replace_once(
    source,
    '''    const maxItems = Math.min(
      this.maximumItems,
      Math.max(30, Math.min(36, request.limit * 2)),
    );''',
    '''    const maxItems = Math.min(
      this.maximumItems,
      Math.max(40, Math.min(50, request.limit * 2)),
    );
    const sinceMs = request.since && Number.isFinite(Date.parse(request.since))
      ? Date.parse(request.since)
      : null;
    const dateLimit = sinceMs === null
      ? undefined
      : new Date(sinceMs).toISOString().slice(0, 10);''',
    "Apify discovery budget",
)
source = replace_once(
    source,
    '''    const discoveryInput: ApifySearchActorInput = {
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
      sort: "relevance",
      time: boundedSearchTime(this.timeRange, request.since),
      includeNSFW: false,
      maxItems,
      // Trudax applies maxPostCount across the whole Actor run, not once per
      // search phrase. Dividing this by the query count silently starves a
      // nine-lane scan to only a handful of posts before AI triage can run.
      // Keep it aligned with the already-bounded global item budget.
      maxPostCount: maxItems,
      maxComments: 0,''',
    '''    const discoveryInput: ApifySearchActorInput = {
      searches,
      ignoreStartUrls: true,
      skipUserPosts: true,
      skipCommunity: true,
      includeMediaLinks: false,
      searchPosts: true,
      searchComments: true,
      searchCommunities: false,
      searchUsers: false,
      searchMedia: false,
      // Recent demand matters more than historic relevance ranking. Trudax's
      // `time` filter only bounds posts, so give comment search the same
      // explicit cutoff and never combine searchComments with skipComments.
      sort: "new",
      time: boundedSearchTime(this.timeRange, request.since),
      ...(dateLimit ? { postDateLimit: dateLimit, commentDateLimit: dateLimit } : {}),
      includeNSFW: false,
      maxItems,
      maxPostCount: maxItems,
      // Keep traversal bounded while allowing direct recent comment search.
      maxComments: 3,''',
    "Apify discovery input",
)
# The old code declared sinceMs again after the Actor returned.
source = replace_once(
    source,
    '''    const rejectedByReason = emptyProviderRejections();
    const sinceMs = request.since && Number.isFinite(Date.parse(request.since))
      ? Date.parse(request.since)
      : null;
    const parsed: ApifyCandidate[] = [];''',
    '''    const rejectedByReason = emptyProviderRejections();
    const parsed: ApifyCandidate[] = [];''',
    "Apify duplicate sinceMs",
)
path.write_text(source)

path = Path("tests/apify-reddit-provider.test.mjs")
test = path.read_text()
test = replace_once(
    test,
    '''  assert.equal(discovery.searchPosts, true);
  assert.equal(discovery.searchComments, true);
  assert.equal(discovery.skipComments, true);
  assert.equal(discovery.includeMediaLinks, false);
  assert.equal(discovery.maxComments, 0);
  assert.equal(discovery.maxItems, 36);
  assert.equal(discovery.maxPostCount, 36);
  assert.equal(
    discovery.maxPostCount,
    discovery.maxItems,
    "the Actor-wide post cap must not be divided by the number of searches",
  );
  assert.equal(startCall.url.searchParams.get("maxItems"), "36");
  assert.equal(startCall.url.searchParams.get("timeout"), "570");
  assert.equal(discovery.time, "week");
  assert.equal(Object.hasOwn(discovery, "postDateLimit"), false);
  assert.equal(Object.hasOwn(discovery, "commentDateLimit"), false);''',
    '''  assert.equal(discovery.searchPosts, true);
  assert.equal(discovery.searchComments, true);
  assert.equal(Object.hasOwn(discovery, "skipComments"), false);
  assert.equal(discovery.includeMediaLinks, false);
  assert.equal(discovery.sort, "new");
  assert.equal(discovery.maxComments, 3);
  assert.equal(discovery.maxItems, 40);
  assert.equal(discovery.maxPostCount, 40);
  assert.equal(startCall.url.searchParams.get("maxItems"), "40");
  assert.equal(startCall.url.searchParams.get("timeout"), "570");
  assert.equal(discovery.time, "week");
  assert.match(discovery.postDateLimit, /^\\d{4}-\\d{2}-\\d{2}$/);
  assert.equal(discovery.commentDateLimit, discovery.postDateLimit);''',
    "Apify discovery assertions",
)
path.write_text(test)

# AI triage: smaller batches, and recursively split a batch if the provider
# still exhausts the structured-output budget after its bounded retries.
path = Path("lib/providers/openai.server.ts")
source = path.read_text()
source = replace_once(source, "const TRIAGE_BATCH_SIZE = 8;", "const TRIAGE_BATCH_SIZE = 4;", "triage batch size")
error_anchor = '''function isRetryableStructuredOutputError(error: unknown): error is OpenAiProviderError {
  if (!(error instanceof OpenAiProviderError) || error.status !== undefined) return false;
  if (isMalformedStructuredJson(error)) return true;
  return /^OpenAI returned (?:an invalid|unknown externalId|duplicate externalId)/.test(error.message);
}
'''
source = replace_once(
    source,
    error_anchor,
    error_anchor + '''
function isStructuredLengthExhaustion(error: unknown): error is OpenAiProviderError {
  return error instanceof OpenAiProviderError
    && error.status === undefined
    && /(?:finish_reason=length|incomplete response(?::|.*)\\s*(?:max_tokens|max_output_tokens))/i.test(error.message);
}
''',
    "structured length helper",
)
old_loop = '''    // Keep marketplace requests small enough to finish comfortably inside the
    // provider timeout. One oversized 25-35 candidate JSON response can time out
    // after Reddit discovery has already succeeded and waste the whole scan.
    for (let offset = 0; offset < expectedIds.length; offset += TRIAGE_BATCH_SIZE) {
      const pending = new Set(expectedIds.slice(offset, offset + TRIAGE_BATCH_SIZE));
      for (let attempt = 0; attempt <= retries && pending.size > 0; attempt += 1) {
        const result = await this.triageAttempt(request, pending);
        attempts.push(result);
        for (const item of result.value) {
          collected.set(item.externalId, item);
          pending.delete(item.externalId);
        }
      }
      if (pending.size > 0) {
        throw new OpenAiProviderError(
          `OpenAI triage coverage remained incomplete after retries; missing externalIds: ${[...pending].join(", ")}.`,
        );
      }
    }'''
new_loop = '''    // Keep marketplace requests small. If even a bounded structured response
    // exhausts the gateway's output budget, recursively split only that batch.
    // One oversized provider response must never discard the rest of a scan.
    const processBatch = async (batchIds: readonly string[]): Promise<void> => {
      const pending = new Set(batchIds);
      try {
        for (let attempt = 0; attempt <= retries && pending.size > 0; attempt += 1) {
          const result = await this.triageAttempt(request, pending);
          attempts.push(result);
          for (const item of result.value) {
            collected.set(item.externalId, item);
            pending.delete(item.externalId);
          }
        }
      } catch (error) {
        if (isStructuredLengthExhaustion(error) && pending.size > 1) {
          const remaining = [...pending];
          const middle = Math.ceil(remaining.length / 2);
          await processBatch(remaining.slice(0, middle));
          await processBatch(remaining.slice(middle));
          return;
        }
        throw error;
      }
      if (pending.size > 0) {
        throw new OpenAiProviderError(
          `OpenAI triage coverage remained incomplete after retries; missing externalIds: ${[...pending].join(", ")}.`,
        );
      }
    };

    for (let offset = 0; offset < expectedIds.length; offset += TRIAGE_BATCH_SIZE) {
      await processBatch(expectedIds.slice(offset, offset + TRIAGE_BATCH_SIZE));
    }'''
source = replace_once(source, old_loop, new_loop, "triage processing loop")
path.write_text(source)

path = Path("tests/openai-intelligence-pipeline.test.mjs")
test = path.read_text()
test = replace_once(
    test,
    "assert.deepEqual(calls.map((ids) => ids.length), [8, 8, 1]);",
    "assert.deepEqual(calls.map((ids) => ids.length), [4, 4, 4, 4, 1]);",
    "bounded triage batch assertion",
)
marker = 'test("an empty length-limited gateway response is retried inside the AI provider", async () => {'
regression = '''test("triage splits a persistently length-limited batch instead of failing the scan", async () => {
  const calls = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      calls.push(ids);
      if (ids.length > 2) {
        return new Response(JSON.stringify({
          id: "chat_exhausted",
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { prompt_tokens: 10, completion_tokens: body.max_tokens },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });

  const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(calls.map((ids) => ids.length), [4, 4, 4, 2, 2]);
  assert.deepEqual(result.value.map((row) => row.externalId), ["a", "b", "c", "d"]);
});

'''
test = replace_once(test, marker, regression + marker, "length split regression insertion")
path.write_text(test)
