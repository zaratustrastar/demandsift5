import { apiErrorResponse, readJson, requireWorkspace } from "@/lib/server/http";
import { presentAccess } from "@/lib/server/presenter";
import {
  applyVerifiedStripeEvent,
  createSignedDemoWebhook,
  verifyStripeWebhook,
} from "@/lib/server/stripe";

type DemoWebhookBody = { checkoutId?: unknown };

/** Development-only Stripe webhook simulator. It still signs and verifies the event. */
export async function POST(request: Request) {
  try {
    const actor = await requireWorkspace(request);
    const body = await readJson<DemoWebhookBody>(request);
    const checkoutId = typeof body.checkoutId === "string" ? body.checkoutId : "";
    const signed = await createSignedDemoWebhook({ workspaceId: actor.workspaceId, checkoutId });
    const verified = await verifyStripeWebhook(signed.rawBody, signed.signature);
    const outcome = await applyVerifiedStripeEvent(verified);
    return Response.json({
      received: true,
      simulated: true,
      eventId: verified.id,
      outcome,
      access: await presentAccess(actor.workspaceId),
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
