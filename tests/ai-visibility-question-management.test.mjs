import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Prompt 7B: AI Visibility gets its own persisted, user-manageable
 * question set (Reddit monitoring's watch terms, handled separately in
 * Prompt 7A, are untouched by any of this). No question IDs/versioning --
 * question text is the only identity; editing wording is treated as
 * retiring the old text and tracking a new one.
 */

const read = async (path) => readFile(new URL(path, import.meta.url), "utf8");
const contracts = await read("../lib/server/contracts.ts");
const schema = await read("../db/postgres/schema.ts");
const repository = await read("../lib/server/ai-visibility-repository.ts");
const workflow = await read("../lib/server/ai-visibility-workflow.ts");
const route = await read("../app/api/ai-visibility/settings/route.ts");
const dashboard = await read("../components/demand-intelligence/ProductDashboard.tsx");
const experience = await read("../components/ThreadlineExperience.tsx");
const migration = await read("../db/migrations/0015_ai_visibility_persisted_questions.sql");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = endMarker ? source.indexOf(endMarker, start + name.length) : source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

test("the migration adds one nullable jsonb column to the existing settings table -- no new table", () => {
  assert.match(migration, /ALTER TABLE runtime_ai_visibility_schedules/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS questions jsonb;/);
  assert.equal(/CREATE TABLE/i.test(migration), false);
  // Check only the actual SQL statement, not the explanatory comments
  // above it (which describe, in prose, why no default/NOT NULL was
  // used -- those words appear there deliberately as English, not SQL).
  const statement = migration.slice(migration.indexOf("ALTER TABLE"), migration.indexOf(";", migration.indexOf("ALTER TABLE")) + 1);
  assert.equal(/DEFAULT/i.test(statement), false);
  assert.equal(/NOT NULL/i.test(statement), false);
});

test("the schema column matches the migration: nullable jsonb, typed, no default", () => {
  const columnLine = schema.slice(schema.indexOf('questions: jsonb("questions")'), schema.indexOf("\n", schema.indexOf('questions: jsonb("questions")')));
  assert.match(columnLine, /jsonb\("questions"\)\.\$type<AiVisibilityTrackedQuestion\[\]>\(\)/);
  assert.equal(columnLine.includes(".notNull()"), false);
  assert.equal(columnLine.includes(".default("), false);
});

test("AiVisibilitySettingsRecord.questions is nullable, and null is documented as 'never seeded'", () => {
  const typeStart = contracts.indexOf("export type AiVisibilitySettingsRecord");
  const typeBody = contracts.slice(typeStart, contracts.indexOf("\n};", typeStart));
  assert.match(typeBody, /questions: AiVisibilityTrackedQuestion\[\] \| null;/);
});

test("AiVisibilityTrackedQuestion is text + active only -- no id/versioning field", () => {
  const typeBody = fnBody(contracts, "export type AiVisibilityTrackedQuestion", "\n};");
  assert.match(typeBody, /text: string;/);
  assert.match(typeBody, /active: boolean;/);
  assert.equal(/\bid\s*:/.test(typeBody), false);
  assert.equal(/version/i.test(typeBody), false);
});

test("sanitizeTrackedQuestions enforces trim, non-empty, case-insensitive uniqueness, and 1-10 active", () => {
  const body = fnBody(repository, "export function sanitizeTrackedQuestions");
  assert.match(body, /\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(body, /if \(!text\) return \{ error: "empty_question" \};/);
  assert.match(body, /toLocaleLowerCase\("en-US"\)/);
  assert.match(body, /if \(seen\.has\(key\)\) return \{ error: "duplicate_question" \};/);
  assert.match(body, /activeCount < MIN_ACTIVE_QUESTIONS/);
  assert.match(body, /activeCount > MAX_ACTIVE_QUESTIONS/);
});

test("the active-count cap is on active questions only -- total list length (including disabled entries) is not capped", () => {
  const body = fnBody(repository, "export function sanitizeTrackedQuestions");
  assert.equal(/cleaned\.length\s*[<>]/.test(body), false);
  assert.match(body, /const activeCount = cleaned\.filter\(\(question\) => question\.active\)\.length;/);
});

test("setAiVisibilityQuestions is a low-level write with no validation -- validation lives only in sanitizeTrackedQuestions", () => {
  const body = fnBody(repository, "export async function setAiVisibilityQuestions");
  assert.equal(body.includes("sanitizeTrackedQuestions"), false);
  assert.match(body, /questions: input\.questions/);
});

test("runAiVisibilityScan reuses persisted active questions when they exist, and only generates when settings.questions is null", () => {
  const body = fnBody(workflow, "export async function runAiVisibilityScan", "\nexport ");
  assert.match(body, /const settings = await getAiVisibilitySettings\(record\.workspaceId, record\.seedScanId\);/);
  assert.match(body, /if \(settings\?\.questions\) \{/);
  assert.match(body, /settings\.questions\.filter\(\(question\) => question\.active\)\.map\(\(question\) => question\.text\)/);
  assert.match(body, /const generated = await generateQuestions\(business, competitors\);/);
  assert.match(body, /generated\.length !== 3/);
});

test("the first-run seed persists the generated questions via setAiVisibilityQuestions, all marked active", () => {
  const body = fnBody(workflow, "export async function runAiVisibilityScan", "\nexport ");
  assert.match(body, /await setAiVisibilityQuestions\(\{/);
  assert.match(body, /questions: generated\.map\(\(text\) => \(\{ text, active: true \}\)\)/);
});

test("historical AiVisibilityScanRecord.questions/answers are never rewritten by this feature -- only the settings record is touched for persistence", () => {
  const body = fnBody(workflow, "export async function runAiVisibilityScan", "\nexport ");
  // record.questions is still assigned per-run for that scan's own
  // immutable snapshot, exactly as before -- this feature only adds a
  // *source* for that value (persisted vs freshly generated), it does not
  // change how the scan's own record stores its result.
  assert.match(body, /record = \{ \.\.\.record, questions, updatedAt: new Date\(\)\.toISOString\(\) \};/);
});

test("the settings PUT route accepts an optional questions field, validates it, and reuses updateAiVisibilitySettings for enabled -- no separate new route", () => {
  assert.match(route, /questions\?: unknown;/);
  assert.match(route, /if \(body\.questions !== undefined\) \{/);
  assert.match(route, /const validated = sanitizeTrackedQuestions\(body\.questions\);/);
  assert.match(route, /await setAiVisibilityQuestions\(/);
  assert.match(route, /await updateAiVisibilitySettings\(/);
});

test("the route's validation-error messages are customer-facing -- no internal field names or prompt-engineering language leak through", () => {
  const body = fnBody(route, "function questionValidationMessage");
  assert.equal(/prompt/i.test(body), false);
  assert.equal(/LLM/i.test(body), false);
  assert.match(body, /At least 1 question must stay active\./);
  assert.match(body, /Up to 10 questions can be active at once\./);
});

test("updateAiVisibility in ThreadlineExperience.tsx can send an optional questions payload through the existing PUT, and gives a distinct status message for a questions-only save", () => {
  const body = fnBody(experience, "async function updateAiVisibility");
  assert.match(body, /questions\?: AiVisibilityTrackedQuestion\[\]/);
  assert.match(body, /questions === undefined \? \{ enabled, scanId \} : \{ enabled, scanId, questions \}/);
  assert.match(body, /"Tracked questions updated\."/);
});

test("Manage questions is available beside the existing Questions tracked heading, not a new nav item or a separate page", () => {
  const sectionStart = dashboard.indexOf("<h3>Questions tracked</h3>");
  const nearby = dashboard.slice(sectionStart - 200, sectionStart + 300);
  assert.match(nearby, /Manage questions/);
  assert.match(nearby, /onClick=\{\(\) => setManagingQuestions\(true\)\}/);
});

test("ManageQuestionsPanel supports add, edit, enable/disable, and remove", () => {
  const body = fnBody(dashboard, "function ManageQuestionsPanel");
  assert.match(body, /const addQuestion = \(\)/);
  assert.match(body, /const toggleActive = \(index: number\)/);
  assert.match(body, /const removeQuestion = \(index: number\)/);
  assert.match(body, /const startEdit = \(index: number\)/);
  assert.match(body, /const saveEdit = \(\)/);
});

test("the UI enforces the same 1-10-active and duplicate/empty rules the server enforces, before the round trip", () => {
  const body = fnBody(dashboard, "function ManageQuestionsPanel");
  assert.match(body, /if \(activeCount >= 10\)/);
  assert.match(body, /if \(target\.active && activeCount <= 1\)/);
  assert.match(body, /isDuplicate\(text\)/);
  assert.match(body, /if \(!text\) \{ setError\("Questions can't be empty\."\); return; \}/);
});

test("removing or disabling the last active question is blocked in the UI", () => {
  const body = fnBody(dashboard, "function ManageQuestionsPanel");
  const removeFn = body.slice(body.indexOf("const removeQuestion"), body.indexOf("const startEdit"));
  assert.match(removeFn, /At least 1 question must stay active/);
  const toggleFn = body.slice(body.indexOf("const toggleActive"), body.indexOf("const removeQuestion"));
  assert.match(toggleFn, /At least 1 question must stay active/);
});

test("saving sends the full edited question list through the existing onUpdate path, matching the send-the-full-list-replace-wholesale pattern already used for Reddit watch terms", () => {
  const panelBody = fnBody(dashboard, "function ManageQuestionsPanel");
  assert.match(panelBody, /const ok = await onSave\(draft\);/);
  const saveQuestionsBody = fnBody(dashboard, "const saveQuestions =", "\n\n");
  assert.match(saveQuestionsBody, /onUpdate\(status\.enabled, questions\)/);
});

test("the panel reuses existing overlay/card/button classes -- no new drawer or dialog component was introduced", () => {
  const body = fnBody(dashboard, "function ManageQuestionsPanel");
  assert.match(body, /styles\.aiVisibilityDrawerOverlay/);
  assert.match(body, /styles\.aiVisibilityDrawer\b/);
  assert.match(body, /styles\.valuePropClose/);
  assert.match(body, /styles\.textButton/);
  assert.match(body, /styles\.primaryButton/);
});

test("no raw LLM/system prompt content is exposed anywhere in the manage-questions UI", () => {
  const body = fnBody(dashboard, "function ManageQuestionsPanel");
  assert.equal(/system prompt/i.test(body), false);
  assert.equal(/generateQuestions/.test(body), false);
});
