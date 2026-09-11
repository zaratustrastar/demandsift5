import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Observed live: an AI visibility scan failed with "OpenAI returned an
 * unknown answer index 1 in visibility mentions." Root cause:
 * draftAnswers has up to 9 entries (3 providers x 3 questions), but only
 * the subset that actually mentions the brand is sent to
 * analyzeVisibilityMentions for classification -- so the `index` value
 * previously sent per answer was that answer's *original, sparse* position
 * in draftAnswers (e.g. [1, 4, 8] if only 3 of 9 mentioned the brand). The
 * economy model (low reasoning effort) was observed renumbering its
 * results positionally (0, 1, 2, ...) instead of echoing the sparse
 * indices back verbatim, which then failed parseVisibilityMentions's
 * strict "index must be one we actually sent" check.
 *
 * Fix: the index sent to OpenAI is now toClassify's own dense,
 * zero-based position (0..toClassify.length-1) -- request-position and
 * result-index always coincide by construction, regardless of how sparse
 * the real draftAnswers positions are. The mapping back to the real
 * draftAnswers slot happens locally afterward, never depending on the
 * model having preserved anything beyond "which of the N answers I sent
 * is this".
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const workflowSource = await read("../lib/server/ai-visibility-workflow.ts");

function semanticPassBody() {
  const start = workflowSource.indexOf("// Semantic pass second");
  const end = workflowSource.indexOf("const metrics = computeVisibilityMetrics", start);
  assert.ok(start >= 0 && end > start, "the semantic classification pass must exist");
  return workflowSource.slice(start, end);
}

test("the index sent to OpenAI is toClassify's own dense position, not the sparse original draftAnswers position", () => {
  const body = semanticPassBody();
  assert.match(body, /answers: toClassify\.map\(\(\{ answer \}, position\) => \(\{\s*index: position,/);
  // The old sparse-index call shape must be gone.
  assert.equal(/toClassify\.map\(\(\{ answer, index \}\) => \(\{ index, question/.test(body), false);
});

test("results are matched back to draftAnswers by request position, not by trusting the model's index to equal the original sparse position", () => {
  const body = semanticPassBody();
  assert.match(body, /const byPosition = new Map\(analyzed\.value\.map\(\(item\) => \[item\.index, item\]\)\);/);
  assert.match(body, /toClassify\.forEach\(\(\{ index \}, position\) => \{/);
  assert.match(body, /const classification = byPosition\.get\(position\);/);
  assert.match(body, /draftAnswers\[index\] = \{/);
  // The old sparse-index lookup (byIndex keyed by the original position)
  // must be gone.
  assert.equal(/const byIndex = new Map/.test(body), false);
});

test("every entry sent to OpenAI still carries the real question/answerText -- only the index numbering changed", () => {
  const body = semanticPassBody();
  assert.match(body, /question: answer\.question,/);
  assert.match(body, /answerText: answer\.answerText,/);
});
