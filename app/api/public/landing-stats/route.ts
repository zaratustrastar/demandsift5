import { apiErrorResponse } from "@/lib/server/http";
import { getPublicLandingStats } from "@/lib/server/public-stats-repository";
import { assertRateLimit } from "@/lib/server/rate-limit";

/**
 * Public, unauthenticated: the marketing landing page's real scan/post
 * counts. No workspace context -- these are site-wide totals, the same
 * for every visitor. Always reads the cached row (see
 * public-stats-repository.ts); never computes the aggregate itself, so
 * this stays cheap regardless of traffic. Cache-Control lets the browser
 * skip refetching within a session; the number only changes once a day
 * anyway.
 */
export async function GET(request: Request) {
  try {
    assertRateLimit(request, "public:landing-stats", { limit: 120, windowMs: 60_000 });
    const stats = await getPublicLandingStats();
    return Response.json(stats, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
