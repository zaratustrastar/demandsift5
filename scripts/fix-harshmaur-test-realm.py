from pathlib import Path

path = Path("tests/harshmaur-reddit-provider.test.mjs")
text = path.read_text()
old = '  assert.deepEqual(result.candidates[0].discoveryLanes, ["problem_pain"]);'
new = '  assert.equal(JSON.stringify(result.candidates[0].discoveryLanes), JSON.stringify(["problem_pain"]));'
if old not in text:
    raise SystemExit("cross-realm assertion marker missing")
path.write_text(text.replace(old, new, 1))
