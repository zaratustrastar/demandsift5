import type { ConversionRecord } from "./contracts";

type TrackableResult = Pick<ConversionRecord, "kind" | "valueCents">;

export function summarizeTrackedResults(rows: readonly TrackableResult[]) {
  let clicks = 0;
  let conversions = 0;
  let valueCents = 0;

  for (const row of rows) {
    if (row.kind === "click") clicks += 1;
    if (row.kind === "conversion") conversions += 1;
    valueCents += row.valueCents ?? 0;
  }

  return { clicks, conversions, valueCents };
}
