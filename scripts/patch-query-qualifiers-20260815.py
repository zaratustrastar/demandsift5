from pathlib import Path

provider = Path('lib/providers/reddit.server.ts')
text = provider.read_text()
old = '''function problemTokens(value: string): string[] {
  return normalizeSearchText(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !PROBLEM_TOKEN_STOP_WORDS.has(token));
}
'''
new = '''function problemTokens(value: string): string[] {
  // Short domain qualifiers are often the most important part of a category:
  // TV, AI, HR, VR, AR, UK, EU, etc. The previous blanket length>=3 rule
  // silently removed them and widened searches into a different market.
  // Preserve short uppercase acronyms from the grounded source phrase while
  // keeping ordinary two-letter stop words excluded.
  const preservedShortTokens = new Set(
    (value.normalize("NFKC").match(/\\b[A-Z]{2,5}\\b/g) ?? [])
      .map((token) => normalizeSearchText(token))
      .filter(Boolean),
  );
  return normalizeSearchText(value)
    .split(" ")
    .filter(
      (token) =>
        (token.length >= 3 || preservedShortTokens.has(token)) &&
        !PROBLEM_TOKEN_STOP_WORDS.has(token),
    );
}
'''
if old not in text:
    raise SystemExit('problemTokens block not found')
text = text.replace(old, new, 1)
old = '''  const categoryExpression = (value: string): string => {
    const tokens = problemTokens(value);
    if (tokens.length === 0) return "";
    const selected = tokens.slice(0, 2);
    const descriptor = tokens.find((token) =>
      /^(?:app|apps|platform|software|system|tool|tools)$/.test(token),
    );
    if (descriptor && !selected.includes(descriptor)) selected.push(descriptor);
    return selected.join(" ");
  };
'''
new = '''  const categoryExpression = (value: string): string => {
    const tokens = problemTokens(value);
    if (tokens.length === 0) return "";
    // Keep enough grounded category qualifiers to avoid category collapse.
    // Example: "Android TV parental control app" must not become the much
    // broader "android parental app" or "android tv app".
    const selected = tokens.slice(0, 4);
    const descriptor = tokens.find((token) =>
      /^(?:app|apps|platform|software|system|tool|tools)$/.test(token),
    );
    if (descriptor && !selected.includes(descriptor)) selected.push(descriptor);
    return selected.join(" ");
  };
'''
if old not in text:
    raise SystemExit('categoryExpression block not found')
text = text.replace(old, new, 1)
old = '''    const seedTokens = seed
      .split(" ")
      .filter(
        (token) =>
          token.length >= 3 &&
          !PROBLEM_TOKEN_STOP_WORDS.has(token),
      )
      .slice(0, 6);
'''
new = '''    const seedTokens = problemTokens(entry.seed ?? "").slice(0, 6);
'''
if old not in text:
    raise SystemExit('searchPlanMatches seedTokens block not found')
text = text.replace(old, new, 1)
provider.write_text(text)

test_path = Path('tests/reddit-provider.test.mjs')
tests = test_path.read_text()
anchor = '''test("Basecamp demand plan searches indirect pain and redistributes only from evidence-backed pools", () => {
'''
if anchor not in tests:
    raise SystemExit('test insertion anchor not found')
addition = '''test("preserves narrow short qualifiers in categories and customer problems", () => {
  const plan = redditModule.buildApifyRedditSearchPlan({
    queries: {
      productTerms: ["TVCP", "Android TV parental control app"],
      brandTerms: ["TVCP"],
      productCategories: ["Android TV parental control app"],
      customerProblems: [
        "kids watching TV too long",
        "TV outside allowed hours",
        "block YouTube on TV",
      ],
      jobsToBeDone: ["Keep a child's TV use within allowed hours"],
      workarounds: [],
      triggerEvents: ["A child starts using an Android TV or Google TV"],
      buyerIntent: ["recommendations"],
      competitors: [],
      excludedTerms: [],
      ambiguityRisks: [],
    },
    limit: 25,
  });

  assert.ok(
    plan.some((entry) =>
      entry.lane === "direct_buying_intent" &&
      entry.query === "looking for android tv parental control app"),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.some((entry) =>
      entry.lane === "category_recommendation" &&
      entry.query === "android tv parental control app recommendations"),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.some((entry) =>
      entry.lane === "problem_pain" &&
      entry.query.includes("kids watching tv too long")),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.some((entry) =>
      entry.lane === "problem_pain" &&
      entry.query.includes("tv outside allowed hours")),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.some((entry) =>
      entry.query.includes("block youtube tv")),
    JSON.stringify(plan),
  );
  assert.ok(
    plan.every((entry) => entry.query !== "looking for android parental app"),
    JSON.stringify(plan),
  );

  const aiPlan = redditModule.buildApifyRedditSearchPlan({
    queries: {
      productTerms: ["AI code review tool"],
      brandTerms: [],
      productCategories: ["AI code review tool"],
      customerProblems: ["AI review misses bugs"],
      jobsToBeDone: [],
      workarounds: [],
      triggerEvents: [],
      buyerIntent: ["recommendations"],
      competitors: [],
      excludedTerms: [],
      ambiguityRisks: [],
    },
    limit: 25,
  });
  assert.ok(
    aiPlan.some((entry) => entry.query === "looking for ai code review tool"),
    JSON.stringify(aiPlan),
  );
});

'''
tests = tests.replace(anchor, addition + anchor, 1)
test_path.write_text(tests)
