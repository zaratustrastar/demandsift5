import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Concept gating regression suite.
 *
 * Discovery used to admit a candidate when any two seed tokens appeared
 * ("required = Math.min(seedTokens.length, 2)"). For a market defined by a
 * short qualifier that is fatal: "android tv parental control app" overlaps an
 * Android *phone* thread on "android" and "app", so the adjacent market was
 * retrieved, the AI correctly rejected it, and the scan reported zero.
 *
 * The gate now requires market-concept evidence AND problem/use-case evidence,
 * each satisfiable by synonyms, with buying intent as an optional booster.
 */

const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;

const compile = (source, fileName) =>
  ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  }).outputText;

async function loadRedditProvider() {
  const typesStub = moduleUrl("export {};");
  const rankingSource = await readFile(
    new URL("../lib/intelligence/opportunity-ranking.ts", import.meta.url),
    "utf8",
  );
  const ranking = moduleUrl(
    compile(
      rankingSource.replaceAll('"@/lib/domain/types"', JSON.stringify(typesStub)),
      "opportunity-ranking.ts",
    ),
  );
  let source = await readFile(
    new URL("../lib/providers/reddit.server.ts", import.meta.url),
    "utf8",
  );
  const replacements = {
    "@/lib/providers/mock-reddit": moduleUrl(
      "export class MockRedditProvider { name='mock-reddit'; sourceMode='mock'; async search(){return {conversations:[],sourceMode:'mock'};} }",
    ),
    "@/lib/intelligence/opportunity-ranking": ranking,
    "@/lib/server/runtime-env": moduleUrl(
      "export function isProductionRuntime(env=process.env){return (env.APP_RUNTIME_ENV||env.NODE_ENV)==='production';}",
    ),
    "@/lib/providers/contracts": typesStub,
    "@/lib/domain/types": typesStub,
  };
  for (const [specifier, replacement] of Object.entries(replacements)) {
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  }
  return import(moduleUrl(compile(source, "reddit.server.ts")));
}

const reddit = await loadRedditProvider();

const tvcp = {
  queries: {
    productTerms: ["TVCP", "Android TV parental control app"],
    brandTerms: ["TVCP"],
    productCategories: ["Android TV parental control app"],
    customerProblems: [
      "kids watching TV too long",
      "no parental controls on Android TV",
      "kids watching YouTube on the TV unsupervised",
    ],
    jobsToBeDone: ["limit screen time on the television"],
    buyerIntent: ["recommendations", "looking for", "alternative"],
    competitors: ["Google Family Link"],
    excludedTerms: [],
  },
  limit: 20,
};

const tvcpPlan = reddit.buildApifyRedditSearchPlan(tvcp);
const matches = (title, body, plan = tvcpPlan) =>
  reddit.searchPlanMatches(title, body, plan).length > 0;

test("market and problem concepts are derived as independent groups", () => {
  const entry = tvcpPlan.find((item) => item.concepts);
  assert.ok(entry, "no plan entry carried concepts");

  const { market, problem } = entry.concepts;
  for (const variant of ["tv", "television", "smart tv", "google tv", "android tv", "chromecast"]) {
    assert.ok(market.includes(variant), `market concept missing "${variant}"`);
  }
  for (const variant of ["parental control", "screen time", "kids watching"]) {
    assert.ok(problem.includes(variant), `problem concept missing "${variant}"`);
  }
  // Independence is the point: if a problem term counted as market evidence, a
  // phone thread mentioning parental controls would satisfy the market rule.
  const overlap = market.filter((variant) => problem.includes(variant));
  assert.deepEqual(overlap, [], `market and problem concepts overlap: ${overlap.join(", ")}`);
});

test("on-market buyers and discussions are retained", () => {
  assert.ok(
    matches(
      "Looking for a parental control app for Android TV",
      "My kids watch YouTube on the living room TV for hours. Need to set screen time limits on our Google TV. Any recommendations?",
    ),
    "explicit on-market buyer was dropped",
  );
  assert.ok(
    matches(
      "Kids watching TV too long - how do you handle it?",
      "We have no parental controls on our Android TV. Curious what other parents do about screen time.",
    ),
    "on-market non-buyer discussion was dropped",
  );
});

test("synonyms satisfy market and problem evidence", () => {
  assert.ok(
    matches(
      "How do I limit screen time on the television?",
      "The children watch the television far too long every evening and I cannot set any time limits.",
    ),
    '"television" + "screen time" should match without the literal category wording',
  );
  assert.ok(
    matches(
      "Any way to block YouTube on a Chromecast?",
      "My kids watch it constantly and I want restricted mode on the big screen.",
    ),
    '"Chromecast" + "block youtube" should match',
  );
});

test("the adjacent phone market is rejected", () => {
  assert.equal(
    matches(
      "Family Link screen time not working on my kid's phone",
      "Google Family Link keeps failing to apply app limits on my daughter's Android phone. Frustrated, looking for an alternative.",
    ),
    false,
    "phone thread passed: problem evidence without market evidence",
  );
  assert.equal(
    matches(
      "Best android launcher in 2026?",
      "Looking for recommendations on a clean launcher for my new phone.",
    ),
    false,
    "generic android thread passed on shared tokens alone",
  );
});

test("market evidence alone is not enough without a problem", () => {
  assert.equal(
    matches(
      "What are you watching on TV this week?",
      "Just finished a great series on my smart tv, looking for recommendations for the next one.",
    ),
    false,
    "on-market chatter with no use-case evidence should not qualify",
  );
});

test("concept gating generalises to other short-qualifier markets", () => {
  const cases = [
    {
      category: "HR onboarding software",
      problems: ["HR paperwork takes weeks for new hires"],
      brand: "OnboardCo",
      keep: ["Human resources onboarding is a mess", "Our HR paperwork for new hires takes weeks. Any recommendations?"],
      drop: ["Best CRM for a small sales team?", "Looking for pipeline software, our deal tracking is a mess."],
    },
    {
      category: "AI code review tool",
      problems: ["AI misses obvious bugs in pull requests"],
      brand: "ReviewBot",
      keep: ["Does any LLM catch real bugs in PRs?", "Our AI reviewer misses obvious bugs in pull requests. Looking for alternatives."],
      drop: ["Best standing desk for a home office?", "Looking for recommendations under $500."],
    },
  ];

  for (const scenario of cases) {
    const plan = reddit.buildApifyRedditSearchPlan({
      queries: {
        productTerms: [scenario.brand, scenario.category],
        brandTerms: [scenario.brand],
        productCategories: [scenario.category],
        customerProblems: scenario.problems,
        buyerIntent: ["recommendations", "looking for"],
        competitors: [],
        excludedTerms: [],
      },
      limit: 20,
    });
    assert.ok(
      matches(scenario.keep[0], scenario.keep[1], plan),
      `${scenario.category}: on-market thread was dropped`,
    );
    assert.equal(
      matches(scenario.drop[0], scenario.drop[1], plan),
      false,
      `${scenario.category}: off-market thread was kept`,
    );
  }
});

test("profiles without a distinguishing market keep the token behaviour", () => {
  // "project management software" has no qualifier that buyers reliably type,
  // so demanding market evidence in the body would discard genuine demand.
  const plan = reddit.buildApifyRedditSearchPlan({
    queries: {
      productTerms: ["Basecamp", "project management and team collaboration software"],
      brandTerms: ["Basecamp"],
      productCategories: ["project management and team collaboration software"],
      customerProblems: ["work scattered across apps", "tasks lost in shuffle"],
      buyerIntent: ["recommendations"],
      competitors: ["Slack"],
      excludedTerms: [],
    },
    limit: 25,
  });
  assert.ok(
    plan.every((entry) => entry.concepts === undefined),
    "concept gating should not engage without a distinguishing market concept",
  );
  assert.ok(
    matches(
      "Our work is scattered across apps",
      "Tasks and client updates are scattered across too many apps and deadlines get missed.",
      plan,
    ),
    "genuine project-management demand was dropped",
  );
});
