# Scooptr

Scooptr is a focused Reddit demand-intelligence MVP. A visitor submits a
business website, the backend safely reads a small set of public pages on that
domain, builds a source-backed business profile, finds relevant conversations
through an approved Reddit provider, and produces a short list of useful
opportunities with editable replies.

The included demo uses real website crawling plus a clearly labeled mock Reddit
provider. Mock records have no invented Reddit permalink and are never presented
as live conversations.

## Product journey

1. Submit a public business website.
2. Watch backend-owned crawl, understanding, discovery, ranking, and reply stages.
3. Review a free Market Scan with a business profile, two demand insights, one
   competitor gap, three opportunities, and one complete reply.
4. Unlock exact stored findings with the $12 seven-day pass after a verified
   Stripe webhook.
5. Edit, regenerate, and either post through a connected Reddit account or copy
   the reply and open its exact source conversation.
6. Explicitly purchase $30/month Core and record a tracked conversion.

VAT is excluded where applicable and calculated at Stripe Checkout. Processing
fees are not added as a separate customer charge.

## Local development

Requirements: Node.js 22.13 or newer.

```bash
cp .env.example .env.local
npm ci
npm run dev
```

`ENABLE_DEMO_STRIPE=true` enables the development-only signed webhook simulator.
It still creates a checkout record, signs a webhook event, verifies that event,
and grants access only from the verified event handler. The simulator is disabled
in production. With Stripe test credentials configured, checkout uses Stripe
Checkout instead.

`APP_RUNTIME_ENV` is read at request time. Keep it as `development` locally and
set it to `production` in every deployed web and worker process; production mode
refuses the memory repository and local-only providers.

## Provider configuration

All OpenAI calls live in server-only modules. Configure:

- `OPENAI_BASE_URL` and `OPENAI_API_STYLE`; `auto` uses Responses on the official
  OpenAI endpoint and the basic Chat Completions shape on compatible gateways.
- `OPENAI_ANALYSIS_MODEL` for website understanding, insights, and replies.
- `OPENAI_ECONOMY_MODEL` for conversation classification and ranking.
- `OPENAI_EMBEDDING_MODEL` for semantic matching.

Token use and estimated cost are captured per operation. Model prices are
configuration because provider pricing changes over time.

`REDDIT_PROVIDER=mock` is the safe default. `REDDIT_PROVIDER=approved-http`
enables the normalized server-to-server `POST /search` adapter for an approved
Reddit API provider. For internal MVP testing, `REDDIT_PROVIDER=apify-test`
enables a separately labeled, opt-in adapter for the Trudax Reddit Scraper. Its
two-stage flow first discovers narrowly matched records,
then retrieves full thread context only for promising candidates. Its records
are real public records, but the actor uses web scraping and is never
presented as an approved production Reddit integration. See the VPS guide for
the exact guarded configuration.

Conversation discovery and user posting use separate adapters. Optional Reddit
OAuth requests `identity submit`, stores access/refresh tokens encrypted at
rest, refreshes them server-side, and uses an idempotent publication claim
before `POST /api/comment`. Without OAuth, source-linked results keep a safe
fallback that copies the edited text and opens the real Reddit permalink.

Email, object storage, and analytics also sit behind server-only factories.
Their bounded console/in-memory adapters are development sinks; each factory
rejects those adapters in production and requires an explicitly registered
production provider.

## Security boundaries

- Crawls only HTTP(S), rejects credentials and non-standard ports, resolves DNS,
  blocks private/reserved IP ranges, revalidates every redirect, and refuses
  redirects outside the submitted domain.
- The acquisition flow creates a high-entropy, 30-day anonymous workspace
  session in an HttpOnly, SameSite cookie. Every API checks workspace ownership
  server-side; named email/SSO accounts are intentionally outside this MVP.
- Request sizes, rates, response bytes, page counts, redirects, and timeouts are
  bounded.
- Stripe signatures are HMAC-verified with tolerance and event idempotency.
- Access is never derived from a success redirect.
- Every profile fact, insight, opportunity, and reply retains provenance ids.
- Reddit OAuth state is signed and workspace-bound; Reddit tokens are encrypted
  at rest and never exposed to the browser.
- Secrets have no `NEXT_PUBLIC_` prefix and belong in server environment settings.

## Data and deployment

Local preview uses the process-memory repository so the demo stays
self-contained. Production requires `STATE_STORE=postgres`; the typed repository
persists acquisition workspaces, scans, replies, Stripe checkout state and
idempotency, entitlements, tracked results, and scan jobs. The broader normalized
PostgreSQL model also covers users, businesses, source provenance, findings and
AI usage. Numbered migrations live in `db/migrations/`.

DigitalOcean deployment assets live under `deploy/`. App Platform is documented
in `docs/DEPLOYMENT.md`. A self-managed Droplet stack using Docker Compose,
Caddy HTTPS, PostgreSQL with pgvector, a durable worker, and guarded migrations
is documented in `docs/VPS_DEPLOYMENT.md`. The worker retries failed scans,
recovers stale leases, and schedules paid monitoring scans without creating
duplicate interval jobs.

## Commands

```bash
npm run dev
npm run build
npm run build:sites
npm run lint
npm run db:generate
npm test
```
