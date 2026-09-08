import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";

/**
 * Real production case: amazon.es's servers respond with
 * Content-Encoding: gzip regardless of this crawler never sending an
 * Accept-Encoding header (Node's raw http/https client, used here
 * instead of fetch() so the crawler can pin an already-validated IP --
 * see fetchPinnedWebsiteTarget's doc comment -- does not auto-negotiate
 * or auto-decompress the way a browser or fetch() does). The raw
 * compressed bytes (starting with the gzip magic number) were being
 * read as UTF-8 "text" -- garbage binary that, once it reached a NUL
 * byte, failed the next Postgres JSONB write with an opaque,
 * unclassified database error instead of ever reaching this crawler's
 * own error handling, so the scan retried indefinitely with no visible
 * failure at all. Reproduced against the real worker logs on the live
 * site before writing this fix.
 *
 * These tests spin up a real local HTTP server (not a fetchImpl mock,
 * which would bypass the exact code path that had the bug) and exercise
 * fetchPinnedWebsiteTarget directly against it, so the fix is verified
 * against Node's actual http client behavior, not a re-mocked
 * substitute of it.
 */

const crawlerSource = await readFile(new URL("../lib/security/website-crawler.ts", import.meta.url), "utf8");
const crawlerJavaScript = ts.transpileModule(crawlerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "website-crawler.ts",
}).outputText;
const crawlerModuleUrl = `data:text/javascript;base64,${Buffer.from(crawlerJavaScript).toString("base64")}`;
const { fetchPinnedWebsiteTarget } = await import(crawlerModuleUrl);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await run(port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function pinnedTarget(port) {
  const url = new URL(`http://127.0.0.1:${port}/`);
  return {
    url,
    target: {
      url,
      canonicalHostname: "127.0.0.1",
      resolvedAddresses: [{ address: "127.0.0.1", family: 4 }],
    },
  };
}

const SAMPLE_HTML = "<html><head><title>Fixture</title></head><body>Real, uncompressed-once-decoded readable page text for the crawler to extract, well over the eighty character minimum it requires.</body></html>";

test("a gzip-encoded response is transparently decompressed, not read as raw compressed bytes", async () => {
  await withServer(
    (_req, res) => {
      const compressed = gzipSync(Buffer.from(SAMPLE_HTML, "utf8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(compressed);
    },
    async (port) => {
      const { url, target } = pinnedTarget(port);
      const response = await fetchPinnedWebsiteTarget(url, { method: "GET" }, target);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.equal(text, SAMPLE_HTML);
      // The header is removed once the body has actually been
      // decompressed -- a passthrough header would incorrectly claim
      // the (now-plain) body is still gzip-encoded.
      assert.equal(response.headers.get("content-encoding"), null);
    },
  );
});

test("a deflate-encoded response is transparently decompressed", async () => {
  await withServer(
    (_req, res) => {
      const compressed = deflateSync(Buffer.from(SAMPLE_HTML, "utf8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "deflate" });
      res.end(compressed);
    },
    async (port) => {
      const { url, target } = pinnedTarget(port);
      const response = await fetchPinnedWebsiteTarget(url, { method: "GET" }, target);
      const text = await response.text();
      assert.equal(text, SAMPLE_HTML);
    },
  );
});

test("a brotli-encoded response is transparently decompressed", async () => {
  await withServer(
    (_req, res) => {
      const compressed = brotliCompressSync(Buffer.from(SAMPLE_HTML, "utf8"));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "br" });
      res.end(compressed);
    },
    async (port) => {
      const { url, target } = pinnedTarget(port);
      const response = await fetchPinnedWebsiteTarget(url, { method: "GET" }, target);
      const text = await response.text();
      assert.equal(text, SAMPLE_HTML);
    },
  );
});

test("an uncompressed response (no content-encoding) is read exactly as before -- the fix does not touch the ordinary case", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SAMPLE_HTML);
    },
    async (port) => {
      const { url, target } = pinnedTarget(port);
      const response = await fetchPinnedWebsiteTarget(url, { method: "GET" }, target);
      const text = await response.text();
      assert.equal(text, SAMPLE_HTML);
      assert.equal(response.headers.get("content-encoding"), null);
    },
  );
});

test("a malformed gzip body (wrong bytes, claimed as gzip) fails the fetch cleanly instead of hanging or crashing the process", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end("this is not actually gzip-compressed data");
    },
    async (port) => {
      const { url, target } = pinnedTarget(port);
      const response = await fetchPinnedWebsiteTarget(url, { method: "GET" }, target);
      // The Response resolves fine (status/headers arrive before the
      // body is read) -- the decompression error surfaces when the body
      // is actually consumed, same as any other stream failure this
      // crawler already handles (see readLimitedText's caller).
      await assert.rejects(response.text());
    },
  );
});
