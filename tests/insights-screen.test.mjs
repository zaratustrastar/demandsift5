import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The Insights screen read like a long AI report: too much evidence
 * visible at once, no way to tell strong findings from weak ones at a
 * glance. This is a UI/information-hierarchy pass only -- no new AI
 * calls, no new insight-generation logic, no scan-processing changes.
 * Every field this reuses already existed in the report data before this
 * change; see the doc comments on InsightsFilterTabs/DemandPatternCard in
 * ProductDashboard.tsx for exactly which ones and why.
 */

const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");

test("the Insights screen has a compact All/Pains/Requests/Demand patterns filter, reusing the carousel's existing segmented-control classes rather than a new one", () => {
  const fnStart = dashboard.indexOf("function InsightsFilterTabs");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /\{ id: "all", label: "All" \}/);
  assert.match(fnBody, /\{ id: "pains", label: "Pains" \}/);
  assert.match(fnBody, /\{ id: "requests", label: "Requests" \}/);
  assert.match(fnBody, /\{ id: "patterns", label: "Demand patterns" \}/);
  assert.match(fnBody, /styles\.reviewFilterTabs/);
  assert.match(fnBody, /styles\.reviewFilterTab\b/);
});

test("the filter only hides/shows the three existing sections -- it never changes what themes/insights were fetched", () => {
  const sectionStart = dashboard.indexOf('activeSection === "insights"');
  const sectionBody = dashboard.slice(sectionStart, sectionStart + 2500);
  assert.match(sectionBody, /\(insightsFilter === "all" \|\| insightsFilter === "pains"\)/);
  assert.match(sectionBody, /\(insightsFilter === "all" \|\| insightsFilter === "requests"\)/);
  assert.match(sectionBody, /\(insightsFilter === "all" \|\| insightsFilter === "patterns"\)/);
  // Same data props as before -- data.conversationThemes / data.insights,
  // not a filtered copy passed down.
  assert.match(sectionBody, /themes=\{data\.conversationThemes\}/);
  assert.match(sectionBody, /data\.insights\]/);
});

test("demand-pattern cards reuse ThemeSection's exact card classes (themeCard/themeToggle/themeEvidence), not a new visual system", () => {
  const fnStart = dashboard.indexOf("function DemandPatternCard");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /styles\.themeCard/);
  assert.match(fnBody, /styles\.themeToggle/);
  assert.match(fnBody, /styles\.themeEvidence/);
  assert.match(fnBody, /styles\.simpleCardEyebrow/);
  assert.match(fnBody, /styles\.simpleCardBody/);
});

test("demand-pattern cards use insight.title/summary/eyebrow as-is -- no new conclusion text is generated", () => {
  const fnStart = dashboard.indexOf("function DemandPatternCard");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /\{insight\.eyebrow\}/);
  assert.match(fnBody, /<h3>\{insight\.title\}<\/h3>/);
  assert.match(fnBody, /\{insight\.summary\}/);
});

test("demand-pattern cards drop the repeated static recommendedAction sentence and the redundant whyItMatters duplicate", () => {
  const fnStart = dashboard.indexOf("function DemandPatternCard");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.equal(fnBody.includes("recommendedAction"), false);
  assert.equal(fnBody.includes("whyItMatters"), false);
});

test("demand-pattern evidence (insight.evidence) is now rendered, collapsed by default behind a View evidence toggle", () => {
  const fnStart = dashboard.indexOf("function DemandPatternCard");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  assert.match(fnBody, /const \[open, setOpen\] = useState\(false\)/);
  assert.match(fnBody, />\s*\{open \? "Hide evidence" : "View evidence"\}/);
  assert.match(fnBody, /insight\.evidence\.map/);
  assert.match(fnBody, /item\.quote/);
  assert.match(fnBody, /item\.sourceUrl/);
});

test("demand patterns are sorted strongest-first by the existing sourceCount field, not a new relevance score", () => {
  const sectionStart = dashboard.indexOf('activeSection === "insights"');
  const sectionBody = dashboard.slice(sectionStart, sectionStart + 2500);
  assert.match(sectionBody, /\[\.\.\.data\.insights\]\s*\.sort\(\(a, b\) => \(b\.sourceCount \?\? 0\) - \(a\.sourceCount \?\? 0\)\)/);
});

test("the existing 'X-conversation demand pattern' eyebrow string is reused as-is, not replaced with a separately computed count", () => {
  const fnStart = dashboard.indexOf("function DemandPatternCard");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\n}\n", fnStart));
  // The eyebrow (which already embeds the count, e.g. "5-conversation
  // demand pattern") is shown as one field -- no separate "N conversations"
  // string is computed or displayed alongside it.
  assert.equal(/\d+\s*conversation/.test(fnBody), false);
});

test("ThemeSection itself is untouched -- Pains/Requests already collapsed evidence by default and already showed conversationCount before this change", () => {
  const fnStart = dashboard.indexOf("function ThemeSection");
  const fnBody = dashboard.slice(fnStart, dashboard.indexOf("\nfunction ReplyComposer", fnStart));
  assert.match(fnBody, /const \[openThemeId, setOpenThemeId\] = useState<string \| null>\(null\)/);
  assert.match(fnBody, /\{theme\.conversationCount\} conversation/);
});
