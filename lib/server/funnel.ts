import type { FunnelEventName, FunnelEventRecord, ScanRecord } from "./contracts";
import { createId } from "./ids";
import { getStateRepository } from "./repository";

export function scanPotentialCustomerCount(scan: ScanRecord): number | null {
  if (scan.status !== "complete" || !scan.result) return null;
  const count = scan.result.potentialCustomers?.total ?? scan.result.opportunities.length;
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/** Persisted product-funnel evidence. Analytics delivery can mirror this later. */
export async function captureFunnelEvent(
  scan: ScanRecord,
  name: FunnelEventName,
): Promise<FunnelEventRecord> {
  const event: FunnelEventRecord = {
    id: createId("funnel"),
    workspaceId: scan.workspaceId,
    scanId: scan.id,
    name,
    potentialCustomerCount: scanPotentialCustomerCount(scan),
    createdAt: new Date().toISOString(),
  };
  await getStateRepository().saveFunnelEvent(event);
  return event;
}
