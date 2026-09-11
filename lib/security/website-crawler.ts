import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import type { WebsiteEvidencePage } from "@/lib/providers/contracts";
import type { Browser } from "puppeteer-core";

const DEFAULT_MAX_PAGES = 6;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_TOTAL_BYTES = 4_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_RENDER_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;

const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home",
  ".lan",
  ".test",
  ".invalid",
  ".example",
  ".onion",
] as const;

const NON_CONTENT_PATH = /\/(?:api|admin|login|logout|sign-?in|sign-?out|cart|checkout|account)(?:\/|$)/i;
const BINARY_EXTENSION = /\.(?:avif|bmp|css|csv|docx?|gif|ico|jpe?g|js|json|mp3|mp4|mov|pdf|png|pptx?|rss|svg|tar|txt|webm|webp|xlsx?|xml|zip)$/i;

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface ValidatedWebsiteTarget {
  url: URL;
  canonicalHostname: string;
  resolvedAddresses: ResolvedAddress[];
}

export interface CrawlFailure {
  url: string;
  reason: string;
  /** True when this specific page failed with a PermanentWebsiteFetchError
   * (401/403/404/410/451) rather than a plain (potentially transient)
   * Error -- lets the final all-pages-failed throw below preserve that
   * distinction instead of collapsing every failure into one generic
   * Error, which is what silently defeated retry classification for a
   * persistent 403 in a real production incident. */
  permanent: boolean;
  status?: number;
}

export interface WebsiteCrawlResult {
  requestedUrl: string;
  canonicalUrl: string;
  canonicalDomain: string;
  pages: WebsiteEvidencePage[];
  failures: CrawlFailure[];
  totalBytes: number;
}

/**
 * One page's full timing/diagnostic breakdown, emitted as each page
 * finishes (success or failure) so a caller can attribute a slow crawl to
 * a specific cause instead of only seeing one lump total. Deliberately a
 * plain callback rather than requiring the scan-observability TraceEvent
 * shape directly: this module has no dependency on that package, and
 * analyzeOneCompetitor (lib/server/competitor-analysis.ts) calls
 * crawlWebsite with no ScanTrace in scope at all.
 */
export interface PageCrawlTrace {
  url: string;
  staticFetchMs: number;
  staticChars: number;
  headlessTriggered: boolean;
  browserStartupMs?: number;
  renderMs?: number;
  completionReason?: "content-ready" | "networkidle2" | "timeout";
  finalChars: number;
  totalMs: number;
  outcome: "succeeded" | "failed";
}

export interface CrawlWebsiteOptions {
  maxPages?: number;
  maxResponseBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  renderTimeoutMs?: number;
  userAgent?: string;
  fetchImpl?: PinnedWebsiteFetch;
  renderImpl?: HeadlessRenderFn;
  resolver?: HostResolver;
  signal?: AbortSignal;
  onPageTrace?: (event: PageCrawlTrace) => void;
}

/**
 * A testable transport boundary. Production uses the built-in pinned
 * implementation below; custom implementations receive the exact target that
 * was validated for this request and must not perform their own DNS lookup.
 */
export type PinnedWebsiteFetch = (
  input: URL,
  init: RequestInit,
  target: ValidatedWebsiteTarget,
) => Promise<Response>;

export class UnsafeWebsiteUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeWebsiteUrlError";
  }
}

/**
 * Thrown for an HTTP status that retrying can never fix: the site
 * actively refused or doesn't have the page, not a transient network/
 * server condition. Distinct from a plain Error specifically so callers
 * (scan-workflow.ts's retry loop, job-retry-classification.ts's queue-
 * level disposition) can tell "retrying this is pointless" apart from
 * "retrying this might work" (429, 5xx, timeouts, DNS hiccups -- all of
 * which stay a plain Error and remain retryable, per the same
 * distinction this file already draws for SSRF-unsafe URLs).
 */
export class PermanentWebsiteFetchError extends Error {
  readonly status: number;
  /** Recognized directly by lib/server/job-retry-classification.ts's
   * scanPipelineErrorCode (which checks error.code before falling back
   * to message-pattern matching) so this reaches
   * JOB_LEVEL_TERMINAL_ERROR_CODES without needing a fragile regex
   * against this error's message text. */
  readonly code = "website_permanently_unreachable";
  constructor(status: number) {
    super(`Website returned HTTP ${status}.`);
    this.name = "PermanentWebsiteFetchError";
    this.status = status;
  }
}

/** 401/403: the site is actively refusing the crawler (auth wall, bot
 * block). 404/410: the page doesn't exist. 451: blocked for legal
 * reasons. None of these change on retry -- the site's answer is the
 * site's answer. Everything else (429, 5xx, and anything not in this
 * set) stays retryable, since those can genuinely be transient. */
const PERMANENT_HTTP_STATUS_CODES = new Set([401, 403, 404, 410, 451]);

/**
 * A non-2xx status that isn't in PERMANENT_HTTP_STATUS_CODES above --
 * still assumed retryable on its own, but carries the status (unlike a
 * plain Error) so a caller that sees the *same* status recur across
 * consecutive attempts can tell that apart from an ordinary one-off
 * blip. That distinction matters chiefly for 503: real production case,
 * amazon.com answers every single request with HTTP 503 rather than
 * 403 -- functionally the same permanent bot-block, just spelled with a
 * status this file cannot treat as unconditionally permanent, since a
 * 503 from a site having one genuinely bad moment is common and should
 * still get its normal retries. See scan-workflow.ts's
 * runFullWebsiteUnderstanding, which promotes a repeated status from
 * this class to PermanentWebsiteFetchError.
 */
export class WebsiteFetchStatusError extends Error {
  readonly status: number;
  /** message defaults to the same bare "Website returned HTTP NNN."
   * text a single page's fetch failure already used (still what
   * populates failures[].reason above) -- callers that need the fuller
   * "Website analysis could not read the site: ..." wrapper (see
   * crawlWebsite's final aggregation below) pass it explicitly so this
   * class's introduction doesn't change any user-facing message text,
   * only which errors carry a structured status. */
  constructor(status: number, message?: string) {
    super(message ?? `Website returned HTTP ${status}.`);
    this.name = "WebsiteFetchStatusError";
    this.status = status;
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLocaleLowerCase("en-US").replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function canonicalHostname(hostname: string): string {
  const normalized = normalizeHostname(hostname);
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

function equivalentWebsiteHost(left: string, right: string): boolean {
  return canonicalHostname(left) === canonicalHostname(right);
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => Number.parseInt(part, 10));
  return numbers.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? numbers
    : null;
}

function isPublicIpv4(address: string): boolean {
  const parts = parseIpv4(address);
  if (!parts) return false;
  const [a, b, c, d] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return !(a === 255 && b === 255 && c === 255 && d === 255);
}

function parseIpv6Hextets(address: string): number[] | null {
  if (address.includes("%") || isIP(address) !== 6) return null;

  let normalized = address.toLocaleLowerCase("en-US");
  const finalColon = normalized.lastIndexOf(":");
  const possibleIpv4Tail = normalized.slice(finalColon + 1);

  // IPv6 permits a dotted IPv4 tail (for example ::ffff:127.0.0.1).
  // Convert it to two hextets before expanding :: so every textual spelling
  // has one canonical structural representation for the range checks below.
  if (possibleIpv4Tail.includes(".")) {
    if (isIP(possibleIpv4Tail) !== 4) return null;
    const octets = parseIpv4(possibleIpv4Tail);
    if (!octets) return null;
    normalized = `${normalized.slice(0, finalColon)}:${(
      (octets[0] << 8) | octets[1]
    ).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const compressedParts = normalized.split("::");
  if (compressedParts.length > 2) return null;

  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const tokens = part.split(":");
    if (tokens.some((token) => !/^[\da-f]{1,4}$/.test(token))) return null;
    return tokens.map((token) => Number.parseInt(token, 16));
  };

  const left = parsePart(compressedParts[0]);
  const right = parsePart(compressedParts[1] ?? "");
  if (!left || !right) return null;

  if (compressedParts.length === 1) {
    return left.length === 8 ? left : null;
  }

  const omittedHextets = 8 - left.length - right.length;
  if (omittedHextets < 1) return null;
  return [...left, ...Array<number>(omittedHextets).fill(0), ...right];
}

function matchesIpv6Prefix(
  address: readonly number[],
  prefix: readonly number[],
  prefixLength: number,
): boolean {
  const completeHextets = Math.floor(prefixLength / 16);
  for (let index = 0; index < completeHextets; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }

  const remainingBits = prefixLength % 16;
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (address[completeHextets] & mask) === (prefix[completeHextets] & mask);
}

function isPublicIpv6(address: string): boolean {
  const hextets = parseIpv6Hextets(address);
  if (!hextets) return false;

  // IANA currently allocates globally routable unicast IPv6 space from
  // 2000::/3. Requiring that range rejects mapped/compatible IPv4 addresses,
  // NAT64, ULA, link-local, multicast, discard-only, and reserved space even
  // when an address uses an unexpected compressed or expanded spelling.
  if (!matchesIpv6Prefix(hextets, [0x2000], 3)) return false;

  // Exclude special-purpose ranges that sit inside 2000::/3. Blocking the
  // whole 2001::/23 protocol-assignment block is deliberately conservative;
  // ordinary business-site addresses remain available elsewhere in 2000::/3.
  const nonPublicPrefixes: ReadonlyArray<readonly [readonly number[], number]> = [
    [[0x2001, 0x0000], 23], // IETF protocol assignments, including Teredo.
    [[0x2001, 0x0db8], 32], // Documentation.
    [[0x2002], 16], // 6to4, whose route embeds an IPv4 destination.
    [[0x3fff, 0x0000], 20], // Documentation.
  ];

  return !nonPublicPrefixes.some(([prefix, length]) =>
    matchesIpv6Prefix(hextets, prefix, length));
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function defaultResolver(hostname: string): Promise<ResolvedAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function parseInputUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new UnsafeWebsiteUrlError("A website URL is required.");
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new UnsafeWebsiteUrlError("The website URL is not valid.");
  }
  return parsed;
}

/** Validates protocol, hostname, port, and every DNS answer before a request. */
export async function validatePublicWebsiteUrl(
  input: string | URL,
  resolver: HostResolver = defaultResolver,
): Promise<ValidatedWebsiteTarget> {
  const url = typeof input === "string" ? parseInputUrl(input) : new URL(input.toString());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeWebsiteUrlError("Only HTTP and HTTPS website URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new UnsafeWebsiteUrlError("Website URLs cannot contain credentials.");
  }
  if ((url.protocol === "https:" && url.port && url.port !== "443") ||
      (url.protocol === "http:" && url.port && url.port !== "80")) {
    throw new UnsafeWebsiteUrlError("Non-standard website ports are not allowed.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || hostname === "localhost" || BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new UnsafeWebsiteUrlError("Local and reserved hostnames are not allowed.");
  }
  // Business scans require a domain. Rejecting IP literals also removes several
  // ambiguous IPv4/IPv6 URL forms used to bypass SSRF filters.
  if (isIP(hostname) !== 0) {
    throw new UnsafeWebsiteUrlError("IP-address website URLs are not allowed.");
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new UnsafeWebsiteUrlError("The website hostname could not be resolved.");
  }
  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => address.includes("%") || !isPublicIpAddress(address))
  ) {
    throw new UnsafeWebsiteUrlError("The website must resolve only to public internet addresses.");
  }

  // Trust the address syntax rather than a resolver-supplied family value. A
  // mismatched family can otherwise cause the socket layer to reinterpret the
  // validated address.
  const resolvedAddresses = addresses.map(({ address }) => ({ address, family: isIP(address) }));

  url.hash = "";
  return { url, canonicalHostname: canonicalHostname(hostname), resolvedAddresses };
}

function lookupError(message: string, code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

function requestedAddressFamily(family: number | string | undefined): number {
  if (family === 4 || family === "IPv4") return 4;
  if (family === 6 || family === "IPv6") return 6;
  return 0;
}

/**
 * Creates a socket lookup function that never consults DNS. Only addresses
 * from the immediately preceding validation may reach the network layer.
 */
export function createPinnedLookup(
  expectedHostname: string,
  resolvedAddresses: readonly ResolvedAddress[],
): LookupFunction {
  const expected = normalizeHostname(expectedHostname);
  const pinned = resolvedAddresses.map(({ address, family }) => ({ address, family }));

  return (hostname, options, callback) => {
    if (normalizeHostname(hostname) !== expected) {
      callback(
        lookupError("The socket requested an unexpected hostname.", "ENOTFOUND"),
        "",
        0,
      );
      return;
    }

    const family = requestedAddressFamily(options.family);
    const candidates = family === 0 ? pinned : pinned.filter((entry) => entry.family === family);
    if (candidates.length === 0) {
      callback(
        lookupError("No validated address is available for the requested family.", "EAI_ADDRFAMILY"),
        "",
        0,
      );
      return;
    }

    if (options.all) {
      callback(null, candidates.map((entry) => ({ ...entry })));
      return;
    }
    callback(null, candidates[0].address, candidates[0].family);
  };
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.append(name, value);
    }
  }
  return result;
}

/**
 * Fetches one already-validated target without another DNS resolution. Passing
 * the original URL to request() preserves its Host header; HTTPS additionally
 * pins SNI/certificate verification to that hostname while lookup supplies the
 * validated network address.
 */
export async function fetchPinnedWebsiteTarget(
  input: URL,
  init: RequestInit,
  target: ValidatedWebsiteTarget,
): Promise<Response> {
  if (
    normalizeHostname(input.hostname) !== normalizeHostname(target.url.hostname) ||
    input.protocol !== target.url.protocol ||
    input.port !== target.url.port
  ) {
    throw new UnsafeWebsiteUrlError("The validated website target did not match the request URL.");
  }

  const headers = new Headers(init.headers);
  // The URL controls the authority. Never allow a caller-supplied Host header
  // to diverge from the hostname used for validation and TLS.
  headers.delete("host");
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    requestHeaders[name] = value;
  });
  const lookupPinnedAddress = createPinnedLookup(input.hostname, target.resolvedAddresses);
  const method = init.method ?? "GET";
  if (method !== "GET" || init.body !== undefined) {
    throw new Error("The website crawler transport only supports GET requests without a body.");
  }

  return new Promise<Response>((resolvePromise, rejectPromise) => {
    const requestOptions = {
      agent: false,
      // Let Node race the already-validated A and AAAA answers when both are
      // available. The custom lookup still prevents any new DNS resolution.
      autoSelectFamily: true,
      headers: requestHeaders,
      lookup: lookupPinnedAddress,
      method,
      signal: init.signal ?? undefined,
    };
    const request = input.protocol === "https:"
      ? httpsRequest(input, {
          ...requestOptions,
          rejectUnauthorized: true,
          servername: normalizeHostname(input.hostname),
        })
      : httpRequest(input, requestOptions);

    request.once("error", rejectPromise);
    request.once("response", (incoming) => {
      const status = incoming.statusCode;
      if (!status) {
        incoming.destroy();
        rejectPromise(new Error("Website returned a response without an HTTP status."));
        return;
      }

      const bodyForbidden = status === 204 || status === 205 || status === 304;
      if (bodyForbidden) incoming.resume();
      // Node's raw http/https client (used here, not the global fetch(),
      // so the already-validated pinned IP can be used without a second
      // DNS lookup -- see this function's doc comment) does not
      // auto-decompress a response the way a browser or fetch() does.
      // Real production case: amazon.es's servers gzip-compress their
      // response regardless of this crawler never sending an
      // Accept-Encoding header, so the raw compressed bytes (starting
      // with the gzip magic number) were being read as UTF-8 "text" --
      // garbage binary that, once it reached a NUL byte, failed the next
      // Postgres JSONB write with an opaque, unclassified database error
      // (code 22P05) instead of ever reaching any of this crawler's own
      // error handling, so the scan retried indefinitely with no visible
      // failure at all. Decompress here, based on whatever
      // Content-Encoding the server actually used, before any of that.
      const contentEncoding = Array.isArray(incoming.headers["content-encoding"])
        ? incoming.headers["content-encoding"][0]
        : incoming.headers["content-encoding"];
      const encoding = (contentEncoding ?? "").trim().toLowerCase();
      let decoded: Readable = incoming;
      if (!bodyForbidden && (encoding === "gzip" || encoding === "x-gzip")) {
        decoded = incoming.pipe(createGunzip());
      } else if (!bodyForbidden && encoding === "deflate") {
        decoded = incoming.pipe(createInflate());
      } else if (!bodyForbidden && encoding === "br") {
        decoded = incoming.pipe(createBrotliDecompress());
      }
      // .pipe() does not forward source errors to the destination --
      // without this, a connection drop mid-response would silently
      // truncate the decompressed stream instead of surfacing as a
      // fetch failure the same way it already does in the uncompressed
      // case.
      if (decoded !== incoming) incoming.once("error", (error) => decoded.destroy(error));
      const body = bodyForbidden
        ? null
        : Readable.toWeb(decoded) as ReadableStream<Uint8Array>;
      const headers = responseHeaders(incoming.headers);
      // The body reaching consumers below is now decompressed (or was
      // never compressed) either way -- a passthrough content-encoding
      // header would incorrectly claim otherwise, matching how a real
      // fetch()/browser client already hides this header once it has
      // handled the encoding transparently.
      headers.delete("content-encoding");
      try {
        resolvePromise(
          new Response(body, {
            headers,
            status,
            statusText: incoming.statusMessage,
          }),
        );
      } catch (error) {
        incoming.destroy();
        rejectPromise(error);
      }
    });
    request.end();
  });
}

interface SafeFetchOptions {
  allowedHostname: string;
  timeoutMs: number;
  userAgent: string;
  fetchImpl: PinnedWebsiteFetch;
  resolver: HostResolver;
  signal?: AbortSignal;
}

async function fetchWithValidatedRedirects(
  initialUrl: URL,
  options: SafeFetchOptions,
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = new URL(initialUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!equivalentWebsiteHost(currentUrl.hostname, options.allowedHostname)) {
      throw new UnsafeWebsiteUrlError("The website redirected outside the submitted domain.");
    }
    const target = await validatePublicWebsiteUrl(currentUrl, options.resolver);
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([timeoutSignal, options.signal])
      : timeoutSignal;
    const response = await options.fetchImpl(
      currentUrl,
      {
        method: "GET",
        redirect: "manual",
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml;q=0.9",
          "accept-language": "en,*;q=0.5",
          "user-agent": options.userAgent,
        },
      },
      target,
    );

    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: currentUrl };
    }
    const location = response.headers.get("location");
    if (!location) {
      await response.body?.cancel("Redirect did not include a location.");
      throw new Error(`Redirect ${response.status} did not include a location.`);
    }
    await response.body?.cancel("Redirect response body is not crawled.");
    currentUrl = new URL(location, currentUrl);
  }
  throw new Error(`Website exceeded the ${MAX_REDIRECTS}-redirect limit.`);
}

async function readLimitedText(response: Response, byteLimit: number): Promise<{ text: string; bytes: number }> {
  // Large marketing pages often include several megabytes of hydration data,
  // images encoded in markup, or localization payloads after the useful public
  // copy. Read only a bounded prefix instead of rejecting the whole page from
  // Content-Length. The byte limit remains a hard memory/network boundary: the
  // stream is cancelled as soon as the prefix is full.
  if (!response.body) return { text: "", bytes: 0 };

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const remaining = byteLimit - bytes;
    if (result.value.byteLength >= remaining) {
      if (remaining > 0) {
        chunks.push(result.value.slice(0, remaining));
        bytes += remaining;
      }
      await reader.cancel("Response exceeded crawler byte limit.");
      break;
    }
    bytes += result.value.byteLength;
    chunks.push(result.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8").decode(body), bytes };
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  };
  return value.replace(/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi, (entity, decimal, hex, name) => {
    if (decimal) return String.fromCodePoint(Number.parseInt(decimal, 10));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    return named[String(name).toLocaleLowerCase("en-US")] ?? entity;
  });
}

function capture(html: string, expression: RegExp): string | undefined {
  const value = expression.exec(html)?.[1];
  return value ? decodeHtmlEntities(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() : undefined;
}

function htmlAttribute(tag: string, name: string): string | undefined {
  const expression = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i");
  const value = expression.exec(tag)?.[2];
  return value ? decodeHtmlEntities(value).replace(/\s+/g, " ").trim() : undefined;
}

function metaContent(html: string, names: readonly string[]): string | undefined {
  const accepted = new Set(names.map((name) => name.toLowerCase()));
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = htmlAttribute(tag, "name") ?? htmlAttribute(tag, "property") ?? htmlAttribute(tag, "itemprop");
    const content = htmlAttribute(tag, "content");
    if (key && content && accepted.has(key.toLowerCase())) return content;
  }
  return undefined;
}

function extractJsonLdEvidence(html: string): string[] {
  const evidence: string[] = [];
  const acceptedKeys = new Set([
    "about", "audience", "description", "featurelist", "headline", "name", "servicetype",
  ]);
  const visit = (value: unknown, key = "", depth = 0) => {
    if (depth > 6 || evidence.length >= 24 || value === null) return;
    if (typeof value === "string") {
      const cleaned = value.replace(/\s+/g, " ").trim();
      if (acceptedKeys.has(key.toLowerCase()) && cleaned.length >= 3 && cleaned.length <= 600) {
        evidence.push(cleaned);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  for (const match of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(match[1]) as unknown);
    } catch {
      // Invalid public structured data is ignored; it never stops the crawl.
    }
  }
  return evidence;
}

/** Identity signals kept separate from the combined `text` blob
 * specifically for callers (currently only
 * lib/server/competitor-url-resolution.ts) that need to inspect og:title/
 * og:site_name/application-name individually -- e.g. to diagnose why an
 * identity check did or didn't match, rather than only having the single
 * concatenated string every other consumer of extractPage already used. */
export interface PageIdentitySignals {
  title: string;
  description?: string;
  ogTitle?: string;
  ogSiteName?: string;
  applicationName?: string;
}

function extractPage(html: string): { title: string; description?: string; text: string; identity: PageIdentitySignals } {
  const title = capture(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i) ?? "Untitled page";
  const description =
    metaContent(html, ["description", "og:description", "twitter:description"]);
  const ogSiteName = metaContent(html, ["og:site_name"]);
  const applicationName = metaContent(html, ["application-name"]);
  const ogTitle = metaContent(html, ["og:title", "twitter:title"]);
  const metadata = [ogSiteName ?? applicationName, ogTitle, ...extractJsonLdEvidence(html)];
  // <noscript> fallback text is genuine human-readable content -- often
  // written deliberately for SEO/no-JS visitors -- unlike script/style/
  // template/svg, which are never text. Extracted separately (its own
  // nested tags stripped) before the generic pass below removes the
  // wrapping element from bodyText, so this content is no longer
  // silently discarded along with the actual non-text elements.
  const noscriptText = Array.from(html.matchAll(/<noscript\b[^>]*>([\s\S]*?)<\/noscript>/gi))
    .map((match) => decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0);
  const bodyText = decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(?:script|style|noscript|template|svg)\b[\s\S]*?<\/(?:script|style|noscript|template|svg)>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
  const text = [...new Set([title, description, ...metadata, ...noscriptText, bodyText].filter(Boolean))]
    .join(". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120_000);
  return { title, description, text, identity: { title, description, ogTitle, ogSiteName, applicationName } };
}

function extractInternalLinks(html: string, pageUrl: URL, allowedHostname: string): URL[] {
  const links: URL[] = [];
  const seen = new Set<string>();
  const href = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  for (const match of html.matchAll(href)) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), pageUrl);
      url.hash = "";
      if ((url.protocol !== "http:" && url.protocol !== "https:") ||
          !equivalentWebsiteHost(url.hostname, allowedHostname) ||
          url.username || url.password || NON_CONTENT_PATH.test(url.pathname) || BINARY_EXTENSION.test(url.pathname)) {
        continue;
      }
      // Queries often produce effectively infinite crawl spaces. The submitted
      // URL may keep its query, but discovered links are canonicalized without it.
      url.search = "";
      const key = url.toString().replace(/\/$/, "");
      if (!seen.has(key)) {
        seen.add(key);
        links.push(url);
      }
    } catch {
      // Malformed hrefs are ignored, never fetched.
    }
  }
  return links;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * A testable rendering boundary, mirroring `PinnedWebsiteFetch`. Production
 * uses `renderWithHeadlessBrowser` below; custom implementations must not
 * perform their own DNS resolution and must return the fully rendered HTML.
 */
/**
 * Return type kept as a union (a bare string still works) specifically so
 * existing test doubles that return `Promise<string>` (see
 * tests/website-crawler-security.test.mjs) keep working unchanged --
 * only the real implementation below needs to report the richer
 * diagnostics, and it opts in by returning the object form instead.
 */
export type HeadlessRenderOutcome =
  | string
  | {
      html: string;
      completionReason: "content-ready" | "networkidle2" | "timeout";
      renderMs: number;
      browserStartupMs: number;
    };
export type HeadlessRenderFn = (
  url: URL,
  target: ValidatedWebsiteTarget,
  options: { timeoutMs: number; userAgent: string; getBrowser: () => Promise<Browser> },
) => Promise<HeadlessRenderOutcome>;

/**
 * Renders a page with a real (headless) browser so JavaScript-only sites --
 * whose initial HTML has no readable text until a script fills it in -- can
 * still be analyzed. This only ever runs as a fallback after the fast static
 * fetch above already produced too little text, so ordinary server-rendered
 * pages never pay for it.
 *
 * The same SSRF posture as the static fetch path is preserved here: Chromium's
 * own DNS resolver is overridden with `--host-resolver-rules` so the already
 * validated (pinned) address is the only one it can ever connect to for this
 * hostname, and request interception aborts every request to any other host
 * before Chromium can resolve or connect to it. A JS-only page cannot use this
 * fallback to make the browser fetch anything the static crawler above
 * couldn't already fetch itself.
 */
async function renderWithHeadlessBrowser(
  url: URL,
  target: ValidatedWebsiteTarget,
  options: { timeoutMs: number; userAgent: string; getBrowser: () => Promise<Browser> },
): Promise<HeadlessRenderOutcome> {
  const renderStarted = performance.now();
  const browserWaitStarted = renderStarted;
  const browser = await options.getBrowser();
  // Near-zero for every page after the first in a crawl, since the shared
  // browser (see crawlWebsite's ensureBrowser) is already resolved by
  // then -- only whichever page actually triggers the lazy launch pays
  // (and reports) real startup time here.
  const browserStartupMs = performance.now() - browserWaitStarted;
  const bareHostname = canonicalHostname(target.url.hostname);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(options.userAgent);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url());
      } catch {
        void request.abort();
        return;
      }
      const sameHost =
        (requestUrl.protocol === "http:" || requestUrl.protocol === "https:") &&
        equivalentWebsiteHost(requestUrl.hostname, bareHostname);
      if (!sameHost) {
        void request.abort();
        return;
      }
      // image/font/media never contribute a single character to the text
      // this crawl exists to extract -- blocking them (even same-host, where
      // they were previously allowed through unfiltered) cuts real network
      // work and, as a side effect, gives networkidle2 fewer in-flight
      // connections to wait out. Stylesheets are deliberately left alone:
      // unlike the other three, CSS can affect which DOM text a framework
      // treats as visible, and that hasn't been established safe to ignore.
      const resourceType = request.resourceType();
      if (resourceType === "image" || resourceType === "font" || resourceType === "media") {
        void request.abort();
        return;
      }
      void request.continue();
    });

    const deadlineAt = renderStarted + options.timeoutMs;
    try {
      await page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: Math.max(1_000, deadlineAt - performance.now()),
      });
    } catch {
      // Even an incomplete navigation usually leaves a body element in
      // place -- fall through to the readiness race below rather than
      // failing outright, matching the previous networkidle2-timeout
      // fallback's own tolerance for an imperfect navigation.
    }

    const remainingMs = () => Math.max(0, deadlineAt - performance.now());
    const CONTENT_READY_CHAR_THRESHOLD = 80; // matches the static-extraction threshold
    const POLL_INTERVAL_MS = 250;

    async function raceToLabel(work: Promise<boolean>, label: "content-ready" | "networkidle2") {
      const ready = await work.catch(() => false);
      return ready ? label : ("timeout" as const);
    }

    const contentReady = (async () => {
      let previousLength = -1;
      let sawStableRepeat = false;
      while (performance.now() < deadlineAt) {
        const length = await page
          .evaluate(() => document.body?.innerText?.length ?? 0)
          .catch(() => 0);
        if (length >= CONTENT_READY_CHAR_THRESHOLD && length === previousLength) {
          if (sawStableRepeat) return true;
          sawStableRepeat = true;
        } else {
          sawStableRepeat = false;
        }
        previousLength = length;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      return false;
    })();

    const budget = remainingMs();
    const networkIdle = budget > 0
      ? page.waitForNetworkIdle({ idleTime: 500, timeout: budget }).then(() => true).catch(() => false)
      : Promise.resolve(false);

    const completionReason = budget <= 0
      ? ("timeout" as const)
      : await Promise.race([
          raceToLabel(contentReady, "content-ready"),
          raceToLabel(networkIdle, "networkidle2"),
        ]);

    const html = await page.content();
    return { html, completionReason, renderMs: performance.now() - renderStarted, browserStartupMs };
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Crawls a small set of public HTML pages on the submitted host (plus its www
 * counterpart). Redirects and every DNS answer are revalidated for each fetch,
 * then the socket is pinned to those answers so DNS rebinding cannot change the
 * destination between validation and connection.
 */
export async function crawlWebsite(
  input: string,
  options: CrawlWebsiteOptions = {},
): Promise<WebsiteCrawlResult> {
  const resolver = options.resolver ?? defaultResolver;
  const target = await validatePublicWebsiteUrl(input, resolver);
  const maxPages = Math.max(1, Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, 12));
  const maxResponseBytes = Math.max(
    32_000,
    Math.min(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 2_000_000),
  );
  const maxTotalBytes = Math.max(
    maxResponseBytes,
    Math.min(options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES, 10_000_000),
  );
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 20_000));
  const renderTimeoutMs = Math.max(
    3_000,
    Math.min(options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS, 25_000),
  );
  const fetchImpl = options.fetchImpl ?? fetchPinnedWebsiteTarget;
  const renderImpl = options.renderImpl ?? renderWithHeadlessBrowser;
  const userAgent = options.userAgent ?? "DemandSignalBot/1.0 (website analysis; public pages only)";
  const queue: URL[] = [target.url];
  const queued = new Set([target.url.toString().replace(/\/$/, "")]);
  const pages: WebsiteEvidencePage[] = [];
  const failures: CrawlFailure[] = [];
  let totalBytes = 0;
  let canonicalUrl = target.url.toString();

  // Lazily launched on the first page that actually needs the render
  // fallback, then reused for every subsequent page in this same crawl --
  // a fresh Chromium process per rendered page was the single largest
  // fixed cost in a multi-page render-heavy crawl. Every page in one
  // crawlWebsite call shares the same target host, so the host-resolver
  // pinning below is valid for all of them, not just whichever page
  // triggered the launch. Not started at all if no page ever needs it, or
  // if a test-injected renderImpl never calls getBrowser().
  let sharedBrowserPromise: Promise<Browser> | undefined;
  function ensureBrowser(): Promise<Browser> {
    if (!sharedBrowserPromise) {
      sharedBrowserPromise = (async () => {
        const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH;
        if (!executablePath) {
          throw new Error("Headless rendering is not configured on this server.");
        }
        const puppeteer = (await import("puppeteer-core")).default;
        const bareHostname = canonicalHostname(target.url.hostname);
        const pinnedAddress =
          target.resolvedAddresses.find((entry) => entry.family === 4)?.address ??
          target.resolvedAddresses[0]?.address;
        if (!pinnedAddress) {
          throw new Error("No validated address is available for rendering.");
        }
        const hostResolverRules = [
          `MAP ${bareHostname} ${pinnedAddress}`,
          `MAP www.${bareHostname} ${pinnedAddress}`,
        ].join(",");
        return puppeteer.launch({
          executablePath,
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            `--host-resolver-rules=${hostResolverRules}`,
          ],
        });
      })();
    }
    return sharedBrowserPromise;
  }

  /**
   * Fetches and processes exactly one queued URL, mutating the shared
   * pages/failures/totalBytes/queue/queued state above. A failure here
   * never throws out of crawlWebsite itself -- it is recorded in
   * `failures` and the crawl continues, exactly as before this function
   * was pulled out of an inline loop body. Callers are responsible for
   * respecting maxPages/maxTotalBytes before invoking this (see below);
   * this function does not re-check them itself.
   */
  async function fetchOnePage(next: URL): Promise<void> {
    const pageStarted = performance.now();
    let staticFetchMs = 0;
    let staticChars = 0;
    let headlessTriggered = false;
    let browserStartupMs: number | undefined;
    let renderMs: number | undefined;
    let completionReason: PageCrawlTrace["completionReason"];
    let finalChars = 0;
    try {
      const fetchStarted = performance.now();
      const { response, finalUrl } = await fetchWithValidatedRedirects(next, {
        allowedHostname: target.url.hostname,
        timeoutMs,
        userAgent,
        fetchImpl,
        resolver,
        signal: options.signal,
      });
      if (!response.ok) {
        await response.body?.cancel("Non-success response is not crawled.");
        if (PERMANENT_HTTP_STATUS_CODES.has(response.status)) throw new PermanentWebsiteFetchError(response.status);
        throw new WebsiteFetchStatusError(response.status);
      }
      const contentType = response.headers.get("content-type")?.toLocaleLowerCase("en-US") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        await response.body?.cancel("Non-HTML response is not crawled.");
        throw new Error("Skipped a non-HTML page.");
      }
      // Best-effort, not an exact global lock: with concurrent fetches (see
      // the worker pool below), several pages can each read this snapshot
      // of the remaining budget before any of them has actually updated
      // totalBytes, so the true total can overshoot maxTotalBytes by up to
      // (concurrency - 1) page-reads in the worst case. Concurrency is kept
      // small (3) specifically to bound that overshoot; maxPages -- the
      // more consequential budget for downstream AI cost -- is still
      // enforced exactly (see the `reserved` counter below).
      const remainingBytes = Math.min(maxResponseBytes, maxTotalBytes - totalBytes);
      const loaded = await readLimitedText(response, remainingBytes);
      staticFetchMs = performance.now() - fetchStarted;
      totalBytes += loaded.bytes;
      let pageHtml = loaded.text;
      let extracted = extractPage(pageHtml);
      staticChars = extracted.text.length;
      let renderDiagnostic: string | undefined;
      if (extracted.text.length < 80) {
        // Static HTML alone was too thin -- likely a JavaScript-only page.
        // Try rendering it with a headless browser before giving up. Any
        // failure here (unconfigured server, blocked navigation, browser
        // crash) leaves the too-thin static result in place below, but the
        // reason is kept so the eventual error is diagnosable instead of
        // always reading identically to "no fallback was even attempted."
        headlessTriggered = true;
        try {
          const renderTarget = await validatePublicWebsiteUrl(finalUrl, resolver);
          const renderOutcome = await renderImpl(finalUrl, renderTarget, {
            timeoutMs: renderTimeoutMs,
            userAgent,
            getBrowser: ensureBrowser,
          });
          const renderedHtml = typeof renderOutcome === "string" ? renderOutcome : renderOutcome.html;
          if (typeof renderOutcome !== "string") {
            completionReason = renderOutcome.completionReason;
            renderMs = renderOutcome.renderMs;
            browserStartupMs = renderOutcome.browserStartupMs;
          }
          const rendered = extractPage(renderedHtml);
          if (rendered.text.length >= 80) {
            extracted = rendered;
            pageHtml = renderedHtml;
          } else {
            renderDiagnostic = `headless render produced only ${rendered.text.length} readable characters`;
          }
        } catch (renderError) {
          renderDiagnostic = `headless render failed: ${
            renderError instanceof Error ? renderError.message : "unknown error"
          }`;
        }
      }
      finalChars = extracted.text.length;
      if (extracted.text.length < 80) {
        throw new Error(
          renderDiagnostic
            ? `Page did not contain enough readable public text (${renderDiagnostic}).`
            : "Page did not contain enough readable public text.",
        );
      }
      const retrievedAt = new Date().toISOString();
      pages.push({
        url: finalUrl.toString(),
        title: extracted.title,
        description: extracted.description,
        text: extracted.text,
        contentHash: sha256(extracted.text),
        retrievedAt,
        identity: extracted.identity,
      });

      for (const link of extractInternalLinks(pageHtml, finalUrl, target.url.hostname)) {
        const key = link.toString().replace(/\/$/, "");
        if (!queued.has(key) && queued.size < maxPages * 8) {
          queued.add(key);
          queue.push(link);
        }
      }
      options.onPageTrace?.({
        url: next.toString(),
        staticFetchMs,
        staticChars,
        headlessTriggered,
        browserStartupMs,
        renderMs,
        completionReason,
        finalChars,
        totalMs: performance.now() - pageStarted,
        outcome: "succeeded",
      });
    } catch (error) {
      failures.push({
        url: next.toString(),
        reason: error instanceof Error ? error.message : "Unknown crawl error",
        permanent: error instanceof PermanentWebsiteFetchError,
        status:
          error instanceof PermanentWebsiteFetchError || error instanceof WebsiteFetchStatusError
            ? error.status
            : undefined,
      });
      options.onPageTrace?.({
        url: next.toString(),
        staticFetchMs,
        staticChars,
        headlessTriggered,
        browserStartupMs,
        renderMs,
        completionReason,
        finalChars,
        totalMs: performance.now() - pageStarted,
        outcome: "failed",
      });
    }
  }

  // The submitted URL is always fetched alone first, both because
  // canonicalUrl must reflect it specifically (not whichever page a
  // concurrent worker happens to finish first) and because every other
  // page is only discovered by reading this one's links -- there is
  // nothing to parallelize until it completes.
  const first = queue.shift();
  if (first) {
    const beforePages = pages.length;
    await fetchOnePage(first);
    if (pages.length > beforePages) canonicalUrl = pages[0].url;
  }

  // Pages 2+ have no such ordering constraint -- once queued, several can
  // be fetched at once instead of one at a time, which is where most of a
  // multi-page crawl's wall-clock time previously went (this is the same
  // crawlWebsite used for both a competitor's site and the primary
  // business's own, at maxPages: 4). `reserved` tracks fetches currently
  // in flight so pages.length can never exceed maxPages even though
  // several workers may be racing to add to it -- a worker only dequeues
  // a URL once it has "reserved" a slot within the budget.
  const concurrency = Math.min(3, maxPages);
  let reserved = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (pages.length + reserved >= maxPages || totalBytes >= maxTotalBytes) return;
      const next = queue.shift();
      if (!next) {
        if (reserved === 0) return;
        // Nothing queued right now, but another worker is still fetching
        // and may discover new links shortly -- wait briefly rather than
        // exiting early. Network fetches take orders of magnitude longer
        // than this poll, so the added latency here is negligible.
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      reserved += 1;
      try {
        await fetchOnePage(next);
      } finally {
        reserved -= 1;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Only actually closes anything if some page triggered ensureBrowser()
  // above; awaiting an undefined sharedBrowserPromise here would be a
  // no-op anyway, but the explicit check keeps a crawl that never needed
  // rendering from touching this at all.
  if (sharedBrowserPromise) {
    await sharedBrowserPromise.then((browser) => browser.close()).catch(() => {});
  }

  if (pages.length === 0) {
    const firstFailure = failures[0];
    const detail = firstFailure?.reason ?? "No readable public HTML pages were found.";
    // Preserve the permanent/transient distinction through to the final
    // throw -- collapsing every failure into a generic Error here is what
    // silently defeated retry classification for a persistent 403 in a
    // real production incident (the site's own status code never reached
    // the job queue's disposition logic, so it looked identical to an
    // ordinary transient failure and kept retrying indefinitely).
    if (firstFailure?.permanent && typeof firstFailure.status === "number") {
      throw new PermanentWebsiteFetchError(firstFailure.status);
    }
    // Preserve the status here too (not just the permanent branch above)
    // so a non-auto-permanent status like 503 still reaches
    // runFullWebsiteUnderstanding's retry loop as a typed
    // WebsiteFetchStatusError instead of a bare Error -- that loop needs
    // the numeric status to detect the same code recurring across
    // consecutive attempts. The user-facing message is unchanged either
    // way; only the thrown error's type/shape differs.
    if (typeof firstFailure?.status === "number") {
      throw new WebsiteFetchStatusError(firstFailure.status, `Website analysis could not read the site: ${detail}`);
    }
    throw new Error(`Website analysis could not read the site: ${detail}`);
  }

  return {
    requestedUrl: input,
    canonicalUrl,
    canonicalDomain: target.canonicalHostname,
    pages,
    failures,
    totalBytes,
  };
}
