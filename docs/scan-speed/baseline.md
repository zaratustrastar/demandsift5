# T00 handoff — isolated baseline and scan replay fixtures

Recorded August 31, 2026. **T00 is complete as a local baseline/fixture ticket. No scan optimization or production deployment has been made.** The next eligible ticket is T01; see [the implementation plan](./implementation-plan.md).

## Isolation and recovery

- Working copy: `work/demandsift5-speedup` in the assessment workspace, independently cloned from GitHub.
- Development branch: `codex/scan-speed-phase-1`.
- Baseline tag: `baseline/deployed-2026-08-31`, pointing to `cb24c44d5b707dd4d31b9c6c52b9f1eb1a9d6e9a` on `feature/reddit-intelligence-pipeline`.
- The default `main` branch is older and was not used as the implementation baseline.
- The clone's local `origin` push URL is `disabled://production-protected`; fetching still works. No push, deployment, migration, production configuration change, or paid scan was performed.
- Existing `work/demandsift5` and `work/demandsift5-live` checkouts are unchanged and clean.
- No production database, secrets, user records, or live environment files were copied. This is a source-code development clone, **not a running staging environment or database replica**.

To compare safely, use `git diff baseline/deployed-2026-08-31..HEAD`. To revisit the original revision, create a separate worktree at that tag; do not reset a checkout containing work. This ticket changes only documentation and test tooling, so no application rollback is currently needed. The local checkpoint tag is `checkpoint/t00-baseline`.

## What is verified, and what remains unknown

The [public deployment receipt](https://github.com/zaratustrastar/demandsift5/pull/1#issuecomment-5469731167), timestamped August 30 at 15:58:27 UTC, reports both web and worker at the baseline revision. On August 31 the remote feature branch still matched, and the public application root returned HTTP 200. Those checks do **not** independently prove which container revisions or private settings are running today.

[baseline.json](./baseline.json) separates published settings from source defaults. In particular, the public receipt reports `APIFY_REDDIT_ENRICHMENT_LIMIT=0`, comments `6`, max results `40`, and time range `month`. The source has additional Harshmaur-specific controls; these values must not be treated as proof of the effective query depth. Current actor build, provider route/model overrides, quotas, timeout overrides, explicit deep-review budget, and private runtime settings remain unverified.

The implementation preserves the current React/vinext, Node, PostgreSQL queue/storage, Apify, and Surplus/OpenAI-compatible architecture. No dependency versions, model choices, prompts, retrieval budgets, or production flags changed.

## Added coverage

The fixture corpus contains original synthetic business and conversation examples; it contains no copied customer or Reddit content. The harness executes actual source modules with in-memory provider stubs.

The 28 added tests cover cleaning and selection for explicit demand, indirect pain, competitor switching, relevant non-leads and homonym noise; zero-result audit selection; context-only and changed business profiles in AI requests; richer late duplicates; late stronger candidates; candidate pools at 0/1/25/26/276/399/400/401/450; missing embeddings; successful AI batch checkpoint retention and missing-ID-only resume; failed thread fetching; and failed remaining discovery chunks with a prior checkpoint.

These are deterministic contract/regression tests. They do not establish live model quality, an end-to-end production throughput baseline, or a speed gain. Context-only tests inspect the provider request; existing onboarding/crawler tests supply other coverage. Full-context fetch failure coverage verifies that failed fetching does not invent thread verification; T02 still needs workflow-level depth tests.

## Verification receipt

Runtime: Node **24.19.0**, satisfying the repository's Node >=22.13 requirement. The host's default Node 18 is too old; run commands with a supported Node first on `PATH`. Installation used the existing lockfile with `npm ci --ignore-scripts --no-audit --no-fund`; the lockfile is unchanged.

| Check | Result |
|---|---|
| Application build (`npm run build:node`, also run by `npm test`) | Passed |
| Added fixture tests | 28 passed |
| Full suite, after build | 511 tests: 509 passed, 1 failed, 1 skipped |
| Lint | 0 errors; 3 existing font warnings |
| Production behavior changes | None |
| Live speed/quality benchmark | Not run |

The full suite is **not green**. Its one failure predates this ticket: `tests/rendered-html.test.mjs:24`, “server-renders the Threadline acquisition experience,” expects the old “Find the threads where your next customers are” heading. The current landing page uses different Scooptr wording. Neither the page nor that assertion was edited. The skipped test is the opt-in live Apify enrichment probe.

The existing lint warnings concern font loading in `components/OnboardingHeader.tsx`, `components/ThreadlineExperience.tsx`, and `components/demand-intelligence/ProductDashboard.tsx`; they are unrelated to this ticket.

Reproduce with Node >=22.13 and no live credentials:

```sh
npm run build:node
node --test tests/scan-replay.test.mjs
node --test --test-reporter=./scripts/compact-test-reporter.mjs tests/*.test.mjs
npm run lint
git diff --check
```

The compact reporter avoids megabytes of compiled-module/HTML assertion output. It preserves failure names, locations, counts, and the test runner's nonzero exit status. Use the standard reporter on a specific test when full diagnostics are needed. No new packages or test-script changes were required.

## Known defects, not accepted future behavior

1. Thread-fetch settings can collapse deep AI review to one item. T02 must separate these controls without reducing explicit existing depth.
2. Some exhausted AI structured-output failures become synthetic negative relevance judgments. T03 must make unresolved coverage explicit and invalidate only that legacy failure format on resume.
3. A website crawl can be repeated after profile approval. T04 must reuse the approved snapshot while preserving security and evidence links.
4. Additional recovery issue found while building fixtures: in `runChunkedDirectDiscovery`, when multiple remaining chunks all fail and a prior checkpoint exists, the provider returns the old checkpoint before recording the new failure diagnostics. If only one remaining chunk fails, it throws instead. The fixture deliberately characterizes the former behavior; it does not certify complete coverage. T07/T10 must reconcile the entire planned query set before claiming discovery completion.
5. The stale landing-page assertion above is an explicit baseline test exception, not permission to ignore new failures.

## Next ticket: T01

Add safe timing, attempt/usage, and effective-configuration instrumentation without changing budgets or scheduling. Preserve separate spans for concurrent work, redact provider payloads, and make telemetry failures non-fatal. T01 should persist and reuse the accepted run's effective configuration; it must not invent values for the private production settings listed above.

After T01, T02 and T03 correct depth and unresolved coverage before performance comparisons. Because those corrections can increase actual review work, later speed claims must use the corrected baseline. T00 intentionally stops before these application changes, as specified by the one-ticket-per-session plan.
