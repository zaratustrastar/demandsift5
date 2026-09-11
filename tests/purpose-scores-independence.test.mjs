import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * A relevant conversation can be useful in several ways at once, so it carries
 * several independent scores rather than one blended "opportunity" number.
 *
 * The old single score mixed replyability into lead value at 20%, so a thread
 * that was merely easy to answer ranked as a strong lead, and a genuine buyer
 * in a promotion-hostile community was indistinguishable from one in a
 * welcoming one. These tests pin the separation.
 */

const dataUrl = (code) =>
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

const typesStub = dataUrl("export {};");
// The scoring functions do not touch these helpers, but the module imports
// them at load time, so they need resolvable stand-ins.
const rankingStub = dataUrl(`
  export const contentFingerprint = (value) => String(value).length.toString(16);
  export const normalizeSearchText = (value) =>
    String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
`);

const source = (
  await readFile(new URL("../lib/intelligence/reddit-pipeline.ts", import.meta.url), "utf8")
)
  .replaceAll('"@/lib/domain/types"', JSON.stringify(typesStub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(typesStub))
  .replaceAll('"./opportunity-ranking"', JSON.stringify(rankingStub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(rankingStub));

const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "reddit-pipeline.ts",
}).outputText;

const pipeline = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const base = {
  externalId: "t3_x",
  leadStatus: "potential_customer",
  demandSignals: [],
  intelligenceTags: [],
  productFit: "medium",
  painSeverity: "medium",
  intent: "problem_aware",
  timing: "current",
  evidenceQuality: "medium",
  replyability: "medium",
  communityRisk: "low",
  whyItMatters: "",
  shouldReply: false,
  autoReplyAllowed: false,
  requiresHumanReview: true,
  mentionProduct: false,
  disclosureRequired: true,
};

const q = (overrides) => ({ ...base, ...overrides });

test("replyability no longer inflates lead score", () => {
  const poorReplyTarget = q({ replyability: "low" });
  const easyReplyTarget = q({ replyability: "high" });
  assert.equal(
    pipeline.leadScore(poorReplyTarget),
    pipeline.leadScore(easyReplyTarget),
    "lead value must not change just because a thread is easy to answer",
  );
  assert.ok(
    pipeline.replyScore(easyReplyTarget) > pipeline.replyScore(poorReplyTarget),
    "reply value must respond to replyability",
  );
});

test("a strong lead in a hostile community scores low to reply to", () => {
  const strongLead = q({
    productFit: "high",
    intent: "actively_looking",
    painSeverity: "high",
    evidenceQuality: "high",
    replyability: "high",
  });
  const welcoming = pipeline.replyScore({ ...strongLead, communityRisk: "low" });
  const hostile = pipeline.replyScore({ ...strongLead, communityRisk: "high" });

  assert.ok(hostile < welcoming, "community risk must reduce reply value");
  assert.equal(
    pipeline.leadScore({ ...strongLead, communityRisk: "high" }),
    pipeline.leadScore({ ...strongLead, communityRisk: "low" }),
    "community risk is about replying, not about whether someone is a buyer",
  );
});

test("an excellent reply target need not be a strong lead", () => {
  const discussion = q({
    leadStatus: "not_a_lead",
    intent: "researching",
    timing: "hypothetical",
    productFit: "medium",
    replyability: "high",
    evidenceQuality: "high",
    painSeverity: "high",
  });
  assert.ok(
    pipeline.replyScore(discussion) > pipeline.leadScore(discussion),
    "a useful discussion should out-score its own weak lead value",
  );
});

test("competitor value requires a named competitor in the source", () => {
  const unnamed = q({ demandSignals: ["switching"], intelligenceTags: ["competitor_intelligence"] });
  assert.equal(
    pipeline.competitorScore(unnamed),
    0,
    "an unnamed grumble must not become a competitor signal",
  );

  const named = q({
    competitorMentioned: "Google Family Link",
    demandSignals: ["switching"],
    intelligenceTags: ["competitor_intelligence"],
    evidenceQuality: "high",
  });
  assert.ok(pipeline.competitorScore(named) > 0);
});

test("research value is available to non-buyers", () => {
  const researchOnly = q({
    leadStatus: "not_a_lead",
    intent: "researching",
    intelligenceTags: ["problem_signal", "product_feedback", "market_insight"],
    evidenceQuality: "high",
    painSeverity: "high",
  });
  assert.ok(
    pipeline.researchScore(researchOnly) > 0,
    "insights must be able to draw on conversations that are not leads",
  );
  assert.ok(pipeline.researchScore(researchOnly) > pipeline.leadScore(researchOnly));
});

test("every score stays within 0-100", () => {
  const extremes = [
    q({}),
    q({
      productFit: "high",
      intent: "actively_looking",
      painSeverity: "high",
      timing: "current",
      evidenceQuality: "high",
      replyability: "high",
      communityRisk: "low",
      competitorMentioned: "Rival",
      demandSignals: ["switching", "pain"],
      intelligenceTags: [
        "problem_signal",
        "product_feedback",
        "market_insight",
        "workaround",
        "objection",
        "competitor_intelligence",
      ],
    }),
    q({
      productFit: "unknown",
      intent: "unknown",
      painSeverity: "unknown",
      timing: "unknown",
      evidenceQuality: "unknown",
      replyability: "unknown",
      communityRisk: "unknown",
    }),
  ];
  for (const qualification of extremes) {
    for (const [name, score] of [
      ["lead", pipeline.leadScore(qualification)],
      ["reply", pipeline.replyScore(qualification)],
      ["competitor", pipeline.competitorScore(qualification)],
      ["research", pipeline.researchScore(qualification)],
    ]) {
      assert.ok(
        Number.isInteger(score) && score >= 0 && score <= 100,
        `${name} score out of range: ${score}`,
      );
    }
  }
});

test("the deprecated single score maps to lead value for stored reports", () => {
  const sample = q({ productFit: "high", intent: "actively_looking" });
  assert.equal(pipeline.opportunityRankScore(sample), pipeline.leadScore(sample));
});
