import type { EntitlementRecord } from "./contracts";

export function normalizedBusinessHostname(websiteUrl: string | null | undefined): string | null {
  const input = websiteUrl?.trim();
  if (!input) return null;
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//iu.test(input) ? input : `https://${input}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.hostname
      .toLocaleLowerCase("en-US")
      .replace(/\.$/u, "")
      .replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}

export function entitlementCoversWebsite(
  entitlement: EntitlementRecord,
  websiteUrl: string,
): boolean {
  const purchasedHostname = normalizedBusinessHostname(entitlement.websiteUrl);
  const requestedHostname = normalizedBusinessHostname(websiteUrl);
  return Boolean(
    entitlement.status === "active" &&
    entitlement.plan !== "free" &&
    entitlement.verifiedByEventId &&
    entitlement.seedScanId &&
    purchasedHostname &&
    requestedHostname &&
    purchasedHostname === requestedHostname,
  );
}

export function paidCheckoutBlockReason(
  entitlement: EntitlementRecord,
  requestedPlan: "pass" | "core",
  websiteUrl: string,
): "core_already_active" | "pass_already_active" | "different_business" | null {
  if (entitlement.status !== "active") return null;
  if (entitlement.plan === "core") return "core_already_active";
  if (entitlement.plan !== "pass") return null;
  if (!entitlementCoversWebsite(entitlement, websiteUrl)) return "different_business";
  return requestedPlan === "pass" ? "pass_already_active" : null;
}
