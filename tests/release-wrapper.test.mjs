import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrapperUrl = new URL("../deploy/demandsift-release", import.meta.url);
const webDockerfileUrl = new URL("../deploy/Dockerfile.web", import.meta.url);

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
  assert.match(source, /docker image prune --force/);
  assert.match(source, /docker builder prune --all --force/);
  assert.doesNotMatch(source, /docker (?:system|volume|container) prune/);
});

test("production web image contains only the Vinext standalone runtime", async () => {
  const source = await readFile(webDockerfileUrl, "utf8");

  assert.match(source, /COPY --from=build --chown=node:node \/app\/dist\/standalone \/app\/dist\/standalone/);
  assert.match(source, /CMD \["node", "dist\/standalone\/server\.js"\]/);
  assert.doesNotMatch(source, /COPY --from=build --chown=node:node \/app \/app/);
});
