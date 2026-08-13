import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const route = fs.readFileSync("app/acceptance-diagnostics/route.ts", "utf8");

test("acceptance diagnostics expose aggregate funnel counts only", () => {
  assert.match(route, /requireWorkspace\(request\)/);
  assert.match(route, /queryCountsByLane/);
  assert.match(route, /diagnostics: scan\.result\.diagnostics/);
  assert.match(route, /potentialCustomers: scan\.result\.potentialCustomers\.total/);
  assert.doesNotMatch(route, /processedRedditState:/);
  assert.doesNotMatch(route, /canonicalPermalink/);
  assert.doesNotMatch(route, /matchedQueries/);
  assert.doesNotMatch(route, /state\.excerpt/);
  assert.doesNotMatch(route, /state\.author/);
});
