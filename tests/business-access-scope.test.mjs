import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(
  new URL("../lib/server/business-access.ts", import.meta.url),
  "utf8",
);
const JavaScript = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "business-access.ts",
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(JavaScript).toString("base64")}`;
const {
  entitlementCoversWebsite,
  realEntitlementCoversWebsite,
  normalizedBusinessHostname,
  paidCheckoutBlockReason,
} = await import(moduleUrl);

const ENTITLEMENT = {
  workspaceId: "ws_paid",
  plan: "core",
  status: "active",
  accessUntil: null,
  seedScanId: "scan_purchased",
  websiteUrl: "https://www.Example.com/product",
  stripeCustomerId: "cus_test",
  stripeSubscriptionId: "sub_test",
  verifiedByEventId: "evt_test",
  updatedAt: "2026-08-05T12:00:00.000Z",
};

test("business host normalization covers bare and www forms without widening to subdomains", () => {
  assert.equal(normalizedBusinessHostname("example.com"), "example.com");
  assert.equal(normalizedBusinessHostname("https://WWW.EXAMPLE.COM./pricing"), "example.com");
  assert.equal(normalizedBusinessHostname("ftp://example.com/file"), null);
  assert.equal(normalizedBusinessHostname("not a url"), null);
});

test("paid access applies only to the verified purchased business hostname (realEntitlementCoversWebsite)", () => {
  // This is the real, hostname-scoped, purchase-verified logic --
  // preserved and still fully tested even while the live gate
  // (entitlementCoversWebsite, tested separately below) is temporarily
  // overridden to always allow access. See business-access.ts's doc
  // comment on entitlementCoversWebsite for why and how to revert.
  assert.equal(realEntitlementCoversWebsite(ENTITLEMENT, "https://example.com/"), true);
  assert.equal(realEntitlementCoversWebsite(ENTITLEMENT, "https://www.example.com/about"), true);
  assert.equal(realEntitlementCoversWebsite(ENTITLEMENT, "https://app.example.com/"), false);
  assert.equal(realEntitlementCoversWebsite(ENTITLEMENT, "https://example.com.attacker.test/"), false);
  assert.equal(realEntitlementCoversWebsite(ENTITLEMENT, "https://another.example/"), false);
  assert.equal(realEntitlementCoversWebsite({ ...ENTITLEMENT, status: "canceled" }, "example.com"), false);
  assert.equal(realEntitlementCoversWebsite({ ...ENTITLEMENT, plan: "free" }, "example.com"), false);
  assert.equal(realEntitlementCoversWebsite({ ...ENTITLEMENT, seedScanId: null }, "example.com"), false);
  assert.equal(realEntitlementCoversWebsite({ ...ENTITLEMENT, verifiedByEventId: null }, "example.com"), false);
});

test("TEMPORARY: the live entitlementCoversWebsite gate is fully overridden -- everything is covered", () => {
  // Pins the intentional, temporary full-access override (2026-08-24) so
  // it's impossible to miss in the test suite, and so reverting it later
  // is a one-line, obviously-test-covered change.
  assert.equal(entitlementCoversWebsite(ENTITLEMENT, "https://example.com/"), true);
  assert.equal(entitlementCoversWebsite({ ...ENTITLEMENT, plan: "free" }, "https://another.example/"), true);
  assert.equal(
    entitlementCoversWebsite(
      { ...ENTITLEMENT, status: "canceled", verifiedByEventId: null, seedScanId: null, websiteUrl: null },
      "https://anything-at-all.example/",
    ),
    true,
  );
});

test("checkout policy prevents duplicate billing and cross-business upgrades", () => {
  assert.equal(paidCheckoutBlockReason(ENTITLEMENT, "core", "example.com"), "core_already_active");
  assert.equal(paidCheckoutBlockReason(ENTITLEMENT, "pass", "another.example"), "core_already_active");

  const activePass = { ...ENTITLEMENT, plan: "pass" };
  assert.equal(paidCheckoutBlockReason(activePass, "pass", "example.com"), "pass_already_active");
  assert.equal(paidCheckoutBlockReason(activePass, "core", "example.com"), null);
  assert.equal(paidCheckoutBlockReason(activePass, "core", "another.example"), "different_business");
  // paidCheckoutBlockReason deliberately uses realEntitlementCoversWebsite
  // internally, not the overridden entitlementCoversWebsite -- billing
  // protection stays real regardless of the feature-access override above.
  assert.equal(
    paidCheckoutBlockReason({ ...activePass, status: "expired" }, "pass", "another.example"),
    null,
  );
  assert.equal(
    paidCheckoutBlockReason({ ...activePass, status: "canceled" }, "core", "another.example"),
    null,
  );
});
