import { apiErrorResponse, clearSessionCookie, parseCookies } from "@/lib/server/http";
import { getStateRepository } from "@/lib/server/repository";
import { assertRateLimit } from "@/lib/server/rate-limit";

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "auth:logout", { limit: 20, windowMs: 10 * 60_000 });
    const token = parseCookies(request).get("rd_session");
    if (token) await getStateRepository().revokeAuthSession(token);
    return new Response(null, { status: 204, headers: { "Set-Cookie": clearSessionCookie() } });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
