# DigitalOcean Droplet deployment

This is the self-managed VPS path for DemandSift. It runs the public web app,
background worker, PostgreSQL with pgvector, a one-shot migration container, and
Caddy HTTPS on one Droplet. The existing App Platform deployment remains
documented in `DEPLOYMENT.md`.

## Recommended Droplet

- Ubuntu 24.04 LTS
- Basic shared CPU, 2 vCPUs, 4 GB RAM, 80 GB SSD
- SSH key authentication
- A DigitalOcean Cloud Firewall allowing TCP 22 only from the administrator's
  IP and TCP 80/443 from all IPv4/IPv6 addresses

Do not expose PostgreSQL port 5432. The Compose file publishes only Caddy's HTTP
and HTTPS ports.

## Server preparation

Create a non-root sudo user, disable password/root SSH login after confirming
the new user's key works, install Docker Engine with the Compose plugin, and
clone the private repository with a read-only GitHub deploy key.

Run all application commands from the repository root. Create the production
environment file:

```sh
cp deploy/vps.env.example deploy/vps.env
chmod 600 deploy/vps.env
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Put the three generated values into `AUTH_SECRET`, `POSTGRES_PASSWORD`, and
`BACKGROUND_WORKER_SECRET`. Set `DOMAIN`, `APP_URL`, and `ACME_EMAIL`. Add the
OpenAI key and Stripe test credentials when those integrations are ready. If
you enable Reddit OAuth, generate two more values for
`REDDIT_TOKEN_ENCRYPTION_KEY` and `REDDIT_OAUTH_STATE_SECRET`.
Never commit or paste `deploy/vps.env` into an issue, log, or support message.

Point the domain's A record to the Droplet before starting Caddy. Add an AAAA
record only if the Droplet has IPv6 configured and allowed by the firewall.

## First deployment

Validate the resolved Compose configuration without printing secret values:

```sh
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml config --quiet
```

Build and start the stack:

```sh
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml up -d --build
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml ps
```

Startup order is guarded: PostgreSQL must be healthy, migrations must complete,
the web process must become healthy, and only then do the worker and Caddy
start. Migration checksums prevent silently changing an applied migration.

Inspect startup logs:

```sh
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml logs --tail=100 migrate web worker caddy
```

Expected worker events include `database_ready` and `queue_worker_started`.
Open `https://YOUR_DOMAIN` and run one website scan with `REDDIT_PROVIDER=mock`.

## Real Reddit data with Apify (internal MVP test only)

The guarded Apify adapter uses the community-maintained Trudax Reddit Scraper
actor to retrieve real public Reddit posts and comments. It first runs a
bounded set of precise Reddit Boolean searches, rejects unrelated homonyms and
duplicates locally, then retrieves full details and selected comments only for
the strongest candidates. It uses web scraping, not an approved Reddit API, so
the app labels every report and source as Apify test data. Do not use this mode
for a public/commercial launch without confirming Reddit authorization,
privacy/retention obligations, and the actor's terms and reliability.

Get the Apify API token from the Apify Console's Integrations settings. Edit the
server-only environment file so the token is not left in shell history:

```sh
nano deploy/vps.env
```

Set these values:

```dotenv
REDDIT_PROVIDER=apify-test
APIFY_REDDIT_TEST_MODE=true
APIFY_TOKEN=paste_your_apify_token_here
APIFY_REDDIT_ACTOR_ID=trudax/reddit-scraper
APIFY_REDDIT_MAX_RESULTS=40
APIFY_REDDIT_ENRICHMENT_LIMIT=8
APIFY_REDDIT_ENRICHMENT_COMMENTS=6
APIFY_REDDIT_TIMEOUT_MS=260000
APIFY_REDDIT_TIME_RANGE=year
SCAN_OVERLAP_DISCOVERY_TRIAGE=1
SCAN_PARTIAL_RESULTS=1
BACKGROUND_JOB_TIMEOUT_SECONDS=900
BACKGROUND_JOB_STALE_SECONDS=1200
```

Save Nano with `Ctrl+O`, Enter, then exit with `Ctrl+X`. Ensure the file remains
owner-readable only, rebuild the updated code, and follow the scan logs:

```sh
chmod 600 deploy/vps.env
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml up -d --build web worker
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml logs --tail=200 -f web worker
```

After a scan completes, the worker/web logs include `Reddit retrieval completed`
with bounded counters. The same counters are stored with the latest scan so a
zero-result report can be diagnosed without exposing raw search details in the
customer UI:

```sh
docker exec demandsift2-database-1 sh -lc 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -P pager=off -c "SELECT id, jsonb_pretty(record #> '\''{result,retrievalDiagnostics}'\'') AS retrieval FROM runtime_scans ORDER BY created_at DESC LIMIT 1;"'
```

`fetchedCandidates` confirms that the actor returned data,
`locallyMatchedCandidates` shows how many survived the business-fit and
homonym gate, `missingVerifiedTimestamps` identifies incomplete lightweight
records, and `qualifiedOpportunities` is the final post-classification count.

Run a new website scan in the browser. A successful result must say “real Apify
Reddit test data,” contain real `https://www.reddit.com/...` permalinks, and show
the test-source disclosure. Stop log following with `Ctrl+C`; this does not stop
the services. Each scan starts a paid Apify actor run, so keep the result cap
small while testing. The initial scan searches posts only, uses relevance order,
and looks back one year so a narrow brand query does not get displaced by noisy
recent comments. To return to safe mock mode, set `REDDIT_PROVIDER=mock` and
`APIFY_REDDIT_TEST_MODE=false`, then restart the web service.

Apify discovery and Reddit account authorization are independent. Apify can
find the conversation while the optional Reddit OAuth connection posts a
reviewed reply to the stored post/comment fullname. If OAuth is unavailable,
the UI copies the edited draft and opens its exact source permalink instead.

## Connect Reddit accounts and post replies

Direct posting requires a Reddit OAuth web-app client and an HTTPS domain. It
will not be enabled on the Droplet's raw `http://IP_ADDRESS` URL. First point a
domain at the Droplet and confirm Caddy serves `https://YOUR_DOMAIN`.

While signed in to the Reddit account that will own the integration, open
`https://www.reddit.com/prefs/apps`, create a **web app**, and register this
redirect URI exactly (including path and HTTPS):

```text
https://YOUR_DOMAIN/api/reddit/callback
```

The short value shown beneath the app name is the client ID. Copy it and the
client secret into the server-only environment file. Generate fresh encryption
and state secrets, then edit the file:

```sh
openssl rand -hex 32
openssl rand -hex 32
nano deploy/vps.env
```

Set:

```dotenv
REDDIT_OAUTH_ENABLED=true
REDDIT_CLIENT_ID=paste_client_id_here
REDDIT_CLIENT_SECRET=paste_client_secret_here
REDDIT_REDIRECT_URI=https://YOUR_DOMAIN/api/reddit/callback
REDDIT_USER_AGENT="web:com.demandsift.mvp:v0.1.0 (by /u/YOUR_REDDIT_USERNAME)"
REDDIT_TOKEN_ENCRYPTION_KEY=paste_first_64_hex_value
REDDIT_OAUTH_STATE_SECRET=paste_second_64_hex_value
```

Do not paste access or refresh tokens into the file; the app obtains them after
the user approves Reddit's authorization screen and encrypts them before
storage. It requests only `identity` and `submit`, uses a signed 10-minute state,
refreshes expiring access tokens, and revokes the refresh token on disconnect.

Deploy the new migration and services:

```sh
chmod 600 deploy/vps.env
git pull --ff-only
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml up -d --build --remove-orphans
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml logs --tail=150 migrate web
```

Use Stripe test mode to activate a pass or Core entitlement without a real
charge. Open **Settings → Reddit publishing → Connect Reddit**, approve the
requested scopes, return to the app, edit a source-linked reply, and click
**Post to Reddit**. A successful response stores the Reddit comment URL and
marks the reply published. Duplicate submission claims prevent double-posting;
an uncertain network result must be checked on Reddit before retrying.

If the Reddit app cannot be created or its credentials are not yet available,
leave `REDDIT_OAUTH_ENABLED=false`. **View on Reddit** and **Copy & open Reddit**
continue to work for real Apify/provider results without any Reddit API key.

## Stripe test mode

Keep `ENABLE_DEMO_STRIPE=false`. Configure Stripe test-mode server keys in
`deploy/vps.env`, then register this endpoint in the Stripe test Dashboard:

```text
https://YOUR_DOMAIN/api/stripe/webhook
```

Copy that endpoint's `whsec_...` signing secret into
`STRIPE_WEBHOOK_SECRET`, restart the web and worker services, and use Stripe's
test cards. Access is granted only after the signed webhook is stored and
verified; a frontend success redirect never grants access.

## Updating

```sh
git pull --ff-only
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml up -d --build --remove-orphans
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml ps
```

The PostgreSQL and Caddy named volumes survive container replacement. Do not run
`docker compose down --volumes` unless permanent database deletion is intended.

## Operational checks

```sh
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml ps
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml logs --tail=200 web worker
docker compose --env-file deploy/vps.env -f deploy/compose.vps.yaml exec database pg_isready -U demandsift -d demandsift
```

Enable DigitalOcean backups before storing real customer data. Also create a
separate, tested PostgreSQL backup routine; a filesystem snapshot is not a
substitute for verifying database restoration.
