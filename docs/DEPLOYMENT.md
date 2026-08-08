# DigitalOcean deployment handoff

This document covers DigitalOcean App Platform. For the single-Droplet Docker
Compose deployment, see `VPS_DEPLOYMENT.md`.

This repository now has an App Platform topology for Node.js 22: one public web
service, one private worker, one pre-deploy migration job, and a DigitalOcean
Managed PostgreSQL binding exposed as `DATABASE_URL`.

## Persistence and execution modes

App Platform runs with `STATE_STORE=postgres`. Workspaces, scans, replies,
entitlements, Stripe-event deduplication, conversions, and background jobs use
the typed PostgreSQL repository and survive web or worker restarts.

The process-local memory repository remains available for local demos only and
is rejected when `NODE_ENV=production`. Do not remove `STATE_STORE=postgres` or
`DATABASE_URL` from a production component.

The worker runs in `queue` mode. It claims due scan jobs with PostgreSQL row
locking, calls a secret-protected web executor, and records success or a bounded
retry. The acquisition UI may also request the owned scan's inline executor to
show immediate progress; the repository's atomic scan claim ensures only one
executor runs a queued scan, while the other path observes the running or
completed state.

Verified paid checkouts also create a durable monitoring schedule pinned to the
specific purchased scan and website. The worker turns each due schedule into a
fresh queued scan plus its `scan.run` job in one transaction. A pass runs every
24 hours only until its seven-day access timestamp; an active Core subscription
runs every six hours and continues independently of the browser-session cookie.
Canceled or expired access disables scheduling, and queued/running scans prevent
overlap.

## Files

- `deploy/Dockerfile.web` builds and runs the vinext application on port 8080.
- `deploy/Dockerfile.worker` contains the worker launcher, migrations, and the
  PostgreSQL client used by the release job.
- `deploy/digitalocean-app.yaml` describes the service, worker, release job,
  ingress, health checks, secrets, and managed database binding.
- `scripts/background-worker.mjs` runs migrations or starts a guarded worker.

Both images use Node.js 22 and run application code as the unprivileged `node`
user.

## Prepare the platform

1. Create a DigitalOcean Managed PostgreSQL cluster in the same region as the
   app. Confirm the cluster permits `CREATE EXTENSION vector`; the initial
   migration uses both `pgcrypto` and `vector`.
2. Create the `threadline` database and `threadline_app` user, or change those
   names in the app spec to resources that already exist.
3. In all three GitHub component blocks in
   `deploy/digitalocean-app.yaml`, replace `your-org/threadline` with the real
   repository and adjust the branch if needed.
4. Replace `replace-with-managed-postgres-cluster` with the exact Managed
   Database cluster name. The app spec binds its private connection string to
   `DATABASE_URL` for the web service, worker, and migration job.
5. Replace every `REPLACE_IN_DIGITALOCEAN` secret in the DigitalOcean control
   panel or in the first submitted spec. Never commit actual keys. On later spec
   exports, preserve DigitalOcean's encrypted `EV[...]` value instead of
   replacing it with plaintext.

The checked-in model values are deployment defaults, not hidden user settings.
Review model availability and configure the matching per-token price environment
variables used by the application whenever pricing changes so estimated AI cost
records remain accurate.

## Required runtime configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Private bindable URL for Managed PostgreSQL. |
| `STATE_STORE` | Must be `postgres` for App Platform production. |
| `APP_URL` | Public web origin, populated from `${_self.PUBLIC_URL}`. Set it to the custom primary origin after attaching a domain if needed. |
| `INTERNAL_WEB_URL` | Worker-to-web origin, populated from the web service's private `${web.PRIVATE_URL}` binding. |
| `BACKGROUND_WORKER_SECRET` | Shared web/worker bearer secret containing at least 32 cryptographically random characters. |
| `BACKGROUND_WORKER_MODE` | `queue` for the App Platform worker. |
| `MONITOR_SCHEDULER_POLL_MS` | Paid-monitoring scheduler poll period; defaults to `60000` ms and is bounded to 1–900 seconds. |
| `MONITOR_PASS_INTERVAL_HOURS` | Full Access Pass monitoring cadence; defaults to `24` hours and is bounded to 1–168 hours. |
| `MONITOR_CORE_INTERVAL_MINUTES` | Active Core monitoring cadence; defaults to `360` minutes and is bounded to 5–10080 minutes. |
| `OPENAI_API_KEY` | Server-side OpenAI credential. Never expose it through a `NEXT_PUBLIC_` variable. |
| `OPENAI_BASE_URL` | OpenAI-compatible API root; defaults to the official OpenAI `/v1` endpoint. |
| `OPENAI_API_STYLE` | `auto`, `responses`, or `chat`. `auto` selects Chat Completions for third-party compatible gateways. |
| `OPENAI_ANALYSIS_MODEL` | Capable website-analysis and insight model. |
| `OPENAI_REPLY_MODEL` | Reply-generation model; defaults to the capable model. |
| `OPENAI_ECONOMY_MODEL` | Lower-cost classification and ranking model. |
| `OPENAI_EMBEDDING_MODEL` | Semantic-matching embedding model. |
| `REDDIT_PROVIDER` | `mock` or an approved live Reddit API adapter for launch. The guarded `apify-test` adapter is for internal MVP validation only and is visibly labeled as unapproved scraping data. |
| `REDDIT_OAUTH_ENABLED` | `true` only after a Reddit web app has the exact HTTPS callback registered; controls end-user account connection and direct replies, independently of discovery. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Server-only Reddit OAuth web-app credentials. |
| `REDDIT_REDIRECT_URI` | Exact registered callback, normally `https://YOUR_DOMAIN/api/reddit/callback`. |
| `REDDIT_TOKEN_ENCRYPTION_KEY` | A dedicated 32-byte key, encoded as 64 hex characters or base64. |
| `REDDIT_OAUTH_STATE_SECRET` | A separate secret of at least 32 bytes for workspace-bound OAuth state. |
| `STRIPE_SECRET_KEY` | Stripe test or live server key. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for this deployment's webhook endpoint. |
| `STRIPE_PASS_AMOUNT_CENTS` | `1200`, before applicable tax. |
| `STRIPE_CORE_AMOUNT_CENTS` | `3000` monthly, before applicable tax. |

Keep `ENABLE_DEMO_STRIPE=false` in every App Platform deployment. Stripe test
mode uses `sk_test_...` and the test endpoint's real `whsec_...`; it does not use
the application's local demo-webhook shortcut.

If Stripe Price IDs are created in the Dashboard, add
`STRIPE_PASS_PRICE_ID` and `STRIPE_CORE_PRICE_ID` as runtime variables. Configure
both prices as tax-exclusive and enable automatic tax. Processing fees remain a
merchant cost and must not be added as a separate line item.

## Validate and deploy

Validate the template before submitting it:

```sh
doctl apps spec validate deploy/digitalocean-app.yaml
```

Create a new app:

```sh
doctl apps create --spec deploy/digitalocean-app.yaml
```

For an existing app:

```sh
doctl apps update APP_ID --spec deploy/digitalocean-app.yaml
```

App Platform builds each component from its selected Dockerfile. Before the new
web and worker revisions become active, the `migrate` pre-deploy job runs every
numbered `.sql` file in `db/migrations` in lexical order. It records SHA-256
checksums in `threadline_schema_migrations` and takes a PostgreSQL advisory lock,
so an already-applied migration is skipped and an edited applied migration
fails the deployment. Add a new migration; never rewrite one already deployed.

After the first successful deploy:

1. Confirm `/` passes both readiness and liveness checks.
   These process checks intentionally do not mutate or query the database.
2. Confirm the worker log contains `database_ready` followed by
   `queue_worker_started`.
3. Register `https://YOUR_DOMAIN/api/stripe/webhook` in Stripe and put that
   endpoint's signing secret in `STRIPE_WEBHOOK_SECRET`.
4. In Stripe test mode, complete both checkout types and confirm access changes
   only after a signed webhook is received.
5. Run a website scan and confirm outbound website and OpenAI requests are
   allowed by the deployment's network policy. Confirm one `scan.run` job
   reaches `succeeded` even if the browser's inline progress request wins the
   atomic scan claim.

## Queue operation

The worker polls every two seconds by default. `BACKGROUND_JOB_POLL_MS` is
bounded between 250 ms and 30 seconds. Each execution request is capped by
`BACKGROUND_JOB_TIMEOUT_SECONDS` (30–900 seconds), and locks older than
`BACKGROUND_JOB_STALE_SECONDS` (60–3600 seconds) can be reclaimed.

Jobs are claimed using `FOR UPDATE SKIP LOCKED`, carry a deduplication key, have
a maximum-attempt count, and use bounded exponential retry delays. The internal
executor verifies both the shared bearer secret and the worker's lock ownership
before running a scan. Rotate `BACKGROUND_WORKER_SECRET` as a coordinated web
and worker deployment; mismatched values intentionally stop job execution.

The monitoring scheduler independently polls every minute, so a long-running
scan does not delay schedule discovery. Eligibility is joined back to the
processed, signature-verified Stripe event and the purchased seed scan. Each
interval has a bucketed unique deduplication key; job reservation, queued
`runtime_scans` insertion, and advancement of `next_run_at` commit atomically.
The scheduler never selects free, canceled, or expired access, an expired pass,
or a workspace with another queued/running scan. Core scheduling intentionally
does not depend on the anonymous browser session's expiry.

The launcher still supports guarded `standby` and local module modes for
diagnostics, but neither is configured in the production App Platform spec.

## References

- [DigitalOcean App Spec reference](https://docs.digitalocean.com/products/app-platform/reference/app-spec/)
- [DigitalOcean workers](https://docs.digitalocean.com/products/app-platform/how-to/manage-workers/)
- [DigitalOcean deploy-time jobs](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/)
- [DigitalOcean bindable environment variables](https://docs.digitalocean.com/products/app-platform/how-to/use-environment-variables/)
- [DigitalOcean managed database bindings](https://docs.digitalocean.com/products/app-platform/how-to/manage-databases/)
