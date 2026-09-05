import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compileRedditOAuth() {
  let source = await readFile(
    new URL("../lib/server/reddit-oauth.ts", import.meta.url),
    "utf8",
  );
  const repositoryModule = moduleUrl(`
    const connections = new Map();
    export function getStateRepository() {
      return {
        async saveRedditConnection(record) { connections.set(record.workspaceId, record); },
        async getRedditConnection(workspaceId) { return connections.get(workspaceId) ?? null; },
      };
    }
  `);
  source = source.replaceAll('"./repository"', JSON.stringify(repositoryModule));
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "reddit-oauth.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const reddit = await compileRedditOAuth();
const validEnvironment = {
  REDDIT_OAUTH_ENABLED: "true",
  APP_URL: "https://app.example.com",
  REDDIT_CLIENT_ID: "client-id",
  REDDIT_CLIENT_SECRET: "client-secret",
  REDDIT_REDIRECT_URI: "https://app.example.com/api/reddit/callback",
  REDDIT_USER_AGENT: "web:com.demandsift.test:v0.1.0 (by /u/test_owner)",
  REDDIT_TOKEN_ENCRYPTION_KEY: "11".repeat(32),
  REDDIT_OAUTH_STATE_SECRET: "state-secret-".repeat(4),
};

test("keeps Reddit OAuth disabled unless explicitly enabled", async () => {
  assert.equal(await reddit.redditOAuthConfiguration({}), null);
  await assert.rejects(
    reddit.redditOAuthConfiguration({
      ...validEnvironment,
      REDDIT_REDIRECT_URI: "http://143.244.154.139/api/reddit/callback",
    }),
    /must be HTTPS/,
  );
});

test("signs workspace-bound OAuth state and rejects tampering", async () => {
  const configuration = await reddit.redditOAuthConfiguration(validEnvironment);
  const state = await reddit.createRedditOAuthState(
    "ws_workspace123",
    "scan_scan123",
    configuration,
  );
  const payload = await reddit.verifyRedditOAuthState(state, configuration);
  assert.equal(payload.workspaceId, "ws_workspace123");
  assert.equal(payload.scanId, "scan_scan123");
  const [encoded, signature] = state.split(".");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const canonicalLastIndex = alphabet.indexOf(signature.at(-1));
  const nonCanonicalSignature = `${signature.slice(0, -1)}${alphabet[canonicalLastIndex + 1]}`;
  await assert.rejects(
    reddit.verifyRedditOAuthState(`${encoded}.${nonCanonicalSignature}`, configuration),
    /invalid/,
  );
});

test("encrypts Reddit tokens with workspace and token-kind binding", async () => {
  const configuration = await reddit.redditOAuthConfiguration(validEnvironment);
  const ciphertext = await reddit.encryptRedditToken(
    "private-refresh-token",
    "ws_workspace123",
    "refresh",
    configuration,
  );
  assert.doesNotMatch(ciphertext, /private-refresh-token/);
  assert.equal(
    await reddit.decryptRedditToken(
      ciphertext,
      "ws_workspace123",
      "refresh",
      configuration,
    ),
    "private-refresh-token",
  );
  await assert.rejects(
    reddit.decryptRedditToken(
      ciphertext,
      "ws_different123",
      "refresh",
      configuration,
    ),
    /could not be decrypted/,
  );
});

test("builds permanent identity/submit authorization and posts an exact fullname", async () => {
  const configuration = await reddit.redditOAuthConfiguration(validEnvironment);
  const authorization = new URL(
    await reddit.redditAuthorizationUrl("ws_workspace123", null, configuration),
  );
  assert.equal(authorization.origin, "https://www.reddit.com");
  assert.equal(authorization.searchParams.get("duration"), "permanent");
  assert.deepEqual(
    new Set(authorization.searchParams.get("scope").split(" ")),
    new Set(["identity", "submit"]),
  );

  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init };
    return new Response(JSON.stringify({
      json: {
        errors: [],
        data: {
          things: [{
            data: {
              id: "comment123",
              name: "t1_comment123",
              permalink: "/r/SaaS/comments/post123/example/comment123/",
            },
          }],
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await reddit.submitRedditComment({
      accessToken: "access-token",
      redditThingId: "t3_post123",
      text: "A reviewed source-grounded response.",
      configuration,
    });
    assert.equal(request.url, "https://oauth.reddit.com/api/comment");
    assert.equal(new Headers(request.init.headers).get("authorization"), "Bearer access-token");
    const form = new URLSearchParams(request.init.body);
    assert.equal(form.get("thing_id"), "t3_post123");
    assert.equal(form.get("text"), "A reviewed source-grounded response.");
    assert.equal(result.commentId, "comment123");
    assert.equal(
      result.url,
      "https://www.reddit.com/r/SaaS/comments/post123/example/comment123/",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
