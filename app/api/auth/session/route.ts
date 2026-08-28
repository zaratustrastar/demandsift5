import { getSessionActor } from "@/lib/server/http";
import { getStateRepository } from "@/lib/server/repository";

/**
 * Unauthenticated-friendly: returns { user: null } rather than a 401 when
 * signed out, since the client (the landing nav's account state -- see
 * ThreadlineExperience.tsx) polls this on every load just to decide what
 * to render, not to gate access to anything.
 */
export async function GET(request: Request) {
  const session = await getSessionActor(request);
  if (!session) {
    return Response.json({ user: null }, { headers: { "Cache-Control": "no-store" } });
  }
  const profile = await getStateRepository().getUserProfile(session.userId);
  return Response.json(
    { user: profile },
    { headers: { "Cache-Control": "no-store" } },
  );
}
