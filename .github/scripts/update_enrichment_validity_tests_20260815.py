from pathlib import Path

path = Path('tests/scan-pipeline-architecture.test.mjs')
text = path.read_text()
old = '''test("optional Reddit thread expansion cannot abort a verified discovery scan", () => {
  assert.equal(source.includes('"reddit_enrichment_failed"'), false);
  assert.equal(source.includes("enrichment.diagnostics.fallbackUsed"), true);
});
'''
new = '''test("incomplete Reddit thread expansion fails closed before a definitive report", () => {
  assert.ok(source.includes("enrichment.diagnostics.fallbackUsed"));
  assert.ok(source.includes("requiredFullContextReviews"));
  assert.ok(source.includes("enrichment.diagnostics.enriched < requiredFullContextReviews"));
  assert.ok(source.includes('"reddit_enrichment_failed"'));
  assert.ok(source.includes("hasVerifiedThreadContext"));
});
'''
if old not in text:
    raise SystemExit('old optional enrichment architecture assertion not found')
path.write_text(text.replace(old, new, 1))
