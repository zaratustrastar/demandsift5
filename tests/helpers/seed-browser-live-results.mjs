// Manual browser QA only. Creates/updates one fixed synthetic scan inside a
// dedicated loopback database. It never starts jobs or calls providers.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const adminUrl = new URL(process.env.DEMANDSIFT_BROWSER_ADMIN_DATABASE_URL ?? "invalid:");
if (!["127.0.0.1", "localhost", "[::1]"].includes(adminUrl.hostname) || adminUrl.pathname !== "/postgres") {
  throw new Error("DEMANDSIFT_BROWSER_ADMIN_DATABASE_URL must be a loopback postgres database.");
}
const databaseName = "demandsift_browser_fixture";
const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  const [existing] = await admin`select 1 as present from pg_database where datname = ${databaseName}`;
  if (!existing) await admin.unsafe(`CREATE DATABASE ${databaseName}`);
} finally {
  await admin.end();
}

const fixtureUrl = new URL(adminUrl);
fixtureUrl.pathname = `/${databaseName}`;
const sql = postgres(fixtureUrl.toString(), { max: 1 });
let workspaceId = "ws_browser_live_partial";
const token = "synthetic-browser-live-results-token";
let scanId = "scan_11111111111111111111111111111111";
const useLatestBrowserWorkspace = process.argv.includes("--latest");
const bumpPartialVersion = process.argv.includes("--bump");
const now = new Date().toISOString();
const ago = minutes => new Date(Date.now() - minutes * 60_000).toISOString();
const source = (id, title) => ({ id: `source_${id}`, kind: "reddit", url: `https://www.reddit.com/r/SaaS/comments/${id}`,
  title, excerpt: `Synthetic public-conversation excerpt for ${title}.`, capturedAt: ago(18), synthetic: false,
  provider: "browser-fixture", sourceMode: "live" });
const opportunity = { id: "opp_browser_lead", sourceId: "source_lead", title: "Looking for a better way to find active buyer conversations",
  excerpt: "Our team misses relevant discussions until they are already old.", subreddit: "SaaS", author: "synthetic_founder",
  permalink: "https://www.reddit.com/r/SaaS/comments/lead", postedAt: ago(18), score: 91, leadScore: 92, replyScore: 86,
  competitorScore: 10, researchScore: 83, commentCount: 12, whyItMatters: "They are actively evaluating a workflow DemandSift addresses.",
  intent: "actively-looking", recommendedAction: "reply", communityRisk: "low", competitorSignal: null,
  competitorComplaint: false, customerProblem: "Relevant demand conversations are found too late.", replyId: "reply_browser_lead",
  synthetic: false, sourceMode: "live", conversationType: "post", authorIdentifier: "synthetic_founder",
  potentialCustomerIntent: "high_intent", qualificationScore: 94, firstSeenAt: ago(18), scanId,
  sourceCreatedAt: ago(18), supportingSourceIds: ["source_lead"], supportingSignalCount: 1,
  appearedInPreviousDemandDrop: false, shouldReply: true, mentionProduct: false, disclosureRequired: false };
const intelligence = { id: "intel_browser_relevant", sourceId: "source_relevant", externalId: "relevant",
  title: "How teams decide whether a Reddit thread is worth answering", summary: "Useful market evidence about reply timing, but not a current buyer.",
  subreddit: "marketing", author: "synthetic_researcher", tags: ["market_insight"], demandSignals: ["timing"], competitor: null,
  sourceCreatedAt: ago(27), sourceIds: ["source_relevant"], competitorScore: 0, researchScore: 76, replyScore: 68,
  replyId: "reply_browser_relevant" };
const readyReply = { id: "reply_browser_lead", opportunityId: opportunity.id, workspaceId, scanId,
  content: "One practical approach is to separate broad monitoring from an intent review, then prioritize fresh conversations where someone is explicitly evaluating options.",
  status: "draft", generation: 1, createdAt: ago(2), updatedAt: ago(2), publishedAt: null, publishedUrl: null,
  publishedVia: null, redditCommentId: null };
const preview = { kind: "candidate_preview", id: "preview_browser_pending", version: 2, fingerprint: "fixture-preview",
  state: "ready", qualificationStatus: "pending", externalId: "pending", sourceId: "source_pending",
  title: "What are people using for Reddit demand research?", excerpt: "We are comparing several ways to understand buying conversations.",
  subreddit: "Entrepreneur", author: "synthetic_operator", permalink: "https://www.reddit.com/r/Entrepreneur/comments/pending",
  postedAt: ago(9), intent: "evaluating", demandSignal: "explicit_demand", problem: "Needs a more reliable demand-research workflow.",
  productFit: "high", sourceMode: "live" };
const stages = [
  ["website", "Understanding your business", "complete", "Approved website evidence reused."],
  ["understanding", "Mapping the problems you solve", "complete", "Approved business profile ready."],
  ["discovery", "Searching recent Reddit conversations", "complete", "All planned searches completed."],
  ["triage", "Reading every credible candidate", "complete", "Credible candidates screened."],
  ["enrichment", "Opening the strongest conversations", "complete", "Full-context evidence checked."],
  ["qualification", "Identifying potential customers", "complete", "Qualified findings saved."],
  ["replies", "Drafting a reply", "active", "One reply is ready; another is being prepared."],
].map(([id, label, status, detail]) => ({ id, label, status, detail }));
const record = { id: scanId, workspaceId, websiteUrl: "https://demandsift.example", inputMode: "website",
  status: "running", phase: "scanning", progress: stages, createdAt: ago(42), updatedAt: now, error: null, result: null,
  durableJob: { id: "job_browser_fixture", type: "scan.run", acceptedAt: ago(40) }, approval: { version: "browser", approvedAt: ago(41) },
  discoveryProfile: { profileStage: "full", analysisMode: "openai", analyzedAt: ago(43), profile: {
    name: "DemandSift browser fixture", websiteUrl: "https://demandsift.example",
    summary: "Finds high-intent Reddit conversations and prepares grounded replies.", productCategory: "Demand intelligence",
    targetAudience: ["B2B founders", "growth teams"], problemsSolved: ["Finding active demand conversations"],
    features: ["Reddit discovery", "evidence-backed qualification"], competitors: [], irrelevantTopics: [], sourceIds: ["site_home"],
  }, business: { fixture: true } },
  runtimeProgress: { version: 1, phase: "scanning", acceptedAt: ago(40), analysisStartedAt: ago(44), analysisFinishedAt: ago(43),
    runStartedAt: ago(40), finishedAt: null, heartbeatAt: ago(1), lastWorkAt: ago(1),
    queries: { planned: 9, succeeded: 9, active: 0, retrying: 0, failed: 0, pending: 0 }, fetched: 120,
    canonicalEligible: 74, triage: { expected: 74, succeeded: 74, unresolved: 0, pending: 0, promising: 3 },
    deepReview: { target: 3, completed: 3, threadsVerified: 3 }, insights: "active",
    results: { qualifiedPeople: 1, relevantConversations: 1, repliesReady: 1 }, discoveryComplete: true,
    triageComplete: true, coverageComplete: true, partialResultsVersion: 4 },
  partialResults: { schemaVersion: 1, version: 4, updatedAt: now,
    previews: { [preview.id]: preview },
    qualified: {
      [opportunity.id]: { kind: "potential_customer", id: opportunity.id, version: 3, fingerprint: "fixture-lead", state: "ready",
        externalId: "lead", source: source("lead", opportunity.title), opportunity },
      [intelligence.id]: { kind: "relevant_conversation", id: intelligence.id, version: 3, fingerprint: "fixture-relevant", state: "ready",
        externalId: "relevant", source: source("relevant", intelligence.title), intelligence },
    },
    replies: {
      [readyReply.id]: { kind: "reply", id: readyReply.id, version: 4, fingerprint: "fixture-ready", state: "ready", reply: readyReply },
      reply_browser_relevant: { kind: "reply", id: "reply_browser_relevant", version: 4, fingerprint: "fixture-pending", state: "pending",
        reply: { ...readyReply, id: "reply_browser_relevant", opportunityId: intelligence.id, content: "" } },
    }, tombstones: [] },
};
if (bumpPartialVersion) {
  const nextPreview = { ...preview, id: "preview_browser_new", externalId: "new", sourceId: "source_new", version: 5,
    fingerprint: "fixture-preview-new", title: "How quickly can a small team respond to fresh buying questions?",
    problem: "Needs a faster way to act on recent intent.", permalink: "https://www.reddit.com/r/startups/comments/new" };
  record.partialResults.version = 5;
  record.partialResults.previews[nextPreview.id] = nextPreview;
  record.runtimeProgress.partialResultsVersion = 5;
}

try {
  const [table] = await sql`select to_regclass('public.runtime_scans') as name`;
  if (!table?.name) {
    const migration = await readFile(new URL("../../db/migrations/0002_runtime_state.sql", import.meta.url), "utf8");
    await sql.unsafe(migration);
  }
  // Additive account-link column queried by the current repository. The
  // fixture does not exercise sign-in, so it deliberately needs no auth
  // tables or foreign key from the much broader 0010 migration.
  await sql.unsafe("ALTER TABLE runtime_workspaces ADD COLUMN IF NOT EXISTS user_id uuid");
  if (useLatestBrowserWorkspace) {
    const [latest] = await sql`select id, workspace_id from runtime_scans
      where id <> 'scan_11111111111111111111111111111111' order by created_at desc limit 1`;
    if (!latest) throw new Error("No browser-created scan exists to seed.");
    scanId = latest.id;
    workspaceId = latest.workspace_id;
    record.id = scanId;
    record.workspaceId = workspaceId;
    opportunity.scanId = scanId;
    readyReply.scanId = scanId;
    readyReply.workspaceId = workspaceId;
    record.partialResults.replies.reply_browser_relevant.reply.scanId = scanId;
    record.partialResults.replies.reply_browser_relevant.reply.workspaceId = workspaceId;
  } else {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await sql`insert into runtime_workspaces (id, token_hash, expires_at, created_at, updated_at)
      values (${workspaceId}, ${tokenHash}, ${new Date(Date.now() + 86_400_000)}, ${new Date()}, ${new Date()})
      on conflict (id) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at, updated_at = excluded.updated_at`;
  }
  await sql`insert into runtime_scans (id, workspace_id, website_url, status, record, created_at, updated_at)
    values (${scanId}, ${workspaceId}, ${record.websiteUrl}, ${record.status}, ${sql.json(record)}, ${new Date(record.createdAt)}, ${new Date(record.updatedAt)})
    on conflict (id) do update set workspace_id = excluded.workspace_id, website_url = excluded.website_url,
      status = excluded.status, record = excluded.record, updated_at = excluded.updated_at`;
  console.log(JSON.stringify({ databaseUrl: fixtureUrl.toString(), scanId,
    ...(useLatestBrowserWorkspace ? {} : { cookie: `rd_workspace=${workspaceId}.${token}` }) }));
} finally {
  await sql.end();
}
