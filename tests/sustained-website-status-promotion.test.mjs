import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Real production case: amazon.com answers every request with HTTP 503
 * rather than one of the always-permanent codes (401/403/404/410/451),
 * so PermanentWebsiteFetchError never fired for it. runFullWebsiteUnderstanding
 * (lib/server/scan-workflow.ts) retried the whole crawl+analysis pipeline
 * across its own 2 attempts, and the job queue retried the whole job up
 * to 5 more times on top of that -- the same worker-slot-blocking shape
 * as the original canva.com/403 incident (scan-queue-blocking-incident.test.mjs),
 * just via a status that incident's fix didn't cover.
 *
 * The fix stays deliberately narrow: a single 503 (or any other non-
 * auto-permanent status) still gets its normal retry, since a real
 * transient hiccup is common and shouldn't be punished. It's only the
 * *same* status recurring on the very next attempt that gets promoted --
 * a genuine transient condition rarely reproduces identically twice in
 * immediate succession, whereas a sustained bot-block answers the same
 * way every time.
 *
 * These are source-pattern tests, matching this codebase's own
 * established technique for pinning invariants inside
 * runFullWebsiteUnderstanding specifically (see e.g.
 * competitor-url-resolution.test.mjs's "run concurrently" and
 * "never fails the retry loop" tests, which use the identical
 * extract-the-function-body-then-assert-on-it approach) -- a full
 * behavioral harness run is covered instead at the crawler level in
 * scan-queue-blocking-incident.test.mjs, where WebsiteFetchStatusError's
 * actual throwing behavior is exercised directly against a real
 * crawlWebsite() call.
 */

const scanWorkflow = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");
const crawler = await readFile(new URL("../lib/security/website-crawler.ts", import.meta.url), "utf8");

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start > -1, `expected to find ${signature}`);
  return source.slice(start, source.indexOf("\n}\n", start));
}

test("WebsiteFetchStatusError exists, is distinct from PermanentWebsiteFetchError, and carries a numeric status", () => {
  assert.match(crawler, /export class WebsiteFetchStatusError extends Error \{/);
  assert.match(crawler, /class WebsiteFetchStatusError[\s\S]{0,300}status: number/);
});

test("a non-auto-permanent HTTP status is thrown as a typed WebsiteFetchStatusError, not a bare Error, both per-page and in the final aggregation throw", () => {
  assert.match(crawler, /throw new WebsiteFetchStatusError\(response\.status\)/);
  assert.match(crawler, /throw new WebsiteFetchStatusError\(firstFailure\.status, `Website analysis could not read the site: \$\{detail\}`\)/);
});

test("runFullWebsiteUnderstanding tracks the previous attempt's fetch status across its retry loop", () => {
  const fnBody = functionBody(scanWorkflow, "async function runFullWebsiteUnderstanding");
  assert.match(fnBody, /let lastFetchStatus: number \| undefined;/);
  assert.match(fnBody, /lastFetchStatus = rawError instanceof WebsiteFetchStatusError \? rawError\.status : undefined;/);
});

test("the same status recurring on a consecutive attempt is promoted to PermanentWebsiteFetchError -- a different or first-time status is not", () => {
  const fnBody = functionBody(scanWorkflow, "async function runFullWebsiteUnderstanding");
  assert.match(
    fnBody,
    /const error =\s*\n\s*rawError instanceof WebsiteFetchStatusError && rawError\.status === lastFetchStatus\s*\n\s*\? new PermanentWebsiteFetchError\(rawError\.status\)\s*\n\s*: rawError;/,
  );
  // The promoted error, not the raw one, is what decides whether the loop
  // breaks immediately -- otherwise the promotion would be computed but
  // never actually change the loop's behavior.
  assert.match(fnBody, /if \(error instanceof PermanentWebsiteFetchError\) break;/);
});

test("scan-workflow.ts imports WebsiteFetchStatusError from the crawler module (the promotion logic cannot work against a stale/missing import)", () => {
  assert.match(
    scanWorkflow,
    /import \{ crawlWebsite, UnsafeWebsiteUrlError, PermanentWebsiteFetchError, WebsiteFetchStatusError \} from "@\/lib\/security\/website-crawler";/,
  );
});
