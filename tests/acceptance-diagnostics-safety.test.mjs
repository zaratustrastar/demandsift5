import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync("app/acceptance-diagnostics/route.ts", "utf8");

test("acceptance diagnostics expose only aggregate funnel and sanitized presentation state", () => {
  assert.match(route, /requireWorkspace\(request\)/);
  assert.match(route, /queryCountsByLane/);
  assert.match(route, /diagnostics: scan\.result\.diagnostics/);
  assert.match(route, /potentialCustomers: scan\.result\.potentialCustomers\?\.total/);
  assert.match(route, /sanitizedPresentationError/);
  assert.match(route, /presentation,/);
  assert.doesNotMatch(route, /error\.stack/);
  assert.doesNotMatch(route, /processedRedditState:/);
  assert.doesNotMatch(route, /canonicalPermalink/);
  assert.doesNotMatch(route, /matchedQueries/);
  assert.doesNotMatch(route, /state\.excerpt/);
  assert.doesNotMatch(route, /state\.author/);
});
