import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrapperUrl = new URL("../deploy/demandsift-release", import.meta.url);
const webDockerfileUrl = new URL("../deploy/Dockerfile.web", import.meta.url);
const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test("release wrapper builds from a dedicated linked worktree", async () => {
  const source = await readFile(wrapperUrl, "utf8");

  assert.match(source, /readonly SOURCE_REPOSITORY=\/opt\/demandsift5-pr1/);
  assert.match(source, /readonly REPOSITORY="\$STATE_DIRECTORY\/repository"/);
  assert.match(source, /source_git worktree add --detach "\$REPOSITORY" HEAD/);
  assert.match(source, /\[ -e "\$REPOSITORY\/\.git" \]/);
  assert.doesNotMatch(source, /\[ -d "\$REPOSITORY\/\.git" \]/);
});

test("release wrapper exposes only sanitized aggregate scan diagnostics", async () => {
  const source = await readFile(wrapperUrl, "utf8");
  assert.match(source, /diagnose_release\(\)/);
  assert.match(source, /fetchedCandidates/);
  assert.match(source, /uniquePotentialCustomers/);
  assert.doesNotMatch(source, /processedRedditState/);
  assert.doesNotMatch(source, /canonicalPermalink/);
});

test("release wrapper reclaims only unused Docker build artifacts", async () => {
  const source = await readFile(wrapperUrl, "utf8");

  assert.match(source, /reclaim_build_space\(\)/);
  assert.match(source, /npm run build:node/);
  assert.match(source, /docker container rm/);
  assert.match(source, /docker image prune --force/);
  assert.match(source, /docker builder prune --all --force/);
  assert.match(source, /docker build --pull --force-rm/);
  assert.doesNotMatch(source, /docker (?:system|volume|container) prune/);
});

test("release wrapper serializes builds and deployments on the VPS", async () => {
  const source = await readFile(wrapperUrl, "utf8");

  assert.match(source, /readonly RELEASE_LOCK=/);
  assert.match(source, /flock --nonblock 9/);
  assert.match(source, /another release operation is already running/);
});

test("CI queues releases and reclaims only interrupted DemandSift build containers", async () => {
  const source = await readFile(workflowUrl, "utf8");

  assert.match(source, /cancel-in-progress: false/);
  assert.match(source, /status=exited/);
  assert.match(source, /com\.docker\.compose\.project/);
  assert.match(source, /npm run build:node/);
  assert.doesNotMatch(source, /docker (?:system|volume|container) prune/);
});

test("production web image contains only the Vinext standalone runtime", async () => {
  const source = await readFile(webDockerfileUrl, "utf8");

  assert.match(source, /COPY --from=build --chown=node:node \/app\/dist\/standalone \/app\/dist\/standalone/);
  assert.match(source, /\/app\/dist\/standalone\/package\.json \/app\/package\.json/);
  assert.match(source, /CMD \["node", "dist\/standalone\/server\.js"\]/);
  assert.doesNotMatch(source, /COPY --from=build --chown=node:node \/app \/app/);
});
