import { createHash } from "node:crypto";
import type { WebsiteCrawlResult } from "../security/website-crawler";
import type { BusinessUnderstanding } from "../domain/types";

export type WebsiteSnapshot = {
  version: 1; id: string; scanId: string; inputUrl: string; capturedAt: string;
  crawlerVersion: "same-domain-cb24c44"; contentHash: string; crawl: WebsiteCrawlResult;
};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const websitePageSourceId = (contentHash: string) => `web_${contentHash.slice(0, 20)}`;

export function createWebsiteSnapshot(scanId: string, inputUrl: string, result: WebsiteCrawlResult): WebsiteSnapshot {
  if (result.pages.length === 0 || result.pages.length > 4) throw new Error("Website snapshot requires one to four successfully read pages.");
  const crawl = structuredClone(result);
  crawl.pages = crawl.pages.map(page => ({ ...page, sourceId: websitePageSourceId(page.contentHash) }));
  const contentHash = hash(crawl);
  return { version: 1, id: `website_${hash({ scanId, inputUrl: inputUrl.trim(), contentHash })}`,
    scanId, inputUrl: inputUrl.trim(), capturedAt: new Date().toISOString(), crawlerVersion: "same-domain-cb24c44", contentHash, crawl };
}

export function reusableWebsiteSnapshot(snapshot: WebsiteSnapshot, scanId: string, inputUrl: string): boolean {
  return snapshot.version === 1 && snapshot.crawlerVersion === "same-domain-cb24c44"
    && snapshot.scanId === scanId && snapshot.inputUrl === inputUrl.trim()
    && Array.isArray(snapshot.crawl?.pages)
    && snapshot.crawl.pages.length > 0 && snapshot.crawl.pages.length <= 4
    && snapshot.contentHash === hash(snapshot.crawl)
    && snapshot.id === `website_${hash({ scanId, inputUrl: inputUrl.trim(), contentHash: snapshot.contentHash })}`
    && snapshot.crawl.pages.every(page => page.sourceId === websitePageSourceId(page.contentHash));
}

/** A legacy approved profile can bind only to evidence with matching IDs. */
export function legacyProfileMatchesSnapshot(sourceIds: readonly string[], snapshot: WebsiteSnapshot): boolean {
  const pageIds = new Set(snapshot.crawl.pages.map(page => page.sourceId));
  return sourceIds.length > 0 && sourceIds.every(id => pageIds.has(id));
}

export function businessWebsiteSourceIds(business: BusinessUnderstanding): string[] {
  return [...new Set(Object.values(business).flatMap(value =>
    value && typeof value === "object" && "provenanceIds" in value && Array.isArray(value.provenanceIds)
      ? value.provenanceIds as string[] : [],
  ))];
}
