import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

globalThis.crypto ??= webcrypto;

async function compileTypeScriptModuleUrl(relativePath, replacements = {}) {
  let source = await readFile(new URL(relativePath, import.meta.url), "utf8");
  for (const [specifier, replacement] of Object.entries(replacements)) {
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  }
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: relativePath,
  }).outputText;
  return `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
}

const runtimeEnvModuleUrl = await compileTypeScriptModuleUrl("../lib/server/runtime-env.ts");
const runtimeImport = { "@/lib/server/runtime-env": runtimeEnvModuleUrl };
const [runtimeEnvModule, emailModule, storageModule, analyticsModule] = await Promise.all([
  import(runtimeEnvModuleUrl),
  import(await compileTypeScriptModuleUrl("../lib/providers/email.server.ts", runtimeImport)),
  import(await compileTypeScriptModuleUrl("../lib/providers/storage.server.ts", runtimeImport)),
  import(await compileTypeScriptModuleUrl("../lib/providers/analytics.server.ts", runtimeImport)),
]);

test("console email is idempotent and never logs message data", async () => {
  const logs = [];
  const provider = new emailModule.ConsoleEmailProvider((entry) => logs.push(entry));
  const message = {
    to: "private.person@example.com",
    subject: "Confidential launch subject",
    text: "Secret body that must never reach logs",
    html: "<p>Secret HTML that must never reach logs</p>",
    idempotencyKey: "private-person-launch-email",
  };
  const first = await provider.send(message);
  const second = await provider.send(message);
  assert.deepEqual(second, first);
  assert.equal(logs.length, 1);
  const output = logs.join("\n");
  for (const secret of [message.to, message.subject, message.text, message.html, message.idempotencyKey]) {
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(output, /local_email_accepted/);
});

test("in-memory storage copies bytes, supports streams, and enforces limits", async () => {
  const provider = new storageModule.InMemoryStorageProvider(8);
  const source = new Uint8Array([1, 2, 3]);
  const stored = await provider.put("safe/object.bin", source, "application/octet-stream");
  source[0] = 99;
  assert.equal(stored.size, 3);
  assert.equal(stored.etag.length, 64);

  const loaded = await provider.get("safe/object.bin");
  assert.ok(loaded);
  assert.deepEqual(new Uint8Array(await new Response(loaded).arrayBuffer()), new Uint8Array([1, 2, 3]));

  await provider.put(
    "safe/stream.txt",
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    }),
    "text/plain; charset=utf-8",
  );
  await assert.rejects(
    provider.put("too-large", new Uint8Array(9), "application/octet-stream"),
    /size limit/,
  );
  await provider.delete("safe/object.bin");
  assert.equal(await provider.get("safe/object.bin"), null);
});

test("console analytics emits bounded metadata without raw identifiers or properties", async () => {
  const logs = [];
  const provider = new analyticsModule.ConsoleAnalyticsProvider((entry) => logs.push(entry));
  await provider.capture({
    name: "Reply.Published",
    workspaceId: "workspace-private-123",
    businessId: "business-private-456",
    actorId: "actor-private-789",
    occurredAt: "2026-08-05T12:00:00.000Z",
    properties: {
      email: "private.person@example.com",
      destinationUrl: "https://example.com/private-path",
      conversionValue: 1200,
      secretToken: "bearer-secret",
    },
  });
  assert.equal(logs.length, 1);
  assert.ok(logs[0].length <= 1_024);
  for (const secret of [
    "workspace-private-123",
    "business-private-456",
    "actor-private-789",
    "private.person@example.com",
    "destinationUrl",
    "https://example.com/private-path",
    "secretToken",
    "bearer-secret",
  ]) {
    assert.equal(logs[0].includes(secret), false, secret);
  }
  const parsed = JSON.parse(logs[0]);
  assert.equal(parsed.name, "reply.published");
  assert.deepEqual(parsed.propertyTypes, {
    boolean: 0,
    number: 1,
    string: 3,
    null: 0,
    omitted: 0,
  });
});

test("local factories fail closed in production and accept registered providers", () => {
  assert.throws(
    () => emailModule.createEmailProviderFromEnv({ NODE_ENV: "production" }),
    /EMAIL_PROVIDER/,
  );
  assert.throws(
    () => emailModule.createEmailProviderFromEnv({ NODE_ENV: "production", EMAIL_PROVIDER: "console" }),
    /disabled in production/,
  );
  assert.throws(
    () => storageModule.createStorageProviderFromEnv({ NODE_ENV: "production", STORAGE_PROVIDER: "local" }),
    /disabled in production/,
  );
  assert.throws(
    () => analyticsModule.createAnalyticsProviderFromEnv({ NODE_ENV: "production", ANALYTICS_PROVIDER: "console" }),
    /disabled in production/,
  );

  const productionEmail = { name: "production-email", async send() { return { providerMessageId: "id" }; } };
  const selected = emailModule.createEmailProviderFromEnv(
    { NODE_ENV: "production", EMAIL_PROVIDER: "registered" },
    { registered: productionEmail },
  );
  assert.equal(selected, productionEmail);
  assert.equal(emailModule.createEmailProviderFromEnv({ NODE_ENV: "development" }).name, "console-email");
  assert.equal(storageModule.createStorageProviderFromEnv({ NODE_ENV: "test" }).name, "memory-storage");
  assert.equal(analyticsModule.createAnalyticsProviderFromEnv({ NODE_ENV: "development" }).name, "console-analytics");
});

test("explicit runtime environment overrides a bundled NODE_ENV safely", () => {
  assert.equal(
    runtimeEnvModule.runtimeEnvironment({ NODE_ENV: "production", APP_RUNTIME_ENV: "development" }),
    "development",
  );
  assert.equal(
    emailModule.createEmailProviderFromEnv({
      NODE_ENV: "production",
      APP_RUNTIME_ENV: "development",
    }).name,
    "console-email",
  );
  assert.throws(
    () => storageModule.createStorageProviderFromEnv({
      NODE_ENV: "development",
      APP_RUNTIME_ENV: "production",
      STORAGE_PROVIDER: "local",
    }),
    /disabled in production/,
  );
  assert.throws(
    () => runtimeEnvModule.runtimeEnvironment({ APP_RUNTIME_ENV: "staging" }),
    /APP_RUNTIME_ENV/,
  );
});
