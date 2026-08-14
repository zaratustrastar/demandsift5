from pathlib import Path

path = Path("tests/scan-pipeline-architecture.test.mjs")
text = path.read_text()
old = '''test("fresh acquisition scans audit a bounded demand-signal sample before accepting a triage false zero", async () => {
  const source = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");
  assert.match(source, /!previousResult && worthEnriching\\.length === 0/);
  assert.match(source, /selectZeroResultAuditCandidates/);
  assert.match(source, /Math\\.min\\(3, enrichmentBudget\\(\\)\\)/);
});'''
new = '''test("zero-result scans audit a bounded high-signal sample before accepting a triage false zero", async () => {
  const source = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");
  assert.match(source, /const zeroResultAuditCandidates = worthEnriching\\.length === 0/);
  assert.match(source, /selectZeroResultAuditCandidates/);
  assert.match(source, /budget: Math\\.min\\(previousResult \\? 1 : 3, enrichmentBudget\\(\\)\\)/);
});'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"expected one architecture test block, found {count}")
path.write_text(text.replace(old, new, 1))
