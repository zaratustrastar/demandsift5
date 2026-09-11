from pathlib import Path
import re

provider = Path("lib/providers/reddit.server.ts")
s = provider.read_text()


def sub1(pattern: str, replacement: str, label: str) -> None:
    global s
    updated, count = re.subn(pattern, replacement, s, count=1)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    s = updated


sub1(r"`looking for \$\{category\}`", "category", "category direct query")
sub1(r"`\$\{category\} recommendations`", "`best ${category}`", "category recommendation query")

sub1(
    r"  for \(const seed of \[\.\.\.problems, \.\.\.jobs\]\.slice\(0, 8\)\) \{\n"
    r"    const manifestation = manifestationExpression\(seed\);\n"
    r"    if \(!manifestation\) continue;\n\n"
    r"    push\(\n"
    r"      \"direct_buying_intent\",\n"
    r"      `need help \$\{manifestation\}`,\n"
    r"      seed,\n"
    r"    \);\n"
    r"  \}",
    "  // Problems and jobs are already natural demand phrases. Do not spend\n"
    "  // separate searches on a synthetic 'need help' prefix for the same pain.\n"
    "  for (const seed of [...problems, ...jobs].slice(0, 10)) {\n"
    "    const manifestation = manifestationExpression(seed);\n"
    "    if (!manifestation) continue;\n"
    "    push(\"problem_pain\", manifestation, seed);\n"
    "  }",
    "duplicate need-help loop",
)

sub1(
    r"  const quotas: Array<\[DemandLane, number\]> = \[\n"
    r"    \[\"direct_buying_intent\", 2\],\n"
    r"    \[\"problem_pain\", 2\],\n"
    r"    \[\"competitor_switching\", 1\],\n"
    r"    \[\"category_recommendation\", 1\],\n"
    r"    \[\"brand_competitor_mentions\", 1\],\n"
    r"    \[\"workaround\", 1\],\n"
    r"    \[\"timing\", 1\],\n"
    r"  \];",
    "  const quotas: Array<[DemandLane, number]> = [\n"
    "    [\"direct_buying_intent\", 1],\n"
    "    [\"problem_pain\", 4],\n"
    "    [\"competitor_switching\", 1],\n"
    "    [\"category_recommendation\", 1],\n"
    "    [\"workaround\", 1],\n"
    "    [\"timing\", 1],\n"
    "    [\"brand_competitor_mentions\", 1],\n"
    "  ];",
    "lane quotas",
)

marker = "    const discoveryInput: ApifySearchActorInput = {"
if marker not in s:
    raise SystemExit("discovery input marker missing")
s = s.replace(
    marker,
    "    const perSearchItemBudget = Math.max(\n"
    "      2,\n"
    "      Math.min(6, Math.floor(maxItems / Math.max(searches.length, 1))),\n"
    "    );\n"
    + marker,
    1,
)
sub1(r"      maxPostCount: maxItems,", "      maxPostCount: perSearchItemBudget,", "maxPostCount")
sub1(r"      maxComments: 10,", "      maxComments: perSearchItemBudget,", "maxComments")
provider.write_text(s)

test_path = Path("tests/apify-reddit-provider.test.mjs")
t = test_path.read_text()

old_counts = """  assert.deepEqual(counts, {
    direct_buying_intent: 2,
    problem_pain: 2,
    competitor_switching: 1,
    category_recommendation: 1,
    brand_competitor_mentions: 1,
    workaround: 1,
    timing: 1,
  });"""
new_counts = """  assert.deepEqual(counts, {
    direct_buying_intent: 1,
    problem_pain: 4,
    competitor_switching: 1,
    category_recommendation: 1,
    brand_competitor_mentions: 0,
    workaround: 1,
    timing: 1,
  });"""
if old_counts not in t:
    raise SystemExit("lane count test block missing")
t = t.replace(old_counts, new_counts, 1)
t = t.replace(
    'entry.query === "looking for project management software"',
    'entry.query === "project management software"',
    1,
)
t = t.replace("assert.equal(discovery.maxComments, 10);", "assert.equal(discovery.maxComments, 4);", 1)
t = t.replace("assert.equal(discovery.maxPostCount, 40);", "assert.equal(discovery.maxPostCount, 4);", 1)

old_brand = """  assert.equal(
    plan.filter((entry) => entry.lane === "brand_competitor_mentions").length,
    1,
  );"""
new_brand = """  assert.equal(
    plan.filter((entry) => entry.lane === "brand_competitor_mentions").length,
    0,
  );"""
if old_brand not in t:
    raise SystemExit("Basecamp brand-lane assertion missing")
t = t.replace(old_brand, new_brand, 1)

new_test = r'''

test("TV parental-control plan spends slots on distinct Reddit-native problems", () => {
  const plan = redditModule.buildApifyRedditSearchPlan({
    queries: {
      productTerms: ["TVCP", "Android TV parental control app"],
      brandTerms: ["TVCP"],
      productCategories: ["Android TV parental control app"],
      customerProblems: [
        "too much TV time",
        "kids watching TV late",
        "block YouTube on TV",
        "set TV screen time",
        "lock TV from phone",
        "kids changing TV settings",
      ],
      jobsToBeDone: ["restrict apps on TV", "limit one more episode"],
      workarounds: [],
      triggerEvents: ["A child starts opening unwanted TV apps"],
      buyerIntent: ["recommendations", "alternative"],
      competitors: [],
      excludedTerms: [],
      ambiguityRisks: ["Android phones"],
    },
    limit: 25,
  });

  assert.equal(plan.length, 9);
  assert.equal(plan[0].query, "android tv parental control app");
  assert.ok(plan.every((entry) => !/^need help /i.test(entry.query)), JSON.stringify(plan));
  const pain = plan.filter((entry) => entry.lane === "problem_pain").map((entry) => entry.query);
  assert.ok(pain.some((query) => /much tv time/.test(query)), JSON.stringify(plan));
  assert.ok(pain.some((query) => /block youtube tv/.test(query)), JSON.stringify(plan));
  assert.ok(pain.some((query) => /screen time/.test(query)), JSON.stringify(plan));
  assert.equal(new Set(plan.map((entry) => entry.query.toLowerCase())).size, plan.length);
});
'''
insert_marker = '\ntest("rejects observed broad-query noise while retaining concrete Basecamp demand", async () => {'
if insert_marker not in t:
    raise SystemExit("TVCP test insertion marker missing")
t = t.replace(insert_marker, new_test + insert_marker, 1)
test_path.write_text(t)
