import type { AnalyticsEvent, AnalyticsProvider, AnalyticsValue } from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";

type AnalyticsLogger = (entry: string) => void;

function eventName(value: string): string {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (!normalized || normalized.length > 80 || !/^[a-z0-9][a-z0-9_.-]*$/.test(normalized)) {
    throw new Error("Analytics event name is invalid.");
  }
  return normalized;
}

async function opaqueReference(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest).slice(0, 6), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function propertyTypeCounts(properties: Record<string, AnalyticsValue> | undefined) {
  const entries = Object.entries(properties ?? {}).slice(0, 50);
  const counts = { boolean: 0, number: 0, string: 0, null: 0, omitted: 0 };
  for (const [, value] of entries) {
    if (value === null) counts.null += 1;
    else counts[typeof value as "boolean" | "number" | "string"] += 1;
  }
  counts.omitted = Math.max(0, Object.keys(properties ?? {}).length - entries.length);
  return counts;
}

/**
 * Development-only analytics sink. Identifiers are one-way references and
 * property keys/values are never logged; output remains small and predictable.
 */
export class ConsoleAnalyticsProvider implements AnalyticsProvider {
  readonly name = "console-analytics";

  constructor(private readonly logger: AnalyticsLogger = (entry) => console.info(entry)) {}

  async capture(event: AnalyticsEvent): Promise<void> {
    if (!Number.isFinite(Date.parse(event.occurredAt))) {
      throw new Error("Analytics occurredAt is invalid.");
    }
    const entry = JSON.stringify({
      event: "local_analytics_capture",
      name: eventName(event.name),
      workspaceRef: await opaqueReference(event.workspaceId),
      businessRef: await opaqueReference(event.businessId),
      actorRef: await opaqueReference(event.actorId),
      occurredAt: new Date(event.occurredAt).toISOString(),
      propertyTypes: propertyTypeCounts(event.properties),
    });
    this.logger(entry.slice(0, 1_024));
  }
}

const localAnalytics = new ConsoleAnalyticsProvider();

export function createAnalyticsProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  registered: Readonly<Record<string, AnalyticsProvider>> = {},
): AnalyticsProvider {
  const configured = env.ANALYTICS_PROVIDER?.trim().toLocaleLowerCase("en-US");
  const selected = configured || (isProductionRuntime(env) ? "" : "console");
  if (!selected) {
    throw new Error("ANALYTICS_PROVIDER must select a configured production analytics provider.");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(selected)) {
    throw new Error("ANALYTICS_PROVIDER contains an unsupported provider name.");
  }
  if (selected === "console" || selected === "local") {
    if (isProductionRuntime(env)) {
      throw new Error("The console analytics provider is disabled in production.");
    }
    return localAnalytics;
  }
  const provider = registered[selected];
  if (!provider) {
    throw new Error("ANALYTICS_PROVIDER does not identify a registered analytics provider.");
  }
  return provider;
}
