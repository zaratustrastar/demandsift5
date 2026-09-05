import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Themes are aggregated conclusions shown to users, so the properties that
 * matter are honesty ones: a theme must be backed by several real
 * conversations, its count must match its evidence, and no conversation may be
 * counted twice across themes.
 */

const source = await readFile(
  new URL("../lib/intelligence/theme-clustering.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "theme-clustering.ts",
}).outputText;
const { clusterThemes } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const struggle = (sourceId, text, weight = 1) => ({ sourceId, text, kind: "struggle", weight });
const request = (sourceId, text, weight = 1) => ({ sourceId, text, kind: "request", weight });

const options = (overrides = {}) => ({ maxThemes: 5, minimumConversations: 2, ...overrides });

test("a recurring phrase becomes a theme with its supporting sources", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "I cannot set screen time limits on the television"),
      struggle("s2", "No way to enforce screen time on our smart TV"),
      struggle("s3", "screen time controls are missing entirely"),
    ],
    "struggle",
    options(),
  );
  assert.ok(themes.length >= 1);
  const [top] = themes;
  assert.match(top.label.toLowerCase(), /screen time/);
  assert.equal(top.conversationCount, 3);
  assert.equal(top.sourceIds.length, 3);
});

test("a single conversation is an anecdote, not a theme", () => {
  const themes = clusterThemes(
    [struggle("s1", "the remote control keeps disconnecting from the receiver")],
    "struggle",
    options(),
  );
  assert.deepEqual(themes, []);
});

test("conversation count always equals the evidence actually held", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "kids watching youtube unsupervised all evening"),
      struggle("s2", "kids watching youtube for hours"),
      struggle("s3", "cannot block youtube on the tv"),
      struggle("s4", "cannot block youtube at all"),
    ],
    "struggle",
    options(),
  );
  for (const theme of themes) {
    assert.equal(
      theme.conversationCount,
      theme.sourceIds.length,
      `theme "${theme.label}" reports a count it cannot evidence`,
    );
    assert.ok(theme.conversationCount >= 2);
  }
});

test("no conversation is counted in two themes", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "screen time limits missing on android tv"),
      struggle("s2", "screen time limits are impossible to set"),
      struggle("s3", "cannot block youtube on android tv"),
      struggle("s4", "blocking youtube does not work"),
      struggle("s5", "parental controls are far too basic"),
      struggle("s6", "parental controls do not exist here"),
    ],
    "struggle",
    options(),
  );
  const seen = themes.flatMap((theme) => theme.sourceIds);
  assert.equal(new Set(seen).size, seen.length, "counts must stay additive across themes");
});

test("themes are distinct rather than rewordings of one pattern", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "screen time limits missing"),
      struggle("s2", "screen time limits broken"),
      struggle("s3", "profile switching is confusing"),
      struggle("s4", "profile switching never works"),
    ],
    "struggle",
    options(),
  );
  assert.ok(themes.length >= 2);
  const labels = themes.map((theme) => theme.label.toLowerCase());
  assert.equal(new Set(labels).size, labels.length);
});

test("kinds are kept separate so struggles and requests never merge", () => {
  const corpus = [
    struggle("s1", "screen time limits missing"),
    struggle("s2", "screen time limits missing again"),
    request("r1", "please add a pin lock per profile"),
    request("r2", "a pin lock would be ideal"),
  ];
  const struggles = clusterThemes(corpus, "struggle", options());
  const requests = clusterThemes(corpus, "request", options());

  const struggleSources = struggles.flatMap((theme) => theme.sourceIds);
  const requestSources = requests.flatMap((theme) => theme.sourceIds);
  assert.ok(struggleSources.every((sourceId) => sourceId.startsWith("s")));
  assert.ok(requestSources.every((sourceId) => sourceId.startsWith("r")));
  assert.ok(struggles.every((theme) => theme.kind === "struggle"));
});

test("the same source cannot inflate a theme by appearing twice", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "screen time limits missing"),
      struggle("s1", "screen time limits missing"),
      struggle("s2", "screen time limits missing"),
    ],
    "struggle",
    options(),
  );
  assert.equal(themes[0].conversationCount, 2);
});

test("maxThemes is respected and zero is handled", () => {
  const corpus = Array.from({ length: 20 }, (_, index) =>
    struggle(`s${index}`, `problem group${index % 6} recurring issue group${index % 6}`),
  );
  assert.ok(clusterThemes(corpus, "struggle", options({ maxThemes: 3 })).length <= 3);
  assert.deepEqual(clusterThemes(corpus, "struggle", options({ maxThemes: 0 })), []);
  assert.deepEqual(clusterThemes([], "struggle", options()), []);
});

test("higher-weight evidence is listed first", () => {
  const themes = clusterThemes(
    [
      struggle("weak", "screen time limits missing", 1),
      struggle("strong", "screen time limits missing", 9),
    ],
    "struggle",
    options(),
  );
  assert.equal(themes[0].sourceIds[0], "strong");
});

test("a 'no ___' compound like no-shows is not collapsed to a bare fragment", () => {
  const themes = clusterThemes(
    [
      struggle("s1", "Angry at no shows and last-minute cancellations"),
      struggle("s2", "Losing $3k/week to no shows, what's working for you?"),
      struggle("s3", "How do you deal with No-Shows?"),
      struggle("s4", "What improves no show rates?"),
    ],
    "struggle",
    options(),
  );
  assert.ok(themes.length >= 1);
  const [top] = themes;
  // Before the fix, "no" was blocked from forming any two-word phrase, so
  // the winning label degraded to the meaningless fragment "shows"/"show".
  assert.match(top.label.toLowerCase(), /no shows?\b/);
  assert.notEqual(top.label.toLowerCase(), "show");
  assert.notEqual(top.label.toLowerCase(), "shows");
});
