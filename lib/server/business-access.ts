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

/**
 * TEMPORARY FULL ACCESS OVERRIDE (2026-08-24) -- explicit request: "give
 * just full access, do not concentrate on provisional access", while the
 * real free tier gets rebuilt/reconsidered later ("i will recreate the free
 * pass later on"). Every caller of this function now sees every website as
 * covered, regardless of whether any real purchase exists.
 *
 * The real, hostname-scoped, purchase-verified logic is untouched below as
 * `realEntitlementCoversWebsite` -- still fully covered by
 * business-access-scope.test.mjs. To revert this override, make this
 * function call `realEntitlementCoversWebsite` again instead of returning
 * `true` directly.
 */
// Signature kept identical to realEntitlementCoversWebsite below so every
// call site (and its TypeScript arity checking) keeps working unchanged
// while this override is in effect.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function entitlementCoversWebsite(entitlement: EntitlementRecord, websiteUrl: string): boolean {
  return true;
}

export function realEntitlementCoversWebsite(
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
  // Deliberately the real check, not the temporarily-overridden
  // entitlementCoversWebsite above -- billing/duplicate-purchase protection
  // is a different concern from the feature-access override and stays
  // correct regardless of it.
  if (!realEntitlementCoversWebsite(entitlement, websiteUrl)) return "different_business";
  return requestedPlan === "pass" ? "pass_already_active" : null;
}
