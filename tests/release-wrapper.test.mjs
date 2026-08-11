import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrapperUrl = new URL("../deploy/demandsift-release", import.meta.url);

test("release wrapper builds from a dedicated linked worktree", async () => {
  const source = await readFile(wrapperUrl, "utf8");

  assert.match(source, /readonly SOURCE_REPOSITORY=\/opt\/demandsift5-pr1/);
  assert.match(source, /readonly REPOSITORY="\$STATE_DIRECTORY\/repository"/);
  assert.match(source, /source_git worktree add --detach "\$REPOSITORY" HEAD/);
  assert.match(source, /\[ -e "\$REPOSITORY\/\.git" \]/);
  assert.doesNotMatch(source, /\[ -d "\$REPOSITORY\/\.git" \]/);
});
