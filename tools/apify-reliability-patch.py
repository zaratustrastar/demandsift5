from pathlib import Path

provider_path = Path('lib/providers/reddit.server.ts')
text = provider_path.read_text()

old = '''    const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
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
'''
new = '''    const readJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
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
'''
assert old in text, 'readJson marker missing'
text = text.replace(old, new, 1)

old = '''      startEndpoint.searchParams.set("waitForFinish", "60");
      startEndpoint.searchParams.set("timeout", String(apifyActorTimeoutSeconds(timeoutMs)));'''
new = '''      // Start asynchronously and obtain the run ID immediately. Holding this
      // non-idempotent POST open while the Actor works makes a transient gateway
      // 502 ambiguous: retrying could create and charge for a duplicate run.
      // Once we have runId, all waiting/reading happens through retry-safe GETs.
      startEndpoint.searchParams.set("waitForFinish", "0");
      startEndpoint.searchParams.set("timeout", String(apifyActorTimeoutSeconds(timeoutMs)));'''
assert old in text, 'start waitForFinish marker missing'
text = text.replace(old, new, 1)

old = '''        const statusResponse = await this.fetchImpl(statusEndpoint, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const current = runData(await readJson(statusResponse, 1_000_000));'''
new = '''        const statusResponse = await safeGet(statusEndpoint);
        const current = runData(await readJson(statusResponse, 1_000_000));'''
assert old in text, 'status GET marker missing'
text = text.replace(old, new, 1)

old = '''      const datasetResponse = await this.fetchImpl(datasetEndpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const payload = await readJson(datasetResponse, 5_000_000);'''
new = '''      const datasetResponse = await safeGet(datasetEndpoint);
      const payload = await readJson(datasetResponse, 5_000_000);'''
assert old in text, 'dataset GET marker missing'
text = text.replace(old, new, 1)
provider_path.write_text(text)

test_path = Path('tests/apify-reddit-provider.test.mjs')
tests = test_path.read_text()
marker = '\ntest("Actor timeout stays below the client budget so terminal status can be observed", () => {'
assert marker in tests, 'test insertion marker missing'
test_case = r'''

test("Actor start is immediate and transient status/dataset GET failures retry without duplicate runs", async () => {
  const calls = [];
  let startCalls = 0;
  let statusCalls = 0;
  let datasetCalls = 0;
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper-lite",
    token: "private-apify-token",
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      calls.push({ url: parsedUrl, init });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        startCalls += 1;
        return new Response(JSON.stringify({
          data: { id: "run-safe-retry", status: "RUNNING", defaultDatasetId: "dataset-safe-retry" },
        }), { status: 201 });
      }

      if (parsedUrl.pathname.endsWith("/actor-runs/run-safe-retry")) {
        statusCalls += 1;
        if (statusCalls === 1) return new Response("temporary gateway failure", { status: 502 });
        return new Response(JSON.stringify({
          data: { id: "run-safe-retry", status: "SUCCEEDED", defaultDatasetId: "dataset-safe-retry" },
        }), { status: 200 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-safe-retry/items")) {
        datasetCalls += 1;
        if (datasetCalls === 1) return new Response("temporary dataset failure", { status: 503 });
        return new Response(JSON.stringify([documentedActorItem]), { status: 200 });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const result = await provider.discover(searchRequest);

  assert.equal(startCalls, 1, "the non-idempotent paid Actor start must never be blindly retried");
  assert.equal(statusCalls, 2);
  assert.equal(datasetCalls, 2);
  assert.equal(result.candidates.length, 1);
  const start = calls.find((call) => call.init.method === "POST");
  assert.ok(start);
  assert.equal(start.url.searchParams.get("waitForFinish"), "0");
  assert.ok(calls.filter((call) => call.init.method === "GET").every((call) => !call.url.pathname.includes("/actors/")));
});
'''
tests = tests.replace(marker, test_case + marker, 1)
test_path.write_text(tests)
