import { createHash } from "node:crypto";
import type { ConversationTriage, RedditDiscoveryCandidate } from "../domain/types";
import type { MarketIntelligenceRecord, OpportunityRecord, Provenance, ReplyRecord, ScanRecord } from "./contracts";

export type PartialCandidatePreview = {
  kind: "candidate_preview";
  id: string;
  version: number;
  fingerprint: string;
  state: "ready";
  qualificationStatus: "pending";
  externalId: string;
  sourceId: string;
  title: string;
  excerpt: string;
  subreddit: string;
  author: string | null;
  permalink: string | null;
  postedAt: string;
  intent: ConversationTriage["intent"];
  demandSignal: ConversationTriage["demandSignal"];
  problem: string | null;
  productFit: ConversationTriage["productFit"];
  sourceMode: RedditDiscoveryCandidate["sourceMode"];
};

export type PartialQualifiedResult = {
  kind: "potential_customer" | "relevant_conversation";
  id: string;
  version: number;
  fingerprint: string;
  state: "ready";
  externalId: string;
  source: Provenance;
  opportunity?: OpportunityRecord;
  intelligence?: MarketIntelligenceRecord;
};

export type PartialReplyResult = {
  kind: "reply";
  id: string;
  version: number;
  fingerprint: string;
  state: "ready" | "pending" | "failed";
  safeErrorCode?: "reply_generation_failed";
  reply: ReplyRecord;
};

export type PartialResultTombstone = {
  id: string;
  kind: PartialCandidatePreview["kind"] | PartialQualifiedResult["kind"] | PartialReplyResult["kind"];
  version: number;
};

export type ScanPartialResults = {
  schemaVersion: 1;
  version: number;
  updatedAt: string | null;
  previews: Record<string, PartialCandidatePreview>;
  qualified: Record<string, PartialQualifiedResult>;
  replies: Record<string, PartialReplyResult>;
  /** Bounded invalidation hints. The endpoint also returns a full snapshot. */
  tombstones: PartialResultTombstone[];
};

export type ScanPartialResultsAccessor = {
  workspaceId: string;
  websiteUrl: string;
  partialResults: ScanPartialResults | null;
};

export function emptyPartialResults(): ScanPartialResults {
  return { schemaVersion: 1, version: 0, updatedAt: null, previews: {}, qualified: {}, replies: {}, tombstones: [] };
}

export function stableScanOutputId(prefix: string, scanId: string, key: string): string {
  const digest = createHash("sha256").update(`${scanId}\u0000${prefix}\u0000${key}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function storeFor(scan: ScanRecord): ScanPartialResults {
  return scan.partialResults ??= emptyPartialResults();
}

function commit(scan: ScanRecord, changed: boolean, now: string): number | null {
  if (!changed) return null;
  const store = storeFor(scan);
  store.version += 1;
  store.updatedAt = now;
  store.tombstones = store.tombstones.slice(-1_000);
  if (scan.runtimeProgress) scan.runtimeProgress.partialResultsVersion = store.version;
  if (scan.timing) scan.timing.firstResultAt ??= now;
  scan.updatedAt = now;
  return store.version;
}

function tombstone(store: ScanPartialResults, value: Omit<PartialResultTombstone, "version">, version: number) {
  store.tombstones = [...store.tombstones.filter(row => row.id !== value.id), { ...value, version }];
}

/** Final-authoritative triage snapshot. Only promising rows become previews;
 * a preview explicitly says qualification is pending and is never a lead. */
export function replaceCandidatePreviews(scan: ScanRecord, candidates: readonly RedditDiscoveryCandidate[], judgments: ReadonlyMap<string, ConversationTriage>, now = new Date().toISOString()): boolean {
  const store = storeFor(scan);
  const desired = new Map<string, Omit<PartialCandidatePreview, "version" | "fingerprint">>();
  for (const candidate of candidates) {
    const triage = judgments.get(candidate.externalId);
    if (!triage?.worthEnriching) continue;
    const id = stableScanOutputId("preview", scan.id, candidate.externalId);
    desired.set(id, { kind: "candidate_preview", id, state: "ready", qualificationStatus: "pending",
      externalId: candidate.externalId, sourceId: candidate.provenance.id,
      title: candidate.title ?? "Conversation being checked", excerpt: candidate.body.slice(0, 500),
      subreddit: candidate.subreddit, author: candidate.author ?? null, permalink: candidate.permalink ?? null,
      postedAt: candidate.createdAt, intent: triage.intent, demandSignal: triage.demandSignal,
      problem: triage.problem ?? null, productFit: triage.productFit, sourceMode: candidate.sourceMode } satisfies Omit<PartialCandidatePreview, "version" | "fingerprint">);
  }
  const changedRows = [...desired.entries()].filter(([id, value]) => store.previews[id]?.fingerprint !== fingerprint(value));
  const removed = Object.values(store.previews).filter(value => !desired.has(value.id));
  if (changedRows.length === 0 && removed.length === 0) return false;
  const version = commit(scan, true, now)!;
  if (desired.size > 0 && scan.timing) scan.timing.firstPreviewAt ??= now;
  const next: Record<string, PartialCandidatePreview> = {};
  for (const [id, value] of desired) {
    const valueFingerprint = fingerprint(value);
    next[id] = store.previews[id]?.fingerprint === valueFingerprint
      ? store.previews[id]
      : { ...value, version, fingerprint: valueFingerprint };
    store.tombstones = store.tombstones.filter(row => row.id !== id);
  }
  for (const value of removed) tombstone(store, { id: value.id, kind: value.kind }, version);
  store.previews = next;
  return true;
}

export function replaceQualifiedPartialResults(scan: ScanRecord, input: {
  opportunities: readonly { externalId: string; record: OpportunityRecord; source: Provenance }[];
  intelligence: readonly { externalId: string; record: MarketIntelligenceRecord; source: Provenance }[];
}, now = new Date().toISOString()): boolean {
  const store = storeFor(scan);
  const desired = new Map<string, Omit<PartialQualifiedResult, "version" | "fingerprint">>();
  for (const value of input.opportunities) desired.set(value.record.id, { kind: "potential_customer", id: value.record.id,
    state: "ready", externalId: value.externalId, source: value.source, opportunity: value.record });
  for (const value of input.intelligence) desired.set(value.record.id, { kind: "relevant_conversation", id: value.record.id,
    state: "ready", externalId: value.externalId, source: value.source, intelligence: value.record });
  const changedRows = [...desired.entries()].filter(([id, value]) => store.qualified[id]?.fingerprint !== fingerprint(value));
  const removedQualified = Object.values(store.qualified).filter(value => !desired.has(value.id));
  const removedPreviews = Object.values(store.previews);
  if (changedRows.length === 0 && removedQualified.length === 0 && removedPreviews.length === 0) return false;
  const version = commit(scan, true, now)!;
  if (desired.size > 0 && scan.timing) scan.timing.firstQualifiedAt ??= now;
  const next: Record<string, PartialQualifiedResult> = {};
  for (const [id, value] of desired) {
    const valueFingerprint = fingerprint(value);
    next[id] = store.qualified[id]?.fingerprint === valueFingerprint
      ? store.qualified[id]
      : { ...value, version, fingerprint: valueFingerprint };
    store.tombstones = store.tombstones.filter(row => row.id !== id);
  }
  for (const value of removedQualified) tombstone(store, { id: value.id, kind: value.kind }, version);
  for (const value of removedPreviews) tombstone(store, { id: value.id, kind: value.kind }, version);
  store.previews = {};
  store.qualified = next;
  return true;
}

export function publishPartialReply(scan: ScanRecord, reply: ReplyRecord, state: PartialReplyResult["state"] = "ready", now = new Date().toISOString()): boolean {
  const store = storeFor(scan);
  const value: Omit<PartialReplyResult, "version" | "fingerprint"> = { kind: "reply", id: reply.id, state, reply,
    ...(state === "failed" ? { safeErrorCode: "reply_generation_failed" as const } : {}) };
  const valueFingerprint = fingerprint(value);
  if (store.replies[reply.id]?.fingerprint === valueFingerprint) return false;
  const version = commit(scan, true, now)!;
  store.replies[reply.id] = { ...value, version, fingerprint: valueFingerprint };
  store.tombstones = store.tombstones.filter(row => row.id !== reply.id);
  return true;
}

export function removePartialRepliesExcept(scan: ScanRecord, retainedIds: ReadonlySet<string>, now = new Date().toISOString()): boolean {
  const store = storeFor(scan);
  const removed = Object.values(store.replies).filter(row => !retainedIds.has(row.id));
  if (removed.length === 0) return false;
  const version = commit(scan, true, now)!;
  for (const row of removed) {
    delete store.replies[row.id];
    tombstone(store, { id: row.id, kind: row.kind }, version);
  }
  return true;
}
