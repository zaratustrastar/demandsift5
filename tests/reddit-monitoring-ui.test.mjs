import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const experience = fs.readFileSync("components/ThreadlineExperience.tsx", "utf8");

test("Reddit OAuth and daily monitoring settings load independently", () => {
  assert.match(experience, /async function loadRedditConnection\(\)/u);
  assert.match(experience, /async function loadRedditMonitoring\(\)/u);
  assert.doesNotMatch(
    experience,
    /Promise\.all\(\[\s*fetch\("\/api\/reddit\/status"[\s\S]*fetch\("\/api\/monitoring\/settings"/u,
    "one failed endpoint must not suppress both independent controls",
  );
  assert.match(experience, /void loadRedditConnection\(\);\s*void loadRedditMonitoring\(\);/u);
});


test("daily monitoring UI communicates and enforces the launch bounds", () => {
  assert.match(experience, /REDDIT_MONITOR_LIMITS\.maxWatchTerms/u);
  assert.match(experience, /REDDIT_MONITOR_LIMITS\.maxResultsPerRun/u);
  assert.match(experience, /Up to \{REDDIT_MONITOR_LIMITS\.maxWatchTerms\} terms/u);
});
