import { apiErrorResponse, ApiError } from "@/lib/server/http";
import { applyVerifiedStripeEvent, verifyStripeWebhook } from "@/lib/server/stripe";

export async function POST(request: Request) {
  try {
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
      throw new ApiError("Webhook payload is too large.", 413, "payload_too_large");
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > 1_000_000) {
      throw new ApiError("Webhook payload is too large.", 413, "payload_too_large");
    }
    const event = await verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"));
    const outcome = await applyVerifiedStripeEvent(event);
    return Response.json({ received: true, eventId: event.id, ...outcome });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
