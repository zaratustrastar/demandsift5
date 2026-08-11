import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrapperUrl = new URL("../deploy/demandsift-release", import.meta.url);

test("release wrapper accepts linked Git worktrees", async () => {
  const source = await readFile(wrapperUrl, "utf8");

  assert.match(source, /\[ -e "\$REPOSITORY\/\.git" \]/);
  assert.doesNotMatch(source, /\[ -d "\$REPOSITORY\/\.git" \]/);
});
