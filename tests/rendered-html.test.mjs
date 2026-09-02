import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const serverUrl = new URL("../dist/server/index.js", import.meta.url);
  serverUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: server } = await import(serverUrl.href);
  const request = new Request(`http://localhost${path}`, {
    headers: { accept: "text/html" },
  });

  // Node builds export the request handler directly; the Sites/Workers preview
  // exports an object with fetch(). Supporting both keeps this test useful for
  // the product runtime and the separately packaged private preview.
  if (typeof server === "function") return server(request);
  return server.fetch(
    request,
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Scooptr acquisition experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /Scooptr — find the Reddit threads where your next customers already are/i);
  assert.match(html, /Find the Reddit conversations where people are[\s\S]{0,200}already looking[\s\S]{0,100}for what you sell/);
  assert.match(html, /Run free scan/);
  assert.match(html, /Public same-domain pages only/);
  assert.match(html, /\$0/);
  assert.match(html, /\$30/);
  assert.doesNotMatch(html, /94% fit|3 related conversations/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/);
});

test("returns a structured authorization error without crashing the production bundle", async () => {
  const response = await render("/api/access");
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: {
      code: "unauthorized",
      message: "Your workspace session is missing or expired.",
    },
  });
});

test("keeps claims, access, and provider boundaries explicit", async () => {
  const [
    fixture,
    mockProvider,
    crawler,
    stripe,
    repository,
    presenter,
    packageJson,
    dashboard,
    fromScan,
  ] = await Promise.all([
    readFile(new URL("../components/demand-intelligence/demo-data.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/providers/mock-reddit.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/security/website-crawler.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/stripe.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../components/demand-intelligence/from-scan.ts", import.meta.url), "utf8"),
  ]);

  assert.match(fixture, /every Reddit conversation shown here are fictional demo fixtures/i);
  assert.match(mockProvider, /intentionally has no[\s\S]*Reddit permalink/i);
  assert.doesNotMatch(mockProvider, /reddit\.com\/r\//i);
  assert.match(crawler, /The website redirected outside the submitted domain/);
  assert.match(crawler, /public internet addresses/);
  assert.match(stripe, /verifyStripeWebhook/);
  assert.match(stripe, /commitStripeEvent/);
  assert.match(repository, /stripeEvents/);
  assert.match(repository, /onConflictDoNothing/);
  assert.match(presenter, /additionalLockedCounts/);
  assert.match(packageJson, /"postgres"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(dashboard, /opportunity\.disclosureRequired/);
  assert.match(dashboard, /Keeps the product out unless it helps/);
  assert.doesNotMatch(dashboard, /verifiedClaims\.length.*claims source-checked/);
  assert.match(fromScan, /disclosureRequired: opportunity\.disclosureRequired/);
  assert.match(presenter, /mentionProduct: opportunity\.mentionProduct === true/);
  assert.match(presenter, /disclosureRequired: opportunity\.disclosureRequired === true/);
  assert.match(
    fromScan,
    /matchReasons: \[opportunity\.customerProblem, opportunity\.whyItMatters\]/,
  );
});

test("dashboard evidence labels preserve website and Reddit provenance", async () => {
  const mapper = await readFile(
    new URL("../components/demand-intelligence/from-scan.ts", import.meta.url),
    "utf8",
  );
  assert.match(mapper, /source\.kind === "website"/);
  assert.match(mapper, /Verified business website evidence/);
  assert.match(mapper, /Public Reddit evidence via Apify test source/);
});
