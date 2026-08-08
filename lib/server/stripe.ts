import type { AccessPlan, CheckoutRecord, EntitlementRecord } from "./contracts";
import { ApiError } from "./http";
import { createId } from "./ids";
import { captureFunnelEvent } from "./funnel";
import { getStateRepository } from "./repository";
import { isProductionRuntime } from "./runtime-env";

export type CheckoutPlan = Exclude<AccessPlan, "free">;

type StripeObject = {
  id?: string;
  mode?: string;
  payment_status?: string;
  status?: string;
  customer?: string;
  subscription?: string;
  current_period_end?: number;
  metadata?: Record<string, string | undefined>;
};

export type StripeEvent = {
  id: string;
  type: string;
  created?: number;
  data: { object: StripeObject };
};

function planDetails(plan: CheckoutPlan) {
  if (plan === "pass") {
    return {
      amountCents: Number(process.env.STRIPE_PASS_AMOUNT_CENTS ?? 1200),
      name: "Full Access Pass — 7 days",
      description: "All current findings, suggested replies, and seven days of monitoring.",
      mode: "payment" as const,
      priceId: process.env.STRIPE_PASS_PRICE_ID?.trim(),
    };
  }
  return {
    amountCents: Number(process.env.STRIPE_CORE_AMOUNT_CENTS ?? 3000),
    name: "Core — monthly",
    description:
      "Continuous monitoring, all opportunities, insights, replies, summaries, and basic results tracking for one business.",
    mode: "subscription" as const,
    priceId: process.env.STRIPE_CORE_PRICE_ID?.trim(),
  };
}

function assertConfiguredAmount(amount: number): number {
  if (!Number.isInteger(amount) || amount < 50 || amount > 100_000) {
    throw new ApiError("Stripe price configuration is invalid.", 500, "server_configuration_error");
  }
  return amount;
}

function stripeMode(secretKey: string): "test" | "live" {
  return secretKey.startsWith("sk_live_") ? "live" : "test";
}

export async function createStripeCheckout(input: {
  workspaceId: string;
  scanId: string;
  plan: CheckoutPlan;
  origin: string;
}): Promise<{
  id: string;
  url: string;
  plan: CheckoutPlan;
  amountCents: number;
  currency: "usd";
  taxCalculatedAtCheckout: true;
  providerMode: "test" | "live" | "mock";
  accessGranted: false;
}> {
  const details = planDetails(input.plan);
  const amountCents = assertConfiguredAmount(details.amountCents);
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  let checkoutId: string;
  let checkoutUrl: string;
  let providerMode: "test" | "live" | "mock";

  if (!secretKey) {
    if (isProductionRuntime() || process.env.ENABLE_DEMO_STRIPE !== "true") {
      throw new ApiError(
        "Stripe checkout is not configured.",
        503,
        "payments_unavailable",
      );
    }
    checkoutId = createId("cs_test_demo");
    checkoutUrl = `${input.origin}/?demo_checkout=${encodeURIComponent(checkoutId)}`;
    providerMode = "mock";
  } else {
    const params = new URLSearchParams();
    const scanReturn = `&scan_id=${encodeURIComponent(input.scanId)}`;
    params.set("mode", details.mode);
    params.set(
      "success_url",
      `${input.origin}/?checkout=success${scanReturn}&session_id={CHECKOUT_SESSION_ID}`,
    );
    params.set("cancel_url", `${input.origin}/?checkout=canceled${scanReturn}`);
    params.set("client_reference_id", input.workspaceId);
    params.set("automatic_tax[enabled]", "true");
    params.set("allow_promotion_codes", "true");
    params.set("metadata[workspaceId]", input.workspaceId);
    params.set("metadata[plan]", input.plan);
    params.set("metadata[scanId]", input.scanId);
    params.set("line_items[0][quantity]", "1");

    if (details.priceId) {
      params.set("line_items[0][price]", details.priceId);
    } else {
      params.set("line_items[0][price_data][currency]", "usd");
      params.set("line_items[0][price_data][unit_amount]", String(amountCents));
      params.set("line_items[0][price_data][product_data][name]", details.name);
      params.set(
        "line_items[0][price_data][product_data][description]",
        details.description,
      );
      params.set("line_items[0][price_data][tax_behavior]", "exclusive");
      if (details.mode === "subscription") {
        params.set("line_items[0][price_data][recurring][interval]", "month");
      }
    }

    if (details.mode === "subscription") {
      params.set("subscription_data[metadata][workspaceId]", input.workspaceId);
      params.set("subscription_data[metadata][plan]", input.plan);
      params.set("subscription_data[metadata][scanId]", input.scanId);
    }

    const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });
    const payload = (await response.json()) as { id?: string; url?: string; error?: { message?: string } };
    if (!response.ok || !payload.id || !payload.url) {
      console.error("Stripe checkout creation failed", response.status, payload.error?.message);
      throw new ApiError("Stripe could not start checkout.", 502, "payment_provider_error");
    }
    checkoutId = payload.id;
    checkoutUrl = payload.url;
    providerMode = stripeMode(secretKey);
  }

  const record: CheckoutRecord = {
    id: checkoutId,
    workspaceId: input.workspaceId,
    scanId: input.scanId,
    plan: input.plan,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  await getStateRepository().saveCheckout(record);

  return {
    id: checkoutId,
    url: checkoutUrl,
    plan: input.plan,
    amountCents,
    currency: "usd",
    taxCalculatedAtCheckout: true,
    providerMode,
    accessGranted: false,
  };
}

function parseStripeSignature(header: string): { timestamp: number; signatures: string[] } {
  let timestamp = 0;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = Number(value);
    if (key === "v1" && value) signatures.push(value);
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0 || signatures.length === 0) {
    throw new ApiError("Stripe signature is malformed.", 400, "invalid_webhook_signature");
  }
  return { timestamp, signatures };
}

function safeEqualHex(left: string, right: string): boolean {
  const normalizedLeft = left.toLowerCase();
  const normalizedRight = right.toLowerCase();
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  let difference = normalizedLeft.length ^ normalizedRight.length;
  for (let index = 0; index < length; index += 1) {
    difference |=
      (normalizedLeft.charCodeAt(index) || 0) ^ (normalizedRight.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function webhookSecret(): string {
  const configured = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (configured) return configured;
  if (!isProductionRuntime() && process.env.ENABLE_DEMO_STRIPE === "true") {
    return "whsec_signal_scout_demo_only";
  }
  throw new ApiError("Stripe webhooks are not configured.", 503, "payments_unavailable");
}

export async function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret = webhookSecret(),
): Promise<StripeEvent> {
  if (!signatureHeader) {
    throw new ApiError("Stripe-Signature header is required.", 400, "invalid_webhook_signature");
  }
  const { timestamp, signatures } = parseStripeSignature(signatureHeader);
  const configuredTolerance = Number(process.env.STRIPE_WEBHOOK_TOLERANCE_SECONDS ?? 300);
  const tolerance =
    Number.isFinite(configuredTolerance) && configuredTolerance >= 30 && configuredTolerance <= 900
      ? configuredTolerance
      : 300;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > tolerance) {
    throw new ApiError("Stripe signature has expired.", 400, "invalid_webhook_signature");
  }
  const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
  if (!signatures.some((candidate) => safeEqualHex(candidate, expected))) {
    throw new ApiError("Stripe signature verification failed.", 400, "invalid_webhook_signature");
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    throw new ApiError("Stripe event is not valid JSON.", 400, "invalid_webhook_payload");
  }
  if (!event.id || !event.type || !event.data?.object) {
    throw new ApiError("Stripe event is incomplete.", 400, "invalid_webhook_payload");
  }
  return event;
}

function workspaceAndPlan(object: StripeObject): {
  workspaceId: string;
  plan: CheckoutPlan | null;
} {
  const workspaceId = object.metadata?.workspaceId ?? "";
  const planValue = object.metadata?.plan;
  return {
    workspaceId,
    plan: planValue === "pass" || planValue === "core" ? planValue : null,
  };
}

function isoFromEpoch(seconds: number | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

export async function applyVerifiedStripeEvent(event: StripeEvent): Promise<{
  duplicate: boolean;
  accessChanged: boolean;
  workspaceId: string | null;
}> {
  const repository = getStateRepository();
  const object = event.data.object;
  const metadata = workspaceAndPlan(object);
  let entitlement: EntitlementRecord | undefined;
  let checkout: CheckoutRecord | undefined;
  const workspaceId: string | null = metadata.workspaceId || null;

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {
    const paid = object.payment_status === "paid" || object.payment_status === "no_payment_required";
    const pendingCheckout = object.id ? await repository.getCheckout(object.id) : null;
    const purchasedScan = pendingCheckout
      ? await repository.getScan(pendingCheckout.scanId)
      : null;
    const modeMatches =
      pendingCheckout?.plan === "pass"
        ? object.mode === "payment"
        : pendingCheckout?.plan === "core" && object.mode === "subscription";
    if (
      paid &&
      metadata.workspaceId &&
      metadata.plan &&
      pendingCheckout?.status === "pending" &&
      pendingCheckout.workspaceId === metadata.workspaceId &&
      pendingCheckout.plan === metadata.plan &&
      purchasedScan?.workspaceId === metadata.workspaceId &&
      purchasedScan.status === "complete" &&
      Boolean(purchasedScan.result) &&
      modeMatches &&
      (await repository.workspaceExists(metadata.workspaceId))
    ) {
      const now = new Date();
      const accessUntil =
        metadata.plan === "pass"
          ? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
          : null;
      entitlement = {
        workspaceId: metadata.workspaceId,
        plan: metadata.plan,
        status: "active",
        accessUntil,
        seedScanId: purchasedScan.id,
        websiteUrl: purchasedScan.websiteUrl,
        stripeCustomerId: object.customer ?? null,
        stripeSubscriptionId: object.subscription ?? null,
        verifiedByEventId: event.id,
        updatedAt: now.toISOString(),
      };
      checkout = { ...pendingCheckout, status: "completed" };
    }
  }

  if (event.type === "customer.subscription.updated" && metadata.workspaceId) {
    const status = object.status;
    const active = status === "active" || status === "trialing";
    const current = await repository.getEntitlement(metadata.workspaceId);
    if (current?.plan === "core" && current.stripeSubscriptionId === object.id) {
      entitlement = {
        workspaceId: metadata.workspaceId,
        plan: "core",
        status: active ? "active" : status === "canceled" ? "canceled" : "expired",
        accessUntil: isoFromEpoch(object.current_period_end),
        seedScanId: current.seedScanId,
        websiteUrl: current.websiteUrl,
        stripeCustomerId: object.customer ?? current?.stripeCustomerId ?? null,
        stripeSubscriptionId: object.id ?? current?.stripeSubscriptionId ?? null,
        verifiedByEventId: event.id,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  if (event.type === "customer.subscription.deleted" && metadata.workspaceId) {
    const current = await repository.getEntitlement(metadata.workspaceId);
    if (current?.plan === "core") {
      entitlement = {
        ...current,
        status: "canceled",
        accessUntil: isoFromEpoch(object.current_period_end) ?? new Date().toISOString(),
        verifiedByEventId: event.id,
        updatedAt: new Date().toISOString(),
      };
    }
  }
  const committed = await repository.commitStripeEvent({
    eventId: event.id,
    eventType: event.type,
    eventPayload: event as unknown as Record<string, unknown>,
    livemode: (event as StripeEvent & { livemode?: boolean }).livemode === true,
    entitlement,
    checkout,
  });
  if (committed && entitlement?.plan === "pass" && checkout?.status === "completed") {
    const purchasedScan = await repository.getScan(checkout.scanId);
    if (purchasedScan) await captureFunnelEvent(purchasedScan, "pass_purchased");
  }
  return {
    duplicate: !committed,
    accessChanged: committed && Boolean(entitlement),
    workspaceId,
  };
}

export async function createSignedDemoWebhook(input: {
  workspaceId: string;
  checkoutId: string;
}): Promise<{ rawBody: string; signature: string }> {
  if (isProductionRuntime() || process.env.ENABLE_DEMO_STRIPE !== "true") {
    throw new ApiError("Demo checkout completion is disabled.", 404, "not_found");
  }
  const checkout = await getStateRepository().getCheckout(input.checkoutId);
  if (!checkout || checkout.workspaceId !== input.workspaceId || checkout.status !== "pending") {
    throw new ApiError("Pending checkout was not found.", 404, "checkout_not_found");
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const event: StripeEvent = {
    id: createId("evt_test_demo"),
    type: "checkout.session.completed",
    created: timestamp,
    data: {
      object: {
        id: checkout.id,
        mode: checkout.plan === "core" ? "subscription" : "payment",
        payment_status: "paid",
        customer: createId("cus_demo"),
        subscription: checkout.plan === "core" ? createId("sub_demo") : undefined,
        metadata: {
          workspaceId: checkout.workspaceId,
          plan: checkout.plan,
          scanId: checkout.scanId,
        },
      },
    },
  };
  const rawBody = JSON.stringify(event);
  const signature = await hmacHex(webhookSecret(), `${timestamp}.${rawBody}`);
  return { rawBody, signature: `t=${timestamp},v1=${signature}` };
}
