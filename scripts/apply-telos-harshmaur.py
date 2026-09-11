from pathlib import Path
import base64
import gzip
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]

parts = [
    ROOT / f"scripts/telos-refactor.patch.gz.b64.part{index}"
    for index in range(1, 6)
]
for part in parts:
    if not part.exists():
        raise SystemExit(f"missing telos patch part: {part}")

encoded = "".join(part.read_text().strip() for part in parts)
try:
    patch = gzip.decompress(base64.b64decode(encoded))
except Exception as error:
    raise SystemExit(f"could not decode telos patch: {error}")

patch_path = Path("/tmp/demandsift-telos.patch")
patch_path.write_bytes(patch)
subprocess.run(
    ["git", "apply", "--3way", "--whitespace=nowarn", str(patch_path)],
    cwd=ROOT,
    check=True,
)

provider_template = ROOT / "scripts/harshmaur-reddit.server.ts.template"
test_template = ROOT / "scripts/harshmaur-reddit-provider.test.mjs.template"
provider_target = ROOT / "lib/providers/harshmaur-reddit.server.ts"
test_target = ROOT / "tests/harshmaur-reddit-provider.test.mjs"
shutil.copyfile(provider_template, provider_target)
shutil.copyfile(test_template, test_target)

reddit_path = ROOT / "lib/providers/reddit.server.ts"
source = reddit_path.read_text()

import_line = 'import { HarshmaurRedditProvider } from "@/lib/providers/harshmaur-reddit.server";\n'
if import_line not in source:
    marker = 'import { MockRedditProvider } from "@/lib/providers/mock-reddit";\n'
    if marker not in source:
        raise SystemExit("reddit provider import marker missing")
    source = source.replace(marker, marker + import_line, 1)

source = source.replace(
    "REDDIT_PROVIDER must explicitly select `mock`, `apify-test`, or an approved live provider.",
    "REDDIT_PROVIDER must explicitly select `mock`, `apify-test`, `apify-trudax-legacy`, or an approved live provider.",
)

pattern = re.compile(
    r'  if \(selected === "apify-test" \|\| selected === "apify"\) \{.*?\n  \}\n  if \(selected === "approved-http"\) \{',
    re.DOTALL,
)
replacement = '''  if (selected === "apify-test" || selected === "apify" || selected === "harshmaur") {
    if (env.APIFY_REDDIT_TEST_MODE?.trim().toLowerCase() !== "true") {
      throw new Error(
        "The Apify Reddit scraper is test-only. Set APIFY_REDDIT_TEST_MODE=true to opt in explicitly.",
      );
    }
    const allowedTimeRanges = new Set(["day", "week", "month", "year", "all"] as const);
    const configuredTimeRange = env.APIFY_REDDIT_TIME_RANGE?.trim().toLowerCase() || "week";
    if (!allowedTimeRanges.has(configuredTimeRange as "day" | "week" | "month" | "year" | "all")) {
      throw new Error("APIFY_REDDIT_TIME_RANGE must be day, week, month, year, or all.");
    }
    return new HarshmaurRedditProvider({
      actorId: env.APIFY_HARSHMAUR_REDDIT_ACTOR_ID?.trim() || "harshmaur/reddit-scraper",
      token: required(env.APIFY_TOKEN, "APIFY_TOKEN"),
      maximumItems: positiveInteger(env.APIFY_REDDIT_MAX_RESULTS, 250, 25, 400),
      enrichmentLimit: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_LIMIT, 8, 1, 20),
      enrichmentComments: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_COMMENTS, 12, 1, 100),
      timeoutMs: positiveInteger(env.APIFY_REDDIT_TIMEOUT_MS, 360_000, 20_000, 600_000),
      timeRange: configuredTimeRange as "day" | "week" | "month" | "year" | "all",
    });
  }
  if (selected === "apify-trudax-legacy") {
    if (env.APIFY_REDDIT_TEST_MODE?.trim().toLowerCase() !== "true") {
      throw new Error(
        "The legacy Apify Reddit scraper is test-only. Set APIFY_REDDIT_TEST_MODE=true to opt in explicitly.",
      );
    }
    const allowedTimeRanges = new Set(["day", "week", "month", "year", "all"] as const);
    const configuredTimeRange = env.APIFY_REDDIT_TIME_RANGE?.trim().toLowerCase() || "month";
    if (!allowedTimeRanges.has(configuredTimeRange as "day" | "week" | "month" | "year" | "all")) {
      throw new Error("APIFY_REDDIT_TIME_RANGE must be day, week, month, year, or all.");
    }
    return new ApifyRedditTestProvider({
      actorId: required(env.APIFY_REDDIT_ACTOR_ID, "APIFY_REDDIT_ACTOR_ID"),
      token: required(env.APIFY_TOKEN, "APIFY_TOKEN"),
      maximumItems: positiveInteger(env.APIFY_REDDIT_MAX_RESULTS, 250, 1, 400),
      enrichmentLimit: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_LIMIT, 8, 1, 20),
      enrichmentComments: positiveInteger(env.APIFY_REDDIT_ENRICHMENT_COMMENTS, 6, 0, 20),
      timeoutMs: positiveInteger(env.APIFY_REDDIT_TIMEOUT_MS, 360_000, 20_000, 600_000),
      timeRange: configuredTimeRange as "day" | "week" | "month" | "year" | "all",
    });
  }
  if (selected === "approved-http") {'''
source, count = pattern.subn(replacement, source, count=1)
if count != 1:
    raise SystemExit(f"could not replace Apify factory block; matches={count}")
reddit_path.write_text(source)

# The old architecture comment says provider discovery compiles Boolean searches.
# Harshmaur performs best with natural searchTerms; keep the editable-term contract
# but document that the provider is responsible for compiling them appropriately.
overrides_path = ROOT / "lib/intelligence/discovery-overrides.ts"
if overrides_path.exists():
    overrides = overrides_path.read_text()
    overrides = overrides.replace(
        "DemandSift stays responsible for compiling them into Reddit boolean searches",
        "DemandSift stays responsible for compiling them into provider-appropriate Reddit searches",
    )
    overrides_path.write_text(overrides)

print("telos patch applied")
print("Harshmaur provider staged as default apify-test adapter")
