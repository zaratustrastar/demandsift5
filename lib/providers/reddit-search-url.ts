/**
 * Build a Reddit search-page URL for Harshmaur's `startUrls` "Direct URL"
 * scraping mode.
 *
 * Empirically (per a manual Apify test comparing this against plain
 * `searchTerms`), Harshmaur's `startUrls` route only recognizes a narrow,
 * specific shape: `https://www.reddit.com/search/?q=<query>&t=<window>` and
 * nothing else. A URL copied from a browser -- which carries `type=all`,
 * `cId`, `acId`, `iId` and similar UI-tracking params -- is rejected outright
 * with "not a recognised Reddit search URL" before the actor makes any
 * request, and a `type=link` param was rejected by the same actor build even
 * though some Harshmaur documentation still shows it. So this always
 * generates the minimal form itself rather than ever passing through or
 * extending a URL from elsewhere.
 */

export type RedditSearchTimeWindow = "hour" | "day" | "week" | "month" | "year" | "all";

export function redditSearchUrl(
  query: string,
  options: { time?: RedditSearchTimeWindow } = {},
): string {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("redditSearchUrl requires a non-empty query.");
  const url = new URL("https://www.reddit.com/search/");
  url.search = "";
  url.searchParams.set("q", trimmed);
  url.searchParams.set("t", options.time ?? "week");
  return url.toString();
}
