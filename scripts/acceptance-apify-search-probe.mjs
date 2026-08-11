import { readFile } from "node:fs/promises";

const token = (await readFile(
  "/home/demandsift-dev/actions-runner/.diagnostic-secrets/apify-token",
  "utf8",
)).trim();

if (!token) throw new Error("Apify diagnostic credential is unavailable.");

const headers = {
  accept: "application/json",
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
};

const input = {
  searches: [
    '"project management software" recommendations',
    '"Basecamp alternative"',
    '"work scattered across apps"',
  ],
  ignoreStartUrls: true,
  skipComments: true,
  skipUserPosts: true,
  skipCommunity: true,
  includeMediaLinks: false,
  searchPosts: true,
  searchComments: false,
  searchCommunities: false,
  searchUsers: false,
  searchMedia: false,
  sort: "relevance",
  time: "week",
  includeNSFW: false,
  maxItems: 15,
  maxPostCount: 5,
  maxComments: 0,
  maxCommunitiesCount: 0,
  maxUserCount: 0,
  scrollTimeout: 20,
  navigationTimeout: 30,
  debugMode: false,
  proxy: {
    useApifyProxy: true,
    apifyProxyGroups: ["RESIDENTIAL"],
  },
};

const start = new URL("https://api.apify.com/v2/actors/trudax~reddit-scraper-lite/runs");
start.searchParams.set("waitForFinish", "60");
start.searchParams.set("timeout", "300");
start.searchParams.set("maxItems", String(input.maxItems));
start.searchParams.set("maxTotalChargeUsd", "0.30");

let response = await fetch(start, {
  method: "POST",
  headers,
  body: JSON.stringify(input),
});
let payload = await response.json();
if (!response.ok) {
  throw new Error(`Apify probe start failed with HTTP ${response.status}.`);
}

let run = payload.data;
const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
while (!terminal.has(String(run.status).toUpperCase())) {
  const statusUrl = new URL(`https://api.apify.com/v2/actor-runs/${encodeURIComponent(run.id)}`);
  statusUrl.searchParams.set("waitForFinish", "60");
  response = await fetch(statusUrl, { headers });
  payload = await response.json();
  if (!response.ok) throw new Error(`Apify probe status failed with HTTP ${response.status}.`);
  run = payload.data;
}

if (String(run.status).toUpperCase() !== "SUCCEEDED") {
  throw new Error(`Apify probe ended with ${run.status}: ${run.statusMessage ?? "no status message"}`);
}

const datasetUrl = new URL(
  `https://api.apify.com/v2/datasets/${encodeURIComponent(run.defaultDatasetId)}/items`,
);
datasetUrl.searchParams.set("clean", "true");
datasetUrl.searchParams.set("format", "json");
datasetUrl.searchParams.set("limit", String(input.maxItems));
response = await fetch(datasetUrl, { headers });
const items = await response.json();
if (!response.ok || !Array.isArray(items)) {
  throw new Error(`Apify probe dataset failed with HTTP ${response.status}.`);
}

console.log(JSON.stringify({
  event: "APIFY_SEARCH_PROBE",
  status: run.status,
  itemCount: items.length,
  items: items.map((item) => ({
    id: item.parsedId ?? item.id ?? null,
    title: typeof item.title === "string" ? item.title.slice(0, 180) : null,
    body: typeof item.body === "string" ? item.body.slice(0, 280) : null,
    community: item.parsedCommunityName ?? item.communityName ?? null,
    createdAt: item.createdAt ?? null,
    url: item.url ?? null,
  })),
}, null, 2));
