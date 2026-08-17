import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const presenter = await readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8");
const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");
const experience = await readFile(new URL("../components/ThreadlineExperience.tsx", import.meta.url), "utf8");
const workflow = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");

test("MVP report exposes every triaged candidate with its exact provider permalink and decisions", () => {
  assert.match(presenter, /scanEvidence:/);
  assert.match(presenter, /result\.processedRedditState\.map/);
  assert.match(presenter, /permalink: state\.canonicalPermalink/);
  assert.match(presenter, /triage: state\.triage/);
  assert.match(presenter, /deepQualification: state\.deepQualification/);
  assert.match(dashboard, /Show full scan trace/);
  // Collapsed by default behind a <details> disclosure so it does not read as
  // an unfiltered raw dump on the default report view (users asked for this).
  assert.match(dashboard, /<details className={styles.dashboardSection}>/);
  assert.match(dashboard, /Open exact Reddit message/);
});

test("late Reddit context shortfall does not masquerade as website-analysis failure", () => {
  assert.equal(experience.includes("We couldn’t analyze that website"), false);
  assert.match(experience, /The scan stopped before every check finished/);
  assert.match(workflow, /The scan will continue and will not present a definitive zero/);
  assert.match(workflow, /limited-coverage result rather than a definitive zero/);
});
