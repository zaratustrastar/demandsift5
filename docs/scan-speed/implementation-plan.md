# DemandSift: quality-preserving scan-speed and live-results implementation plan

Prepared August 31, 2026. T00–T18 and the locally verifiable part of T19 are implemented in an isolated clone; production is unchanged. T19's provider-backed canary and 30–50-run measurement remain an explicit deployment gate. See [the baseline handoff](./baseline.md) and the ticket handoffs in this directory, including [T19](./t19.md).

## Decision

Keep the current React/vinext frontend, Node application, PostgreSQL queue/storage, Apify Reddit provider, and Surplus/OpenAI provider interfaces. Improve their scheduling, recovery, and presentation in small changes.

The main speed intervention is to overlap completed Apify search chunks with AI triage. Complement it with bounded AI output, measured concurrency, better retry recovery, and removal of repeated website crawling. The UX intervention is to open a live dashboard, expose real work counters, publish safely completed output incrementally, and support leaving and returning.

Do not promise an exact completion time before measuring the improved system at the same quality settings. No performance change ships if it reduces search coverage, intended review depth, relevance, evidence quality, or completion reliability.

## Evidence and scope

The reviewed production revision is [cb24c44](https://github.com/zaratustrastar/demandsift5/commit/cb24c44d5b707dd4d31b9c6c52b9f1eb1a9d6e9a), from `feature/reddit-intelligence-pipeline`, not the older default `main`. Reconfirm the deployed web and worker revisions before implementation.

The August 30 live sample took 21m22s by backend timestamps. Approximate observed stages: website/business analysis 34s; discovery 5m39s; AI triage 14m24s. This is one sample, not a p50/p90 benchmark. See the [technical assessment](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/outputs/demandsift-scan-speed-assessment.md) for provenance and full findings.

Two quality corrections must precede performance comparisons:

1. The inspected depth configuration can reduce deep qualification to one when comment fetching is disabled. The sample screened 276 candidates, marked 77 worth further review, and deeply qualified one. Those 77 are not proven leads.
2. `unresolvedTriage()` currently synthesizes negative relevance decisions for some exhausted structured-output failures. A record existing in the triage checkpoint therefore does not necessarily mean AI successfully evaluated it. This second issue is established from code; we did not measure how often it happened in the live sample.

Correcting these may increase work. Compare speed changes against the **quality-corrected baseline**, not against a run that did less review or silently skipped unresolved inputs.

## Non-negotiable invariants

- Keep up to four website pages and the existing browser fallback/security checks. Preserve context-text onboarding.
- Keep the full business analysis before review. Do not reintroduce a cheap profile that is silently replaced after the user approves search terms.
- Preserve approved search terms, query families, lookback, per-query retrieval depth, actor mode, and deterministic filtering. Do not lower any effective production budget to hit a timing target.
- Preserve the current global embedding selection/fallback behavior. Do not replace it with first-arrival selection.
- Preserve intended deep-review and full-context requirements. Record discovery-only versus thread-verified evidence honestly.
- Retain indirect pain, workarounds, competitor intelligence, relevant non-leads, and zero-result audits. Lead quality and reply safety stay independent.
- Final selection uses the complete canonical eligible pool. A fast query must not consume the entire review allowance before slower queries return.
- Unknown/unresolved is not irrelevant. Exhausted coverage is not a successful exhaustive scan or a definitive zero.
- Keep access control, workspace ownership, billing gates, provenance, human-review requirements, and existing posting permissions.
- No duplicate paid work from ordinary retries/reloads. After an ambiguous external timeout, reconcile the known run/request where possible; never claim exactly-once external billing.
- A browser disconnect never cancels an accepted background job.
- No stack migration, new scraping provider, new model, shorter lookback, or new external service in the core plan.

## How an implementation agent should work

Continuation authorized August 31: execute one ticket at a time, verify it and save a checkpoint, then proceed to the next eligible ticket. The user's instruction to continue until the objective is reached supersedes the original one-ticket-per-session stop. Keep production deployment and paid benchmarks separate from locally verified implementation; do not label an unrun external gate complete.

Each ticket may have a small contract-first commit and a wiring/test commit. If it needs a broader redesign, split it into explicit subtickets before changing code. Avoid unrelated formatting and opportunistic refactors, especially in the large workflow and frontend files.

All proposed filenames, fields, flags, and endpoints below are new design suggestions unless identified as existing. Add optional/versioned fields; preserve old saved scans and older clients. Allocate migration numbers from the actual checkout, not this document.

Suggested handoff fields:

- Ticket ID and implemented scope.
- Changed files and migration/config changes.
- Tests run, results, and any pre-existing failures.
- Quality/coverage evidence; measured latency only when actually measured.
- Flags left off/on, rollback procedure, and remaining limitations.
- Next eligible ticket. Never mark “done” merely because code compiles.

### Ordered checklist

Execute in this order; the dependencies also allow safe resumption after a paused task.

| Done | ID | Bounded outcome | Depends on |
|---|---|---|---|
| [x] | T00 | Freeze the real baseline and build a replay fixture set | — |
| [x] | T01 | Add timing, usage, and effective-config instrumentation | T00 |
| [x] | T02 | Separate deep-review depth from comment fetching | T00–T01 |
| [x] | T03 | Represent unresolved AI work honestly | T01–T02 |
| [x] | T04 | Reuse the approved website snapshot | T00–T03 |
| [x] | T05 | Fence execution ownership and protect checkpoint writes | T01–T04 |
| [x] | T06 | Make initial website analysis a durable job | T04–T05 |
| [x] | T07 | Add a compact, truthful progress API | T01–T06 |
| [x] | T08 | Ship honest progress and return-to-scan UX | T07 |
| [x] | T09 | Extract one bounded AI dispatcher without changing behavior | T03, T05 |
| [x] | T10 | Overlap discovery and triage with final reconciliation | T04–T05, T07, T09 |
| [x] | T11 | Coordinate retry budgets and fallback timing | T01, T03, T05, T09–T10 |
| [x] | T12 | Compact triage output, preserving decisions and input evidence | T00–T03, T09, T11 |
| [x] | T13 | Tune concurrency/provider routing through controlled experiments | T01, T09–T12 |
| [x] | T14 | Persist and expose access-safe partial results | T03, T05, T07, T10 |
| [x] | T15 | Publish qualification early; overlap insights and replies | T09, T14 |
| [x] | T16 | Show ready results in a live dashboard | T08, T14–T15 |
| [x] | T17 | Add queue capacity without provider overload | T05–T06, T09, T13 |
| [x] | T18 | Add durable completion notices and optional email | T06, T14, T16 |
| [~] | T19 | Local gates/tooling complete; staged provider-backed rollout pending | All required tickets |

T13 may conclude that existing concurrency or provider routing should remain unchanged. T18's email adapter is conditional on an available production provider; in-app completion and return links are not conditional. Optional follow-ups are explicitly outside the core sequence.

## Source map

These links target the inspected checkout. Implementation must use the actual current deployed code if it has changed.

| Area | Existing files/functions |
|---|---|
| Orchestration, selection, final assembly | [scan-workflow.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/scan-workflow.ts): `runScan`, `runFullWebsiteUnderstanding`, `enrichmentBudget`, `minimumFullContextReviews`, `setStage` |
| AI batching, fallbacks, output schemas | [openai.server.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/openai.server.ts): `triageConversations`, `triageAttempt`, `qualifyConversations`, `unresolvedTriage`; [provider contracts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/contracts.ts) |
| Reddit chunk completion | [reddit-harshmaur.server.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/reddit-harshmaur.server.ts): `runChunkedDirectDiscovery`, `mergeDiscoveryResponses`, `runActor`; [provider selection](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/reddit.server.ts) |
| Cleaning and shortlist rules | [reddit-pipeline.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/intelligence/reddit-pipeline.ts): `cleanDiscoveryCandidates`, `selectCandidatesForEnrichment`, `selectZeroResultAuditCandidates`; [embedding prefilter](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/intelligence/embedding-prefilter.ts) |
| Crawl/security | [website-crawler.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/security/website-crawler.ts); [competitor-analysis.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/competitor-analysis.ts) |
| State and queue | [repository.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/repository.ts): `saveScan`, `beginScanRun`, `enqueueScan`, `claimJob`; [contracts.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/contracts.ts); [Postgres schema](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/db/postgres/schema.ts) |
| Actual production worker | [background-worker.mjs](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/scripts/background-worker.mjs): `claimJob`, `runQueueWorker`, `jobExecutionConfiguration`; [executor route](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/app/api/internal/jobs/[jobId]/execute/route.ts) |
| Analyze/run/status routes | [analyze](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/app/api/scans/[scanId]/analyze/route.ts), [run](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/app/api/scans/[scanId]/run/route.ts), [status](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/app/api/scans/[scanId]/route.ts), [latest scan](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/app/api/scans/latest/route.ts) |
| Errors and resilience | [job-retry-classification.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/job-retry-classification.ts); [resilience.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/resilience.ts); [Apify retries](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/apify-retry.ts) |
| Onboarding/progress | [ThreadlineExperience.tsx](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/components/ThreadlineExperience.tsx): `StageProgress`, `useElapsedSeconds`, polling/restoration; [styles](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/components/ThreadlineExperience.module.css) |
| Dashboard/presentation | [ProductDashboard.tsx](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/components/demand-intelligence/ProductDashboard.tsx); [from-scan.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/components/demand-intelligence/from-scan.ts); [presenter.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/presenter.ts); [result-totals.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/server/result-totals.ts) |
| Completion delivery | [email.server.ts](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/lib/providers/email.server.ts); existing provider contracts and job queue |
| Deployment | [compose.vps.yaml](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/deploy/compose.vps.yaml); [vps.env.example](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/deploy/vps.env.example) |

## Phase 1 — establish a safe baseline

### T00 — Record deployment truth and create replay fixtures

**Change**

1. Record web/worker SHA, actor/build, provider route/model identifiers, effective budgets, concurrency, and timeout configuration. Never record secrets.
2. Use the existing [tests](/Users/georgyarsentyev/Documents/Codex/2026-08-30/referenced-chatgpt-conversation-this-is-an/work/demandsift5-speedup/tests) and saved evidence to establish current behavior. Do not silently update snapshots to accept a regression.
3. Add a proposed `tests/fixtures/scan-replay/` dataset and replay harness. Cover approximately 12 scenarios: explicit demand, indirect pain, competitor switching, relevant non-leads, niche/ambiguous businesses, zero-result audits, context-only input, duplicates, failed queries, and AI failures.
4. Include candidate-pool boundaries below/at/above 400, richer late duplicates, changed business context, and a required full-context fetch failure.
5. Separate deterministic replay tests from opt-in paid/provider benchmarks. Replayed timings are not live latency measurements.

**Files:** test fixtures/harness, a baseline document under the repository's docs/ops convention, existing quality tests.

**Acceptance:** baseline commands/results recorded; fixture source/permissions clear; no production behavior changed; original results and known defects documented separately from desired behavior.

**Stop:** deliver fixtures and baseline. Do not optimize yet.

### T01 — Add instrumentation without changing behavior

**Change**

Add a small shared trace helper, proposed `lib/server/scan-observability.ts`. Instrument queue wait, analysis, crawl, actor/query runs, triage batches, deep qualification, insight generation, replies, and checkpoint saves.

Record scan/job/attempt IDs, deployment/config version, stage, start/end, queue wait, request duration, provider/model route, token usage where available, retry category, output parsing/coverage failures, candidate counts, and first-result/final timestamps. Count failed attempts as attempts even when they return no usage.

Use monotonic clocks for durations and server timestamps for persisted milestones. Distinguish worker heartbeat from actual provider/data progress. Redact query bodies, prompts, credentials, user email, and provider error payloads.

Resolve effective configuration once per accepted scan/run version, persist it, and reuse it across execution retries; log it and make it available to the baseline harness. Add flags for upcoming behavior changes with existing behavior as the default.

**Files:** trace helper, workflow and provider hook points, worker logging.

**Acceptance:** one replay produces a readable trace; concurrent work has separate spans rather than misleading additive stage time; instrumentation failure cannot fail a scan. No prompts/models/budgets changed.

**Gain:** measurement only.

### T02 — Separate qualification depth from thread fetching

**Change**

Introduce explicit deep qualification configuration, proposed `REDDIT_DEEP_QUALIFICATION_BUDGET`. Precedence: new explicit setting, then an existing explicit `REDDIT_ENRICHMENT_BUDGET`, then intended default 8. Never derive deep-review count from `APIFY_REDDIT_ENRICHMENT_LIMIT`.

Preserve a currently explicit higher review budget. Reject invalid configuration visibly instead of silently reducing depth. Keep comment/thread fetching and comments-per-thread as separate controls.

Audit all uses of `enrichmentBudget`, `minimumFullContextReviews`, replacement selection, zero-result audit, and publishing context gates. When thread fetching is off, retain the selected discovery records for deep AI review; do not pretend comments were fetched. When thread fetching is on, do not weaken its verification requirements.

**Files:** workflow budget helpers, provider enrichment configuration, environment example, focused tests.

**Acceptance:** fetch limit 0 does not force one deep review; eight eligible records reach qualification at default depth; explicit 12 stays 12; fewer eligible records do not cause invented fillers; zero-result audit and full-context tests pass.

**Gain:** quality correction, potentially more time/cost. Establish the corrected baseline before assessing speed.

### T03 — Treat unresolved AI work as unresolved

**Change**

Replace synthetic negative decisions from `unresolvedTriage()` with an explicit processing outcome separate from relevance: succeeded, pending, or unresolved. Preserve successful sibling-batch results.

A successful checkpoint contains a validated judgment. An unresolved item stores a safe error code, attempts, and recoverability; it cannot count as screened, be cached as negative, or satisfy coverage.

Recognize the known legacy synthetic-negative checkpoint format on resume and invalidate those entries. Do not reinterpret all ordinary negatives as failures.

Retry only unresolved IDs. After bounded recovery is exhausted, retain usable work but mark coverage incomplete. Keep the existing terminal status vocabulary initially: a terminal incomplete scan can be failed-with-partial-data, not falsely complete. T14/T16 will expose that partial data.

**Files:** provider contracts, AI provider, checkpoint/coverage checks in workflow, retry classification.

**Acceptance:** malformed output for one batch does not erase successful batches; unresolved IDs cannot become irrelevant; a zero cannot be final with required unresolved coverage; resume processes only pending/unresolved items.

**Gain:** quality/reliability. Never report “faster” just because an incomplete scan failed sooner.

## Phase 2 — remove repeated work and make progress trustworthy

### T04 — Persist and reuse the approved website snapshot

**Change**

Persist the actual normalized crawl pages, captured timestamps, canonical URL, stable source/provenance IDs, content hash, and crawler version alongside the full business analysis. Reuse that snapshot in `/run` and job retries.

Separate crawl retry from AI analysis retry: a valid crawl survives an AI failure. Do not rerun the crawl merely to reconstruct provenance.

Tie the snapshot to the reviewed profile. A newly requested website/reanalysis gets a new version; approved terms cannot silently change. Old scans lacking a snapshot use the legacy safe path. Context-text scans perform zero website fetches.

Keep cache scope within the scan first. Cross-scan freshness caching is optional later.

**Files:** workflow understanding/crawl branches, scan contracts, focused crawl/profile tests. Do not alter crawler security policy.

**Acceptance:** analyze → approve → run performs one successful crawl; AI retry reuses it; source references remain valid; legacy/context/competitor paths pass; page counts show actual pages, not a hardcoded four.

**Gain:** typically seconds, plus fewer retry failure points.

### T05 — Protect execution ownership and checkpoint consistency

**Change**

Harden the existing PostgreSQL job mechanism, not replace it. Carry an execution token/epoch derived from a durable claimed attempt through the worker, executor, workflow, and checkpoint writes. Enforce ownership in the database write condition; an in-memory promise map alone is insufficient.

A reclaimed/new execution prevents an old executor from overwriting newer state or committing completion. Ownership loss cancels local provider work where supported and stops scheduling more calls. Preserve known external run IDs for reconciliation.

Serialize per-scan checkpoint updates through one reducer/write path with immutable snapshots. Concurrent discovery/triage/progress callbacks must merge changes without losing fields. Progress-only persistence may be coalesced; successful expensive-work checkpoints must not wait behind a UI timer.

Use additive migrations if needed; reuse existing job rows/attempts where sufficient. Test the PostgreSQL implementation, not just the memory repository.

**Files:** repository, worker/executor, workflow execution context, schema/migration and integration tests.

**Acceptance:** two workers claiming/reclaiming one scan cannot both commit; late completions cannot regress status; concurrent saves preserve all results; restart resumes known completed work.

**Gain:** recovery and safe future concurrency. No claim of exactly-once paid API execution.

### T06 — Queue initial analysis and preserve the review gate

**Change**

Add a `scan.analyze` job to the existing queue. `POST /analyze` returns accepted promptly after durable enqueue; it no longer keeps the browser request open for the crawl/model call.

Update both job-type definitions and the production worker's type allow-list/dispatch. The analysis executor uses the existing full-understanding function and T04 snapshot.

Add an explicit phase such as `awaiting_review` without requiring an immediate broad rewrite of `scan.status`. Analysis completion means “profile ready,” not “whole scan complete.” The client polls, fetches the completed profile, and shows review. `/run` requires the approved profile/version and does not auto-start from a refresh.

Deduplicate repeated analyze/run clicks server-side. Preserve the synchronous/mock testing path where appropriate.

**Files:** analyze/run routes, job contracts/repository, worker/executor dispatch; a small client adaptation for accepted responses.

**Acceptance:** close browser during analysis, restart app, reopen → same completed profile; no duplicate job; no Apify before approval; context and competitor flow unchanged.

**Gain:** durability and user flow, not inherently faster computation.

### T07 — Expose a compact progress contract

**Change**

Add a versioned `runtimeProgress` object to scan state. Keep current stage fields for old clients. Proposed content:

- lifecycle phase, acceptedAt, runStartedAt, finishedAt, heartbeatAt, lastWorkAt;
- queries planned/succeeded/retrying/failed;
- fetched, canonical eligible, AI-screened-successfully, unresolved, promising;
- deep-review target/completed, actual threads verified, insight-generation state;
- qualified people, relevant conversations, replies ready;
- discoveryComplete, triageComplete, coverageComplete, partialResultsVersion;
- optional ETA range and short safe status detail.

Counters count unique IDs/versions, not callbacks or retries. A raw fetched count can grow; canonical eligible totals can change during deduplication. Do not freeze a false denominator.

Extend `statusOnly` to select only needed JSON fields/columns from PostgreSQL. Do not call full report assembly every three seconds. Preserve ownership checks and `access`; all responses remain private/no-store.

**Files:** scan contracts, repository/status route, progress helper/hook points, API client type in `from-scan.ts`.

**Acceptance:** overlapping discovery/triage can both be active; retries do not double counts; status remains compact; old scans render; one workspace cannot read another's status.

**Gain:** observability/UX; reduced status-request overhead, not minutes of scan time.

### T08 — Ship honest progress before the larger scheduling change

**Change**

Use T07 in `StageProgress` and restoration:

- “Searching Reddit: 6 of 9 searches finished.”
- “Checking relevance: 175 discussions reviewed; more results are arriving.”
- “One search is retrying. Other checks are continuing.”
- “Qualifying promising conversations.”
- “Your results are saved. You can leave and return.”

All numbers are examples of copy, not fixed values. Only show close-tab-safe wording for durably accepted jobs. Show queued separately from working, and last real activity separately from worker heartbeat.

Remove “usually a minute or two” and equal-weight percentage progress. Initially use counters/stage states without a time promise. Persist elapsed time from server milestones; separately exclude time awaiting user review.

Keep three-second polling while visible, slower polling while hidden, immediate refresh on focus, one outstanding request, and existing transient-error backoff. A failed poll means connection trouble, not scan failure.

**Files:** `ThreadlineExperience.tsx`, its styles, progress/client types.

**Acceptance:** reload does not reset elapsed time or start a new scan; offline recovery works; concurrent stages render; no fake 99%; keyboard/mobile/reduced-motion behavior remains usable.

**Gain:** immediate clarity and reduced abandonment risk; measure product impact later.

## Phase 3 — shorten the critical path

### T09 — Extract one bounded AI dispatcher

**Change**

Refactor triage into a reusable bounded dispatcher with submit, flush, drain, and cancellation. Keep default batch size 25 and concurrency four. Keep the provider interface as a compatibility wrapper so other callers still work.

Do not let each discovered chunk call an independent four-worker triage function: nine chunks must not create 36 simultaneous requests. Recursive oversized-batch splitting, retries, and fallback calls also pass through the same permit mechanism. Release permits during backoff.

Expose injectable clocks/provider stubs and batch-success/outcome callbacks. Record exact candidate versions per batch. Do not change prompts, shortlist rules, or model routing in this ticket.

**Files:** AI provider and contracts; a proposed small dispatcher module; existing batching/checkpoint tests.

**Acceptance:** old path output order/coverage unchanged with deterministic stubs; nested splits never exceed the cap; a failed batch does not discard siblings; cancellation prevents further dispatch; 0/1/25/26/276/400/450 pools tested.

**Gain:** prerequisite; this refactor should not claim a speed win on its own.

### T10 — Feed completed discovery chunks into triage

**Change**

Build a coordinator, proposed `lib/server/discovery-triage-coordinator.ts`, then wire the existing `onChunkSucceeded` hook. This hook receives a cumulative merged response, not just new candidates: compute deltas by canonical identity and complete input hash.

Persist each discovery completion and enqueue eligible new versions. The hook must not await AI completion or slow down remaining Apify workers. Buffer candidates, dispatch full batches, and flush short batches on a configurable delay or discovery completion. Keep a bounded amount of early/speculative work; all remaining candidates stay persisted.

At discovery completion:

1. Run the existing authoritative full cleaning and embedding-prefilter logic on the final merged pool.
2. Reconcile early results against that final pool and full AI-input hashes.
3. Discard superseded early judgments; retriage richer/replaced candidates and process any newly eligible/missing ones.
4. Wait for every required final candidate to have a successful judgment.
5. Only then run the existing global shortlist and zero-result audit.

For >400 candidates, final global embedding selection remains authoritative. Early triage may do extra work on candidates not retained; cap and measure that extra cost, not final coverage. Do not assume a candidate's body hash captures author, metrics, lane, profile, or other prompt changes.

Deduplication can replace a record with a richer later record; invalid timestamps can also become valid at a later wall-clock check. The final reconciliation must preserve current semantics. Do not anchor future-date rejection to scan creation.

**Files:** coordinator, workflow discovery/triage blocks, dispatcher hooks, targeted tests.

**Acceptance:** AI starts before the slowest query finishes; all query families still run; slow late high-value candidates remain selectable; richer duplicates invalidate old results; >400 and embedding-failure fixtures match baseline eligible sets; restart works mid-overlap.

Replace the source-order-only assumption in `scan-pipeline-architecture.test.mjs` with behavioral dependency tests. Do not delete quality assertions to make overlap pass.

**Gain:** potentially 2–5 minutes on a scan shaped like the measured sample; zero if useful chunks arrive only at the end. Not a guarantee. Batch regrouping must also pass semantic evaluations.

### T11 — Coordinate retries, fallback, and deadlines

**Change**

Carry one attempt/deadline context through HTTP, structured-output repair, coverage recovery, provider fallback, and job retries. First instrument effective current behavior; then remove redundant retries rather than arbitrarily slashing timeouts.

Classify network errors, throttling, provider capacity, oversized output, missing IDs, malformed data, authentication, and exhausted coverage. Recover missing IDs only; split oversized batches only; do not retry invalid credentials as capacity failures.

Keep Surplus as the configured primary unless T13 evidence supports a change. For eligible gateway failures, use the existing direct fallback earlier within the shared budget instead of waiting through independent nested budgets. Use compatible model/prompt settings and log route changes. Do not race duplicate providers by default.

Persist Apify run/dataset IDs immediately after acceptance. After a lost poll or worker restart, inspect the existing run before launching a replacement. Abort/reconcile old runs where supported.

Align documented timeouts with runtime clamps. A deadline ending early produces incomplete/failed state with retained results, never a “faster successful scan.” Owned execution cancellation from T05 must actually reach provider work.

**Files:** AI/Apify retry helpers, workflow execution context, worker configuration/classification.

**Acceptance:** injected 429/5xx/timeouts/malformed output recover within a predictable budget; no completed batch is redone; lost responses do not blindly spawn another actor; authentication errors surface clearly; nonrecoverable scans retain progress.

**Gain:** primarily long-tail reduction; quantify p90/p95 and success rate together.

### T12 — Reduce output verbosity without reducing evidence

**Change**

Keep all categorical triage fields, candidate input evidence, model, and relevance instructions. Ask for one short clause for `problem` and `reason`; start with measured conservative limits, such as approximately 160/200 characters, and adjust from evaluation.

Do not truncate model JSON or lower output allowance until it breaks valid responses. Enforce length constraints only where both configured provider routes support them; otherwise use prompt instructions and validate locally without repeated repair just for harmless verbosity.

Canonically serialize stable business context and put shared instructions/context before variable candidate lists where supported. Include profile, prompt/schema, and model versions in cache/checkpoint keys. Do not remove timestamps from the evidence itself merely to improve cache hits.

Use exact same-scan successful checkpoints first. Do not add long-lived negative decision caching.

**Files:** triage schema/prompt builder, provider compatibility tests, replay/evaluation harness.

**Acceptance:** exact required ID coverage; no new false negatives on labeled indirect-pain/competitor cases; no evidence fabrication; shorter measured output; no increase in parse failures or retries. Review all changed decisions.

**Gain:** target a meaningful reduction in output tokens and triage time; 20–40% lower triage latency is an experiment goal, not a measured result.

This approach follows [OpenAI's latency guidance](https://developers.openai.com/api/docs/guides/latency-optimization) on output size, shared prefixes, and independent work. Gateway cache support and realized speed must be measured separately.

### T13 — Tune capacity with one variable per experiment

**Change**

Make batch size and concurrency validated configuration, retaining 25/four defaults. Test the same saved corpora in this order:

1. Compact output at existing capacity.
2. Concurrency four versus six, with batch size fixed.
3. Only if useful, modest batch-size changes at fixed concurrency.
4. Surplus versus direct OpenAI using the same supported model/prompt/settings; record any non-equivalent routing.

Measure queue-to-provider delay, response time, tokens, 429s, retries, coverage, cost, and decisions. Preserve quotas across simultaneous scans; a per-scan cap is not a global cap.

Do not deploy a change just because a single request is faster. Choose the configuration with improved end-to-end latency and acceptable reliability/quality. If direct routing is not demonstrably better, retain the existing routing.

**Files:** configuration resolver, dispatcher, evaluation scripts, environment documentation.

**Acceptance:** repeatable comparison and explicit keep/change decision; no increased unresolved coverage; no overload under two simultaneous test scans; defaults remain if evidence is insufficient.

**Gain:** for 276 candidates, 12 roughly equal batches need three waves at concurrency four versus two at six in an idealized model. Real gains depend on skew, retries, and provider rate limits; they are not additive with T12.

## Phase 4 — make completed work useful immediately

### T14 — Add a versioned partial-results store and endpoint

**Change**

Add additive, checkpointed partial output to the existing scan record initially, with a narrow repository accessor. Do not normalize the entire database in this ticket.

Separate three payload classes:

- reviewed candidate preview: relevance screening succeeded, deeper qualification pending;
- qualified/relevant result: existing qualification, evidence, and publishing gates passed;
- reply: successfully generated, validated, and saved.

Use stable per-scan candidate/result IDs and monotonically increasing versions. Preserve completion/error state per output. Triage-positive is never automatically a lead.

Add an authenticated partial endpoint, proposed `GET /api/scans/:id/partial?afterVersion=N`. Initially return a bounded snapshot when changed, including replacements/tombstones if required; do not design an unbounded event history.

Factor access filtering into shared presenter helpers. Apply exactly the final report's workspace/entitlement restrictions to previews and partial results. Do not expose raw checkpoints, hidden candidates, provider errors, or premium results through progress metadata.

**Files:** contracts/repository, partial route, presenter helpers, workflow output callbacks.

**Acceptance:** retries/reload do not duplicate cards; late replacements remove stale previews; free/paid/workspace tests pass; partials survive terminal failure; no final report totals are inferred from incomplete data.

**Gain:** time to visible value, plus recovery; not necessarily lower total computation.

### T15 — Persist qualified results before report decoration; overlap the tail

**Change**

Keep the first implementation's global shortlist and deep-qualification batch unchanged. Once deep results have passed existing aggregation/deduplication and evidence gates, persist the qualified/relevant partial snapshot immediately.

Extract insight generation and reply generation into functions consuming the same immutable qualified set. Run them concurrently within the shared provider limit. Combine lead and non-lead reply work into one bounded queue while preserving their different failure requirements.

Checkpoint each successfully generated reply under a deterministic key including source/context/profile/instruction versions. Reuse existing reply rows; do not regenerate successful drafts on retry.

Persist each output as it is ready. An insight failure retains the existing sourced deterministic fallback. A required reply failure must not erase qualified evidence or masquerade as a ready draft. Final completion still respects required work.

**Files:** workflow tail, small insight/reply helper modules if useful, repository reply checkpoint access, concurrency tests.

**Acceptance:** qualified cards exist before insights/replies finish; insights and reply requests overlap; same eligible input set and final gates; restart during replies reuses completed drafts; same-source lead/non-lead deduplication remains intact.

**Gain:** seconds to roughly a minute on small scans; potentially more on larger reply workloads. The measured sample had only about 44 seconds after triage, so tail changes cannot explain several minutes there.

### T16 — Open a live dashboard and merge ready results

**Change**

After `/run` is durably accepted, open the dashboard shell with the approved business profile and current scan. Do not wait for a final `ScanResult` or manufacture one for the dashboard.

Show:

- persistent scan summary with real concurrent stage counts;
- “Conversations being checked” previews, distinct from potential customers;
- qualified/relevant result cards as soon as available;
- “Reply being prepared,” then the ready draft;
- incomplete coverage/retry notices without hiding already saved work.

Use `partialResultsVersion` from status polling to request partial data only when changed. Merge by stable ID/version, ignore out-of-order responses, preserve scroll, selection, and any user-edited draft. Do not reorder the visible list on every poll; announce new results and allow an explicit refresh of ordering. Final ranking can settle at completion.

Show final result totals only after coverage/final aggregation checks. Before that use “found so far,” separately for unique people versus conversations. Keep export of a final report distinct from an explicitly labeled partial export.

**Files:** dashboard component/styles, `from-scan.ts`, ThreadlineExperience polling/view state, new small live-progress/result components.

**Acceptance:** user can read a completed card while scan continues; candidate preview is not mislabeled a lead; final report does not duplicate/remove edited content unexpectedly; old completed scans still render; partial failure and offline restoration remain usable.

**Gain:** first useful output arrives before full completion. Core v1 does not promise fully qualified leads during discovery; see optional speculative review below.

## Phase 5 — capacity and completion

### T17 — Prevent queue head-of-line blocking safely

**Change**

Use existing PostgreSQL jobs. Add explicit job-class selection/priority so interactive analysis/full scans are not trapped behind all scheduled monitoring/visibility work. Include aging or reserved capacity so scheduled jobs do not starve.

Before enabling a second worker, enforce account/provider-wide request limits. The T09 dispatcher controls each process, not automatically all processes. Use PostgreSQL-backed leased permits or another already-present shared limiter for a multi-executor deployment. Do not add Redis solely for this.

Separate active Apify actor slots from short HTTP polling requests. Hold actor capacity while the actor is running, reconcile it after crashes, and release only on known terminal/abort state. Bound AI request concurrency and respect rate-limit feedback. Provide per-workspace fairness.

Roll out two workers only after contention/reclaim tests. Both worker instances currently start schedulers; ensure scheduler role configuration or database deduplication prevents duplicate scheduled jobs.

**Files:** production worker claim/dispatch, repository claim path, shared limiter, deployment configuration and tests.

**Acceptance:** two different scans progress; same scan executes once; no 2× provider overload; scheduled jobs still run; worker loss releases/reconciles leases safely.

**Gain:** queue-time reduction under load; little benefit for an idle single scan.

### T18 — Make leaving and returning dependable

**Change**

Provide a stable authenticated scan URL, persistent recent-scan state, and an in-app completion notice. Preserve anonymous cookie restoration; explain that another browser/device requires an account. A link must never bypass ownership.

For email, inspect actual production delivery first. The repository has an email-provider interface and a development console sink, not proof of a working production adapter. If configured, add an opt-in completion event/outbox keyed by scan and completion version; enqueue delivery outside the scan's critical path.

Send only to the authenticated/verified recipient who requested it. No leads or sensitive report content in email by default; link back to the authorized report. Delivery failure does not fail the scan. Persist notice/read/delivery state to prevent repeated alerts.

Do not promise email when no production provider is available. Ship return links and in-app notices regardless; document email as an external-configuration dependency.

**Files:** scan completion hook, queue/outbox/repository as needed, email abstraction, dashboard notification preference.

**Acceptance:** completion notices survive retries/restarts and do not duplicate; no unauthorized recipients; failed mail does not delay completion; links enforce authentication.

**Gain:** less user waiting effort; no total-scan latency gain.

### T19 — Validate, canary, and publish measured expectations

**Change**

Run the acceptance matrix below. Compare the quality-corrected baseline and optimized path on frozen corpora, then representative live scans. Separate synthetic/replay timing from real provider timing.

Roll out one behavior flag at a time to new jobs: internal workspaces → small canary (for example 5%) → wider (25%) → all. Pin config/prompt/model versions per accepted scan so changing a flag does not alter an in-flight job.

Collect enough representative completed and failed jobs to report a distribution; initially aim for at least 30–50 live runs across varied businesses and load, with sample size disclosed. This is an initial operational sample, not statistical proof of unchanged relevance. Use labeled replay/semantic review as the separate quality gate.

Report full-scan latency from the post-review `/run` acceptance to final completion, and processing latency from worker start to final completion. Report initial analysis latency separately, from `/analyze` acceptance to profile ready. Measure first-preview/first-qualified-result time from `/run` acceptance, plus queue wait, success/coverage rates, retries, provider cost, and depth. If reporting the entire onboarding journey from scan creation, include and separately identify user review dwell time; do not mix it into the backend scan benchmark.

Only publish user-facing ETA ranges after adequate same-version observations. Condition estimates on stage, outstanding work, and recent provider health. If confidence is poor, show progress without a countdown.

**Acceptance:** no known coverage/depth/evidence regression, lower same-scope elapsed time on representative runs, acceptable completion rate/cost, tested rollback, and honest ETA/copy.

**Stop:** deliver measured results, enabled flags, remaining limits, and rollback instructions. Do not claim a guaranteed eight-minute scan from projections.

## Required acceptance matrix

| Area | Required tests |
|---|---|
| Search scope | Same approved query set/lookback/actor mode/per-query depth; no truncation caused by arrival order |
| Candidate coverage | Exact canonical eligible IDs match replay baseline; >400 global prefilter and failure fallback preserved |
| Duplicates | Exact IDs, URLs, content/near-duplicates, richer late replacements, changed metadata |
| AI semantics | No known lost true positives or new unsupported positives on labeled cases; review all decision differences |
| Deep review | Intended budget retained; thread fetching independent; zero-result and context-verification requirements preserved |
| Recovery | Restart during analysis/discovery/triage/deep/tail; known successes reused; late executor cannot commit |
| Provider failures | 429, network loss, malformed/oversized/missing-ID output, actor timeout, permanent auth failure |
| Concurrency | One global effective cap including split/fallback calls; overlapping stage scheduling; no duplicate job claim |
| Partial output | Stable IDs/versions, no unresolved-as-negative, no candidate-as-lead, edited replies preserved |
| Security/access | SSRF/redirect protection retained; private/no-store APIs; free/paid gates and workspace boundaries |
| User flow | Context/website onboarding, review approval, close/reopen, offline/backoff, mobile and reduced motion |
| Performance | Whole-scan latency and first-result latency separately; failed/incomplete scans included in reliability metrics |

### Existing tests to extend

Use behavior-based tests around real compiled helpers with stubbed providers, following existing tests. Source-string tests alone cannot prove concurrency or recovery.

- `triage-batch-concurrency.test.mjs`, `triage-checkpoint.test.mjs`, `openai-intelligence-pipeline.test.mjs`, `openai-gateway-compatibility.test.mjs`
- `reddit-discovery-checkpoint.test.mjs`, `harshmaur-provider.test.mjs`, `reddit-intelligence-pipeline.test.mjs`
- `embedding-prefilter-recall.test.mjs`, `triage-candidate-budget-default.test.mjs`, `opportunity-ranking-quality.test.mjs`
- `potential-customer-aggregation.test.mjs`, `purpose-scores-independence.test.mjs`, `competitor-honesty.test.mjs`
- `website-crawler-security.test.mjs`, `website-crawler-concurrency.test.mjs`, `discovery-profile-lifecycle.test.mjs`
- `background-worker-monitoring.test.mjs`, `job-retry-classification.test.mjs`, `scan-save-serialization.test.mjs`
- `browser-scan-polling-resilience.test.mjs`, `latest-scan-restoration.test.mjs`, `scanning-phase-no-duplicate-scan.test.mjs`
- `business-access-scope.test.mjs`, `presenter-result-totals.test.mjs`, `reply-generation-concurrency.test.mjs`

The inspected repository uses Node >=22.13 and `npm test` builds the Node target before running `node --test tests/*.test.mjs`. Run focused tests while iterating, then the full test/build and lint suites before release. Record pre-existing failures; do not erase or weaken them.

## Rollback rules

- Keep orchestration, compact-output, partial-UI, and concurrency switches independent.
- Disabling overlap returns new executions to sequential scheduling using valid compatible checkpoints.
- Disabling compact prompts restores the previous prompt/version; do not reuse incompatible AI checkpoints.
- Disabling partial UI keeps saved results intact and falls back to honest status/final report.
- Reduce worker/concurrency counts only after draining or safely handing off active leases.
- Keep additive database fields on rollback; do not drop checkpoint/partial-output data.
- Do not roll back the quality corrections into synthetic negative decisions or accidental one-item review depth.
- A deploy must not change the interpreted configuration of an already accepted scan.

## Expected gains and how not to double-count them

| Intervention | Expected effect | Evidence boundary |
|---|---|---|
| Reuse approved crawl | Seconds; fewer repeated failures | Four-page analysis was only ~34s in the sample |
| Discovery/triage overlap | Potentially several minutes | Limited by time between useful early chunks and last discovery completion |
| Compact outputs + tuned capacity | Potentially substantial triage reduction | Must measure; the 14m24s sample includes unknown provider/retry contributions |
| Retry/fallback coordination | Shorter slow tail and cheaper recovery | Must not trade success/coverage for earlier failure |
| Parallel insights/replies | Seconds to minutes depending on output volume | Sample tail was only ~44s |
| Queue isolation/capacity | Large benefit when jobs contend | Does not speed the idle single-scan critical path |
| Progressive results/notifications | Earlier useful output and less active waiting | Not automatically a reduction in full completion time |

An appropriate initial engineering objective is a material reduction—e.g. 25–40% against the corrected same-scope baseline—while passing quality and reliability gates. This is a target, not a forecast. Do not add estimated savings mechanically: overlap, concurrency, and output shortening affect overlapping portions of the same work.

If healthy-provider scans remain long, keep full depth and treat the job as background research. Users should still see real progress, use completed evidence, and return later.

## Optional follow-ups — do not include in the first implementation

1. **Earlier deep-qualified cards:** after T16, consider a small additional speculative deep-review allowance while triage is still running. It must never consume the final global shortlist budget, bypass provenance/verification, or cause arrival-order selection. Reuse a speculative result only if its full input hash matches the final selected candidate. This can improve first-qualified-result time but adds cost and possibly contention; it is not required to achieve overlap speedup. Do not call provisional previews qualified leads.
2. **Cross-scan public retrieval cache:** consider only with demonstrated repeated-query demand. Key by actor/build, normalized query, sort, exact time scope, and retrieval settings. Revalidate freshness; fetching only the newest page is not proof of equivalent depth, edits, or ranking. Keep business-specific analysis workspace-scoped. Same-scan snapshots/checkpoints are the safe first cache.
3. **Apify webhooks:** optional after current polling is measured. Use authenticated callbacks, immediate acknowledgment, idempotent processing, and polling reconciliation; delivery can repeat. They are not a scraper-speed shortcut. [Apify webhook requirements](https://docs.apify.com/integrations/webhooks/actions)
4. **SSE/WebSockets:** consider only when status request volume or update latency warrants it. Three-second polling is adequate for the first release.
5. **Normalized candidate tables:** do this only if checkpoint-write timings/record sizes become material. Do not bundle a storage rewrite into concurrency work.
6. **Different models or Reddit providers:** separate quality-evaluated projects. Not part of this plan's same-model/same-source speed claim.

## Copy-ready agent instruction

Use this text with the plan attached or placed in the repository:

> Implement only the next unchecked ticket in the DemandSift scan-speed implementation plan. First read the non-negotiable invariants, that ticket, its dependency handoffs, and applicable repository instructions. Verify the actual deployed-code baseline; preserve unrelated work. Do not reduce search scope, candidate coverage, intended qualification depth, evidence requirements, or access controls. Keep the current stack and provider interfaces. Start with the listed files and reuse existing tests/helpers. If the ticket is too large, split it into contract-first and wiring/test subtickets and complete only the first bounded part. Do not silently redesign adjacent stages.
>
> Add regression tests for the ticket's failure cases and run the focused tests, then applicable build/lint checks. Use stubs/frozen fixtures by default; paid live scans and deployment belong to the explicitly authorized benchmark/rollout step. Do not invent credentials or claim unrun tests passed. Keep behavioral flags off until their acceptance gates pass. Update the ticket checklist and a short handoff with changed files, tests, configuration/migrations, remaining risks, rollback, and the next eligible ticket. Stop after this ticket; do not begin the next one automatically.

Next eligible action: execute the staged T19 provider-backed rollout from [the T19 handoff](./t19.md) after a production/staging target, current deployment revisions, and live provider credentials are available. Do not reinterpret the locally complete code as a live latency result.
