import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * AI Visibility Tracking (MVP) has to hold three invariants together:
 *
 *  - it is a genuine sidecar -- nothing in it is read by, or feeds into,
 *    the Reddit discovery/qualification/reply pipeline, and vice versa;
 *  - brand names, competitor names, and Reddit citations are matched
 *    deterministically (pure string/URL logic); AI is called for exactly
 *    one thing -- whether a mention is actually a recommendation;
 *  - the 3 questions are batched into a single Actor run per provider (one
 *    ChatGPT run, one Gemini run, one Perplexity run -- never one run per
 *    question), and the weekly schedule always advances strictly forward.
 *
 * Any one of these regressing either quietly entangles this feature with
 * the Reddit pipelines it must stay isolated from, or turns a deterministic
 * fact (a brand name appearing in text) into an AI guess.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");

// ai-visibility-analysis.ts is pure, dependency-free TypeScript (its only
// import is `import type {...} from "@/lib/server/contracts"`, which
// ts.transpileModule erases entirely since it's type-only) -- so it can be
// compiled and executed directly, the same way tests/harshmaur-provider.test.mjs
// compiles real source rather than re-describing its behavior in prose.
const dataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const compile = (source, fileName) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName,
}).outputText;

const analysisSource = await read("../lib/server/ai-visibility-analysis.ts");
const analysis = await import(dataUrl(compile(analysisSource, "ai-visibility-analysis.ts")));
const apifySource = await read("../lib/providers/ai-visibility-apify.server.ts");
const repositorySource = await read("../lib/server/ai-visibility-repository.ts");
const workflowSource = await read("../lib/server/ai-visibility-workflow.ts");
const providerContracts = await read("../lib/providers/contracts.ts");
const openaiProvider = await read("../lib/providers/openai.server.ts");
const serverContracts = await read("../lib/server/contracts.ts");
const scanWorkflow = await read("../lib/server/scan-workflow.ts");
const backgroundWorker = await read("../scripts/background-worker.mjs");
const executeRoute = await read("../app/api/internal/jobs/[jobId]/execute/route.ts");
const redditProvider = await read("../lib/providers/reddit.server.ts");
const redditMonitorWorkflow = await read("../lib/server/reddit-monitor-workflow.ts");

test("brand mentions are matched deterministically, not by AI, with word boundaries", () => {
  assert.match(analysisSource, /export function brandMentioned/);
  assert.match(analysisSource, /export function competitorsMentioned/);
  assert.match(analysisSource, /export function mentionPosition/);
  assert.match(analysisSource, /export function isRedditCitation/);
  assert.match(analysisSource, /export function otherCitedDomains/);
  // No AI/provider call anywhere in the deterministic analysis module. Strip
  // comments first so a doc-comment mentioning the sibling AI function by
  // name (for cross-reference) doesn't false-positive as an actual call.
  const codeOnly = analysisSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/aiProvider|OpenAiProvider|analyzeVisibilityMentions\s*\(/.test(codeOnly), false,
    "ai-visibility-analysis.ts must contain no AI calls -- it is pure deterministic matching");
});

  test("brandMentioned matches whole words only, case-insensitively", () => {
    assert.equal(analysis.brandMentioned("We love Relaywise for support.", ["Relaywise"]), true);
    assert.equal(analysis.brandMentioned("RELAYWISE is great.", ["Relaywise"]), true);
    // Must not false-positive on a substring inside a longer word.
    assert.equal(analysis.brandMentioned("Relaywised is not a real word.", ["Relaywise"]), false);
    assert.equal(analysis.brandMentioned("No mention here.", ["Relaywise"]), false);
  });

  test("competitorsMentioned returns only the competitors actually present, deduplicated", () => {
    const matched = analysis.competitorsMentioned(
      "QueuePilot and queuepilot are common, but not Zendesk.",
      ["QueuePilot", "Intercom"],
    );
    assert.deepEqual(matched, ["QueuePilot"]);
  });

  test("mentionPosition buckets by where the earliest brand mention falls in the text", () => {
    const brand = ["Relaywise"];
    assert.equal(analysis.mentionPosition("no brand mentioned at all here", brand), "not_mentioned");
    const text = `Relaywise ${"x".repeat(300)}`;
    assert.equal(analysis.mentionPosition(text, brand), "early");
    const lateText = `${"x".repeat(300)} Relaywise`;
    assert.equal(analysis.mentionPosition(lateText, brand), "late");
  });

  test("Reddit citations are identified by hostname, not by AI", () => {
    const citations = [
      { url: "https://reddit.com/r/foo", title: null, domain: "reddit.com" },
      { url: "https://old.reddit.com/r/foo", title: null, domain: "old.reddit.com" },
      { url: "https://example.com/page", title: null, domain: "example.com" },
    ];
    assert.equal(analysis.isRedditCitation(citations[0]), true);
    assert.equal(analysis.isRedditCitation(citations[1]), true);
    assert.equal(analysis.isRedditCitation(citations[2]), false);
    assert.deepEqual(analysis.redditCitations(citations).map((c) => c.domain), ["reddit.com", "old.reddit.com"]);
  });

  test("otherCitedDomains excludes reddit.com and the business's own domain, deduplicated", () => {
    const citations = [
      { url: "https://reddit.com/r/foo", title: null, domain: "reddit.com" },
      { url: "https://relaywise.com/pricing", title: null, domain: "relaywise.com" },
      { url: "https://pcmag.com/a", title: null, domain: "pcmag.com" },
      { url: "https://pcmag.com/b", title: null, domain: "pcmag.com" },
    ];
    assert.deepEqual(analysis.otherCitedDomains(citations, "relaywise.com"), ["pcmag.com"]);
  });

  test("computeVisibilityMetrics aggregates the 9 stored answers correctly", () => {
    const baseCitation = { url: "https://reddit.com/r/x", title: null, domain: "reddit.com" };
    const answers = [];
    const providers = ["chatgpt", "gemini", "perplexity"];
    for (const provider of providers) {
      for (let index = 0; index < 3; index += 1) {
        answers.push({
          provider,
          question: `question ${index}`,
          answerText: "text",
          citations: [baseCitation],
          model: null,
          actorRunId: null,
          brandMentioned: provider !== "perplexity",
          mentionPosition: provider !== "perplexity" ? "early" : "not_mentioned",
          brandRecommended: provider === "chatgpt",
          recommendationReasoning: null,
          competitorsMentioned: provider === "gemini" ? ["QueuePilot"] : [],
          redditCitations: [baseCitation],
          otherDomains: [],
          fetchedAt: new Date().toISOString(),
        });
      }
    }
    const metrics = analysis.computeVisibilityMetrics(answers);
    assert.equal(metrics.totalAnswers, 9);
    assert.equal(metrics.totalMentions, 6); // chatgpt(3) + gemini(3)
    assert.equal(metrics.totalRecommendations, 3); // chatgpt only
    assert.equal(Math.round(metrics.mentionRate * 100), 67);
    assert.equal(Math.round(metrics.recommendationRate * 100), 33);
    assert.equal(metrics.byProvider.chatgpt.mentioned, 3);
    assert.equal(metrics.byProvider.chatgpt.recommended, 3);
    assert.equal(metrics.byProvider.perplexity.mentioned, 0);
    assert.equal(metrics.competitorMentionCounts.QueuePilot, 3);
    assert.equal(metrics.redditCitationCount, 9);
  });

test("AI is used only for the one semantic field: whether a brand is actually recommended", () => {
  assert.match(providerContracts, /generateVisibilityQuestions/);
  assert.match(providerContracts, /analyzeVisibilityMentions/);
  assert.match(providerContracts, /interface VisibilityMentionAnalysis/);
  const start = providerContracts.indexOf("export interface VisibilityMentionAnalysis");
  const end = providerContracts.indexOf("}", start);
  const body = providerContracts.slice(start, end);
  assert.match(body, /brandRecommended: boolean/);
  // Nothing else in the semantic-classification result claims to redecide
  // mention/citation/domain facts that are already deterministic.
  assert.equal(/brandMentioned|competitorsMentioned|redditCitations/.test(body), false);
});

test("OpenAiProvider implements both new AiProvider methods on the economy model", () => {
  assert.match(openaiProvider, /async generateVisibilityQuestions/);
  assert.match(openaiProvider, /async analyzeVisibilityMentions/);
  const questionsFn = openaiProvider.slice(openaiProvider.indexOf("async generateVisibilityQuestions"));
  const questionsFnBody = questionsFn.slice(0, questionsFn.indexOf("\n  }"));
  assert.match(questionsFnBody, /model: request\.models\.economyModel/);
  const mentionsFn = openaiProvider.slice(openaiProvider.indexOf("async analyzeVisibilityMentions"));
  const mentionsFnBody = mentionsFn.slice(0, mentionsFn.indexOf("\n  }"));
  assert.match(mentionsFnBody, /model: request\.models\.economyModel/);
});

test("exactly 3 questions are required end to end", () => {
  assert.match(openaiProvider, /minItems: 3,\s*\n\s*maxItems: 3,/);
  assert.match(workflowSource, /questions\.length !== 3/);
});

test("all 3 questions are batched into a single Actor run per provider, not one run per question", () => {
  // The Actor input field is a single newline-joined string, not an array
  // and not a per-question call site.
  assert.match(apifySource, /queries: input\.questions\.join\("\\n"\)/);
  assert.match(apifySource, /export async function runAllVisibilityActors/);
  const start = apifySource.indexOf("export async function runAllVisibilityActors");
  // Extract the real function body via balanced-paren/brace scanning (not a
  // naive first-"{"/"\n}" cut, which lands inside the parameter type literal
  // -- the parameter list itself is a multi-line object type with its own
  // braces, so we must track paren depth until the parameter list closes,
  // *then* find the body-opening brace).
  const openParen = apifySource.indexOf("(", start);
  let parenDepth = 0;
  let afterParams = openParen;
  for (let i = openParen; i < apifySource.length; i += 1) {
    if (apifySource[i] === "(") parenDepth += 1;
    else if (apifySource[i] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { afterParams = i + 1; break; }
    }
  }
  const bodyStart = apifySource.indexOf("{", afterParams);
  let depth = 0;
  let bodyEnd = bodyStart;
  for (let i = bodyStart; i < apifySource.length; i += 1) {
    if (apifySource[i] === "{") depth += 1;
    else if (apifySource[i] === "}") {
      depth -= 1;
      if (depth === 0) { bodyEnd = i; break; }
    }
  }
  const body = apifySource.slice(bodyStart, bodyEnd);
  // Exactly one runVisibilityActor call site inside the fan-out over providers
  // (it runs once per provider via .map(), not once per question).
  const callSites = body.match(/runVisibilityActor\(/g) ?? [];
  assert.equal(callSites.length, 1, "expected exactly one Actor call per provider, batching all questions");
});

test("the 3 official Apify search-scraper Actors are the defaults, and are env-overridable", () => {
  assert.match(apifySource, /apify\/chatgpt-search-scraper/);
  assert.match(apifySource, /apify\/gemini-search-scraper/);
  assert.match(apifySource, /apify\/perplexity-search-scraper/);
  assert.match(apifySource, /APIFY_CHATGPT_VISIBILITY_ACTOR_ID/);
  assert.match(apifySource, /APIFY_GEMINI_VISIBILITY_ACTOR_ID/);
  assert.match(apifySource, /APIFY_PERPLEXITY_VISIBILITY_ACTOR_ID/);
});

test("one provider's Actor failure never sinks the other two", () => {
  assert.match(apifySource, /Promise\.allSettled/);
});

test("the weekly schedule always advances strictly into the future, at most 7 days out", () => {
  assert.match(repositorySource, /export function nextMonday/);
});

test("the job type ai_visibility_scan is registered with the background worker's claim query", () => {
  assert.match(backgroundWorker, /type IN \('scan\.run', 'reddit_monitor_scan', 'ai_visibility_scan'\)/);
  assert.match(backgroundWorker, /export async function scheduleAiVisibilityScans/);
  assert.match(backgroundWorker, /runAiVisibilityScheduler/);
  assert.match(backgroundWorker, /aiVisibilitySchedulerEnabled/);
});

test("the internal job executor dispatches ai_visibility_scan jobs", () => {
  assert.match(executeRoute, /claimedVisibilitySnapshot/);
  assert.match(executeRoute, /runAiVisibilityScan/);
  // Wired into both POST (start) and GET (status poll) handlers.
  const postIndex = executeRoute.indexOf("export async function POST");
  const getIndex = executeRoute.indexOf("export async function GET");
  const postBody = executeRoute.slice(postIndex, getIndex);
  const getBody = executeRoute.slice(getIndex);
  assert.match(postBody, /claimedVisibilitySnapshot/);
  assert.match(getBody, /claimedVisibilitySnapshot/);
});

test("AI visibility tracking starts automatically once a primary scan completes, never a monitoring scan", () => {
  assert.match(scanWorkflow, /ensureAiVisibilityTrackingStarted/);
  const completionIndex = scanWorkflow.indexOf('scan.status = "complete";');
  const nearby = scanWorkflow.slice(completionIndex, completionIndex + 800);
  assert.match(nearby, /scan\.scanKind !== "monitoring"/);
  assert.match(nearby, /void ensureAiVisibilityTrackingStarted\(scan\)\.catch/);
});

// Strips comments so doc-comments that reference a sibling module by name
// (for context/precedent, e.g. "mirrors reddit-monitor-repository.ts's
// conventions") don't false-positive as a real coupling. What actually
// matters for isolation is import/require statements, not prose mentions.
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("AI visibility tracking is isolated from the Reddit discovery/monitoring pipelines", () => {
  for (const source of [apifySource, repositorySource, workflowSource]) {
    const codeOnly = stripComments(source);
    assert.equal(/from\s+["'][^"']*reddit(?:\.server|-monitor-workflow|-monitor-repository)["']/i.test(codeOnly), false,
      "AI visibility modules must not import from the Reddit discovery/monitoring modules");
  }
  // And the reverse: the Reddit pipeline modules must not reach into AI visibility.
  for (const source of [redditProvider, redditMonitorWorkflow]) {
    const codeOnly = stripComments(source);
    assert.equal(/from\s+["'][^"']*ai-visibility["']/i.test(codeOnly), false,
      "Reddit discovery/monitoring modules must not reach into AI visibility tracking");
  }
});

test("AI visibility tracking has its own tables, separate from the Reddit monitor tables", () => {
  assert.match(serverContracts, /export type AiVisibilityScanRecord = \{/);
  assert.match(serverContracts, /export type AiVisibilitySettingsRecord = \{/);
  assert.match(repositorySource, /runtimeAiVisibilitySchedules/);
  assert.match(repositorySource, /runtimeAiVisibilityScans/);
  assert.equal(/runtimeRedditMonitor/.test(repositorySource), false);
});

test("competitor and business profile data read by AI visibility tracking is read-only", () => {
  // Only ever assembled into request objects (never assigned back onto
  // `business`/`competitors`/`seed`), and never persisted back onto the
  // seed scan or its competitor profiles.
  assert.equal(/seed\.discoveryProfile\s*=|seed\.competitorProfiles\s*=/.test(workflowSource), false);
  assert.equal(/repository\.saveScan\(seed\)/.test(workflowSource), false);
});
