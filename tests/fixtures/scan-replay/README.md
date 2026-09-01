# Scan replay fixtures (T00)

All fixtures here are original synthetic examples. No production data, account
identifiers, API responses, or credentials have been copied. `.example` business
domains and `fixture_*` identities must never be used for paid live scans.

`scenarios.json` supplies fixed timestamps and semantic cases. `factories.mjs`
generates bounded candidate pools and stub API responses. `tests/scan-replay.test.mjs`
loads the actual TypeScript cleaning, selection, embedding, AI-provider, and
Harshmaur-provider code through `tests/helpers/load-ts-module.mjs`.

Run with Node >=22.13:

```sh
node --test tests/scan-replay.test.mjs
```

Covered scenarios: explicit demand; indirect pain; competitor switching;
relevant non-leads; homonym noise; zero-result audit; context-only input;
changed business input; exact/richer late duplicates; late high-priority
candidates; pool sizes 0/1/25/26/276/399/400/401/450; unavailable embeddings;
partial AI failure/resume; failed thread fetch; failed remaining query with
previous discovery preserved. Existing trust, ownership, crawler-security,
and onboarding tests remain part of the full acceptance suite.

These tests prove deterministic behavior and provider contracts, not live model
relevance. Supplied triage labels are test inputs, not outputs from OpenAI or
Surplus. Do not use the millisecond test timings as a scan-speed benchmark.
Live semantic comparisons require separately authorized saved corpora and
provider runs; no paid benchmark is started by this suite.

Known baseline defects are recorded in `docs/scan-speed/baseline.md`, not silently
normalized into the desired future behavior. T02 and T03 have separate acceptance
criteria for depth and unresolved judgments.
