from pathlib import Path

# The Harshmaur provider test is loaded through a separate VM realm, so compare
# the serialized lane list rather than relying on cross-realm prototype identity.
path = Path("tests/harshmaur-reddit-provider.test.mjs")
text = path.read_text()
old = '  assert.deepEqual(result.candidates[0].discoveryLanes, ["problem_pain"]);'
new = '  assert.equal(JSON.stringify(result.candidates[0].discoveryLanes), JSON.stringify(["problem_pain"]));'
if old not in text:
    raise SystemExit("cross-realm assertion marker missing")
path.write_text(text.replace(old, new, 1))

# Two legacy regression suites compile reddit.server.ts into a data: URL and
# replace its absolute aliases with data-URL stubs. The new runtime import must
# be stubbed there too; otherwise Node fails module resolution before the tests
# can exercise the legacy Trudax/search-plan behavior they are meant to cover.
for test_file in [
    Path("tests/apify-reddit-provider.test.mjs"),
    Path("tests/concept-gate-market-evidence.test.mjs"),
]:
    source = test_file.read_text()
    marker = '    "@/lib/providers/mock-reddit":'
    if marker not in source:
        raise SystemExit(f"VM replacement marker missing in {test_file}")
    if '"@/lib/providers/harshmaur-reddit.server"' in source:
        continue
    stub = (
        '    "@/lib/providers/harshmaur-reddit.server": moduleUrl('\
        '"export class HarshmaurRedditProvider { constructor(input={}) { this.input=input; } }"'\
        '),\n'
    )
    source = source.replace(marker, stub + marker, 1)
    test_file.write_text(source)
