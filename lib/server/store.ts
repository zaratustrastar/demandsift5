import type {
  CheckoutRecord,
  ConversionRecord,
  EntitlementRecord,
  FunnelEventRecord,
  RedditConnectionRecord,
  RedditPublicationRecord,
  ReplyRecord,
  ScanRecord,
  BackgroundJobRecord,
} from "./contracts";

type WorkspaceRecord = {
  id: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  /** Set once a signed-in user claims this workspace. See UserRecord. */
  userId?: string | null;
};

/** Mirrors the `users` table (see db/postgres/schema.ts) -- unused until
 * Google sign-in (lib/server/google-oauth.ts) started reading/writing it. */
type UserRecord = {
  id: string;
  email: string;
  name: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Mirrors `auth_sessions`. tokenHash is sha256(session token), matching
 * how runtime_workspaces hashes its own token -- see requireWorkspace. */
type AuthSessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
};

type DemoStore = {
  workspaces: Map<string, WorkspaceRecord>;
  scans: Map<string, ScanRecord>;
  replies: Map<string, ReplyRecord>;
  entitlements: Map<string, EntitlementRecord>;
  checkouts: Map<string, CheckoutRecord>;
  conversions: Map<string, ConversionRecord>;
  processedStripeEvents: Set<string>;
  jobs: Map<string, BackgroundJobRecord>;
  redditConnections: Map<string, RedditConnectionRecord>;
  redditPublications: Map<string, RedditPublicationRecord>;
  funnelEvents: Map<string, FunnelEventRecord>;
  users: Map<string, UserRecord>;
  /** Keyed by `${provider}:${providerSubject}` -> userId. */
  authAccountsByProviderSubject: Map<string, string>;
  /** Keyed by tokenHash. */
  authSessions: Map<string, AuthSessionRecord>;
};

const STORE_KEY = Symbol.for("signal-scout.demo-store");

type StoreGlobal = typeof globalThis & { [STORE_KEY]?: DemoStore };

function createStore(): DemoStore {
  return {
    workspaces: new Map(),
    scans: new Map(),
    replies: new Map(),
    entitlements: new Map(),
    checkouts: new Map(),
    conversions: new Map(),
    processedStripeEvents: new Set(),
    jobs: new Map(),
    redditConnections: new Map(),
    redditPublications: new Map(),
    funnelEvents: new Map(),
    users: new Map(),
    authAccountsByProviderSubject: new Map(),
    authSessions: new Map(),
  };
}

export function getStore(): DemoStore {
  const storeGlobal = globalThis as StoreGlobal;
  const existing = storeGlobal[STORE_KEY];

  if (!existing) {
    storeGlobal[STORE_KEY] = createStore();
    return storeGlobal[STORE_KEY];
  }

  // Next.js keeps global state across hot reloads. Fill in collections added by
  // newer server modules so an in-flight development session can upgrade
  // safely instead of requiring a restart.
  existing.workspaces ??= new Map();
  existing.scans ??= new Map();
  existing.replies ??= new Map();
  existing.entitlements ??= new Map();
  existing.checkouts ??= new Map();
  existing.conversions ??= new Map();
  existing.processedStripeEvents ??= new Set();
  existing.jobs ??= new Map();
  existing.redditConnections ??= new Map();
  existing.redditPublications ??= new Map();
  existing.funnelEvents ??= new Map();
  existing.users ??= new Map();
  existing.authAccountsByProviderSubject ??= new Map();
  existing.authSessions ??= new Map();

  return existing;
}

export function getMemoryEffectiveEntitlement(workspaceId: string): EntitlementRecord {
  const store = getStore();
  const existing = store.entitlements.get(workspaceId);

  if (!existing) {
    return {
      workspaceId,
      plan: "free",
      status: "active",
      accessUntil: null,
      seedScanId: null,
      websiteUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      verifiedByEventId: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const passExpiry = existing.accessUntil ? Date.parse(existing.accessUntil) : Number.NaN;
  if (
    existing.plan === "pass" &&
    existing.status === "active" &&
    (!Number.isFinite(passExpiry) || passExpiry <= Date.now())
  ) {
    const expired = {
      ...existing,
      status: "expired" as const,
      updatedAt: new Date().toISOString(),
    };
    store.entitlements.set(workspaceId, expired);
    return expired;
  }

  return existing;
}
