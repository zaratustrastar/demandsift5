import { apiErrorResponse, ApiError, getRequestOrigin, readJson, requireWorkspace } from "@/lib/server/http";
import { paidCheckoutBlockReason } from "@/lib/server/business-access";
import { requireOwnedScan } from "@/lib/server/presenter";
import { assertRateLimit } from "@/lib/server/rate-limit";
import { getEffectiveEntitlement } from "@/lib/server/repository";
import { createStripeCheckout } from "@/lib/server/stripe";
import { captureFunnelEvent } from "@/lib/server/funnel";

type CheckoutBody = { plan?: unknown; scanId?: unknown };

export async function POST(request: Request) {
  try {
    assertRateLimit(request, "stripe:checkout", { limit: 12, windowMs: 10 * 60_000 });
    const actor = await requireWorkspace(request);
    const body = await readJson<CheckoutBody>(request);
    if (body.plan !== "pass" && body.plan !== "core") {
      throw new ApiError("plan must be pass or core.", 400, "invalid_plan");
    }
    if (typeof body.scanId !== "string") {
      throw new ApiError("scanId is required.", 400, "scan_id_required");
    }
    const scan = await requireOwnedScan(actor.workspaceId, body.scanId);
    if (scan.status !== "complete" || !scan.result) {
      throw new ApiError(
        "Complete the market scan before purchasing access.",
        409,
        "scan_not_complete",
      );
    }
    const entitlement = await getEffectiveEntitlement(actor.workspaceId);
    const blockReason = paidCheckoutBlockReason(entitlement, body.plan, scan.websiteUrl);
    if (blockReason === "core_already_active") {
      throw new ApiError(
        "Core is already active for this workspace.",
        409,
        "core_already_active",
      );
    }
    if (blockReason === "pass_already_active") {
      throw new ApiError(
        "The Full Access Pass is already active. Upgrade to Core instead.",
        409,
        "pass_already_active",
      );
    }
    if (blockReason === "different_business") {
      throw new ApiError(
        "Active paid access is pinned to the originally purchased business.",
        409,
        "paid_business_mismatch",
      );
    }
    const checkout = await createStripeCheckout({
      workspaceId: actor.workspaceId,
      scanId: body.scanId,
      plan: body.plan,
      origin: getRequestOrigin(request),
    });
    if (body.plan === "pass") {
      await captureFunnelEvent(scan, "pass_checkout_started");
    }
    return Response.json(
      {
        checkout,
        notice: "Access remains locked until a verified Stripe webhook confirms payment.",
      },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error);
  }
}
