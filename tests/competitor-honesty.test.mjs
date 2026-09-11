import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const signalSource = await readFile(
  new URL("../lib/intelligence/competitor-signal.ts", import.meta.url),
  "utf8",
);
const signalJavaScript = ts.transpileModule(signalSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "competitor-signal.ts",
}).outputText;
const signalModuleUrl = `data:text/javascript;base64,${Buffer.from(signalJavaScript).toString("base64")}`;
const { identifyVerifiedCompetitorSignal } = await import(signalModuleUrl);

const baseInput = {
  conversationText: "We need a more reliable process for weekly reporting.",
  sourceMode: "live",
  externalId: "public_1",
  businessCompetitors: [],
  deterministicCompetitorScore: 0,
};

test("does not infer a competitor from an unrelated qualified opportunity", () => {
  assert.deepEqual(identifyVerifiedCompetitorSignal(baseInput), {
    verified: false,
    competitor: null,
  });
});

test("requires complaint evidence for a deterministically matched competitor", () => {
  const input = {
    ...baseInput,
    conversationText: "We are considering Acme CRM alongside a few other tools.",
    businessCompetitors: ["Acme CRM"],
    deterministicCompetitorScore: 1,
  };
  assert.deepEqual(identifyVerifiedCompetitorSignal(input), {
    verified: false,
    competitor: null,
  });

  assert.deepEqual(
    identifyVerifiedCompetitorSignal({
      ...input,
      conversationText: "Acme CRM pricing is difficult to justify. Is there a lighter alternative?",
    }),
    { verified: true, competitor: "Acme CRM" },
  );
});

test("rejects a model-provided competitor name that is absent from the source", () => {
  assert.deepEqual(
    identifyVerifiedCompetitorSignal({
      ...baseInput,
      conversationText: "Our current vendor is too expensive and complex.",
      classifiedComplaintScore: 0.95,
      classifiedCompetitor: "InventedCloud",
    }),
    { verified: false, competitor: null },
  );
});

test("preserves the labeled mock comparison when its complaint is present", () => {
  assert.deepEqual(
    identifyVerifiedCompetitorSignal({
      ...baseInput,
      sourceMode: "mock",
      externalId: "mock_competitor_03",
      conversationText:
        "We tried the market leader, but the setup and pricing are difficult to justify. Any lighter alternatives?",
    }),
    { verified: true, competitor: "the market leader" },
  );
});

test("threads the explicit empty state through scan, counts, and UI", async () => {
  const [workflow, presenter] = await Promise.all([
    readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/server/presenter.ts", import.meta.url), "utf8"),
  ]);

  assert.match(workflow, /verified:\s*false,[\s\S]{0,120}competitor:\s*null/);
  assert.match(workflow, /No verified competitor weakness in this scan/);
  assert.match(presenter, /competitorWeakness\.verified\s*\?\s*1\s*:\s*0/);
  assert.doesNotMatch(presenter, /competitorSignals:\s*1/);
  // The dedicated Competitors view was removed in favor of a single report
  // page (business card + relevant Reddit posts/comments); the honesty
  // invariant itself still lives at the data layer, asserted above.
});
