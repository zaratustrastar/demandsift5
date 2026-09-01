import { createHash } from "node:crypto";
import type { ScanRecord } from "./contracts";

export type ScanPhase = "created" | "analysis_queued" | "analyzing" | "awaiting_review" | "scan_queued" | "scanning" | "complete" | "failed";
export type ScanJobType = "scan.analyze" | "scan.run";
export class ScanReviewError extends Error {
  readonly name = "ApiError";
  readonly status = 409;
  constructor(message: string, readonly code = "scan_review_required") { super(message); }
}
// PostgreSQL JSONB reorders object keys. A review token must survive a round trip.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}
export function scanReviewVersion(scan: ScanRecord): string | null {
  if (!scan.discoveryProfile || scan.discoveryProfile.profileStage === "fast") return null;
  return `review_${createHash("sha256").update(JSON.stringify(canonical({ scanId: scan.id,
    input: [scan.inputMode ?? "website", scan.websiteUrl, scan.contextText ?? null],
    // Profile/business source IDs already bind content. Attaching an identical
    // legacy snapshot must not invalidate the user's unchanged reviewed terms.
    profile: scan.discoveryProfile.profile, business: scan.discoveryProfile.business,
    overrides: scan.discoveryOverrides ?? null, competitors: scan.competitorProfiles ?? [],
  }))).digest("hex")}`;
}
export function assertReviewedVersion(scan: ScanRecord, version: unknown): string {
  const current = scanReviewVersion(scan);
  if (!current) throw new ScanReviewError("Finish the business analysis and review its search profile before starting Reddit discovery.");
  if (typeof version !== "string" || current !== version) throw new ScanReviewError("The search profile changed. Review the current terms before starting.", "scan_review_changed");
  return current;
}
export function scanPhase(scan: { phase?: ScanPhase; status: ScanRecord["status"]; discoveryProfile?: unknown; approval?: unknown }): ScanPhase {
  if (scan.status === "complete") return "complete";
  if (scan.status === "failed") return "failed";
  if (scan.phase) return scan.phase;
  if (scan.status === "running" || scan.status === "retrying") return "scanning";
  return scan.discoveryProfile && !scan.approval ? "awaiting_review" : "created";
}
export function approveScanRecord(scan: ScanRecord, version: unknown): ScanRecord {
  const approved = assertReviewedVersion(scan, version);
  if (scan.approval?.version === approved) return scan;
  if (scan.execution?.active || scan.status === "running" || scan.status === "complete") {
    throw new ScanReviewError("This scan has already started.", "scan_already_started");
  }
  return { ...scan, reviewRequired: true, approval: { version: approved, approvedAt: new Date().toISOString() },
    phase: "scan_queued", status: "queued", error: null, errorCode: null, updatedAt: new Date().toISOString() };
}
