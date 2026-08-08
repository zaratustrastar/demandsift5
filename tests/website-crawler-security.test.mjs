import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// Node 22.13 is the minimum supported runtime and predates default .ts loading.
// Transpile this isolated module in memory so the test does not depend on a
// newer Node type-stripping flag or create generated files in the workspace.
const crawlerSource = await readFile(
  new URL("../lib/security/website-crawler.ts", import.meta.url),
  "utf8",
);
const crawlerJavaScript = ts.transpileModule(crawlerSource, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "website-crawler.ts",
}).outputText;
const crawlerModuleUrl = `data:text/javascript;base64,${Buffer.from(crawlerJavaScript).toString("base64")}`;
const { createPinnedLookup, crawlWebsite, isPublicIpAddress } = await import(crawlerModuleUrl);

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6 = { address: "2606:4700:4700::1111", family: 6 };

function runLookup(lookup, hostname, options) {
  return new Promise((resolve, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
}

test("IPv6 validation rejects private IPv4 destinations in every embedded spelling", () => {
  const unsafeAddresses = [
    "::127.0.0.1",
    "::10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "0:0:0:0:0:ffff:a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b:1::a00:1",
    "2002:7f00:1::",
  ];

  for (const address of unsafeAddresses) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("IPv6 validation permits native global unicast and rejects special-purpose ranges", () => {
  const publicAddresses = [
    "2001:4860:4860::8888",
    "2606:4700:4700::1111",
    "2620:fe::fe",
    "2a00:1450:4001:801::200e",
  ];
  const nonPublicAddresses = [
    "::",
    "::1",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "3fff::1",
    "4000::1",
    "fc00::1",
    "fd00::1",
    "fe80::1",
    "fe80::1%lo0",
    "ff02::1",
  ];

  for (const address of publicAddresses) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  for (const address of nonPublicAddresses) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
});

test("pinned lookup returns only validated IPv4 and IPv6 addresses", async () => {
  const lookup = createPinnedLookup("example.com", [PUBLIC_V4, PUBLIC_V6]);

  assert.deepEqual(await runLookup(lookup, "example.com", { family: 4 }), {
    address: PUBLIC_V4.address,
    family: 4,
  });
  assert.deepEqual(await runLookup(lookup, "example.com", { family: 6 }), {
    address: PUBLIC_V6.address,
    family: 6,
  });
  assert.deepEqual(await runLookup(lookup, "example.com", { all: true }), {
    address: [PUBLIC_V4, PUBLIC_V6],
    family: undefined,
  });
  await assert.rejects(
    runLookup(lookup, "attacker.example", {}),
    (error) => error.code === "ENOTFOUND",
  );
});

test("each same-domain redirect is revalidated and passed to the pinned transport", async () => {
  const resolvedByHost = {
    "example.com": [PUBLIC_V4],
    "www.example.com": [PUBLIC_V6],
  };
  const resolverCalls = [];
  const fetchCalls = [];
  const resolver = async (hostname) => {
    resolverCalls.push(hostname);
    return resolvedByHost[hostname] ?? [];
  };
  const fetchImpl = async (url, init, target) => {
    fetchCalls.push({
      url: url.toString(),
      redirect: init.redirect,
      addresses: target.resolvedAddresses,
    });
    if (fetchCalls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://www.example.com/about" },
      });
    }
    return new Response(
      "<html><title>About</title><body>This is a sufficiently long public business page with useful product, audience, and customer problem information for analysis.</body></html>",
      { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  const result = await crawlWebsite("https://example.com", {
    fetchImpl,
    maxPages: 1,
    resolver,
  });

  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].url, "https://www.example.com/about");
  assert.deepEqual(fetchCalls, [
    {
      url: "https://example.com/",
      redirect: "manual",
      addresses: [PUBLIC_V4],
    },
    {
      url: "https://www.example.com/about",
      redirect: "manual",
      addresses: [PUBLIC_V6],
    },
  ]);
  assert.deepEqual(resolverCalls, ["example.com", "example.com", "www.example.com"]);
});

test("public metadata can support analysis when a JavaScript shell has little body text", async () => {
  const result = await crawlWebsite("https://example.com", {
    maxPages: 1,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: async () => new Response(`
      <html>
        <head>
          <title>Acme Router</title>
          <meta property="og:description" content="Acme routes AI workloads to lower-cost model capacity while preserving one compatible API for application teams.">
          <script type="application/ld+json">{
            "@type": "SoftwareApplication",
            "name": "Acme Router",
            "featureList": ["Cost-aware model routing", "Usage reporting"]
          }</script>
        </head>
        <body><div id="app"></div><script src="/client.js"></script></body>
      </html>
    `, { status: 200, headers: { "content-type": "text/html" } }),
  });

  assert.equal(result.pages.length, 1);
  assert.match(result.pages[0].text, /lower-cost model capacity/);
  assert.match(result.pages[0].text, /Cost-aware model routing/);
});

test("a private rebinding answer is rejected before the transport runs", async () => {
  let resolutions = 0;
  let fetchCalls = 0;
  const resolver = async () => {
    resolutions += 1;
    return resolutions === 1 ? [PUBLIC_V4] : [{ address: "127.0.0.1", family: 4 }];
  };

  await assert.rejects(
    crawlWebsite("https://example.com", {
      resolver,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("transport must not run");
      },
    }),
    /public internet addresses/,
  );
  assert.equal(fetchCalls, 0);
});

test("cross-domain redirects are rejected before resolving or fetching the new host", async () => {
  const resolverCalls = [];
  let fetchCalls = 0;
  await assert.rejects(
    crawlWebsite("https://example.com", {
      resolver: async (hostname) => {
        resolverCalls.push(hostname);
        return [PUBLIC_V4];
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: "https://attacker.example/collect" },
        });
      },
    }),
    /redirected outside the submitted domain/,
  );
  assert.equal(fetchCalls, 1);
  assert.deepEqual(resolverCalls, ["example.com", "example.com"]);
});

test("response byte limits still cancel oversized bodies", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    crawlWebsite("https://example.com", {
      maxResponseBytes: 32_000,
      resolver: async () => [PUBLIC_V4],
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: {
          "content-length": "32001",
          "content-type": "text/html",
        },
      }),
    }),
    /32000-byte response limit/,
  );
  assert.equal(cancelled, true);
});
