import type {
  ApiPartialOpportunity,
  ApiPartialPreview,
  ApiPartialRelevantConversation,
  ApiPartialReply,
  ApiPartialReplyState,
  ApiPartialSnapshot,
  ApiSource,
} from "./from-scan";
import type { RedditDemandDemoData, SuggestedReply } from "./types";

export type LivePartialState = Omit<ApiPartialSnapshot, "snapshot" | "complete"> & {
  newResultsSinceOrder: number;
};

function reconcileById<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  versionOf: (value: T) => number,
): T[] {
  const incomingById = new Map(incoming.map(value => [value.id, value]));
  const currentById = new Map(current.map(value => [value.id, value]));
  const retained = current.flatMap(value => {
    const replacement = incomingById.get(value.id);
    if (!replacement) return [];
    return [versionOf(replacement) >= versionOf(value) ? replacement : value];
  });
  const appended = incoming.filter(value => !currentById.has(value.id));
  return [...retained, ...appended];
}

/** Merge a full bounded snapshot without allowing late responses to roll the
 * UI backward. Existing rows keep their visual position; genuinely new rows
 * append until the user explicitly asks to refresh ranking. */
export function mergeLivePartialState(
  current: LivePartialState | null,
  incoming: ApiPartialSnapshot,
): LivePartialState {
  if (current && incoming.version <= current.version) return current;
  if (!current) return { ...incoming, newResultsSinceOrder: 0 };
  const previousVisible = new Set([
    ...current.previews.map(row => row.id),
    ...current.opportunities.map(row => row.id),
    ...current.relevantConversations.map(row => row.id),
  ]);
  const incomingVisible = [
    ...incoming.previews,
    ...incoming.opportunities,
    ...incoming.relevantConversations,
  ];
  const newVisible = incomingVisible.filter(row => !previousVisible.has(row.id)).length;
  return {
    ...incoming,
    previews: reconcileById<ApiPartialPreview>(current.previews, incoming.previews, row => row.version),
    opportunities: reconcileById<ApiPartialOpportunity>(current.opportunities, incoming.opportunities, row => row.outputVersion),
    relevantConversations: reconcileById<ApiPartialRelevantConversation>(
      current.relevantConversations,
      incoming.relevantConversations,
      row => row.outputVersion,
    ),
    replies: reconcileById<ApiPartialReply>(current.replies, incoming.replies, row => row.outputVersion),
    replyStates: reconcileById<ApiPartialReplyState>(current.replyStates, incoming.replyStates, row => row.outputVersion),
    sources: reconcileById<ApiSource>(current.sources, incoming.sources, () => incoming.version),
    newResultsSinceOrder: current.newResultsSinceOrder + newVisible,
  };
}

export function refreshLiveResultOrder(state: LivePartialState): LivePartialState {
  return {
    ...state,
    previews: [...state.previews].sort((left, right) => Date.parse(right.postedAt) - Date.parse(left.postedAt)),
    opportunities: [...state.opportunities].sort((left, right) =>
      (right.qualificationScore - left.qualificationScore) || (Date.parse(right.postedAt) - Date.parse(left.postedAt))),
    relevantConversations: [...state.relevantConversations].sort((left, right) =>
      ((right.reliabilityScore ?? 0) - (left.reliabilityScore ?? 0)) || (Date.parse(right.postedAt) - Date.parse(left.postedAt))),
    newResultsSinceOrder: 0,
  };
}

export function emptyLivePartialState(): LivePartialState {
  return { schemaVersion: 1, version: 0, updatedAt: null, previews: [], opportunities: [], relevantConversations: [],
    replies: [], replyStates: [], sources: [], tombstones: [],
    foundSoFar: { reviewedCandidates: 0, qualifiedPeople: 0, relevantConversations: 0, repliesReady: 0 },
    newResultsSinceOrder: 0 };
}

/** Carry user text forward when the completed report replaces the live shell.
 * Server content keeps updating underneath, but a local edit wins until the
 * user explicitly regenerates or publishes it. */
export function preserveLiveReplyEdits(
  data: RedditDemandDemoData | null,
  edits: Readonly<Record<string, string>>,
): RedditDemandDemoData | null {
  if (!data || Object.keys(edits).length === 0) return data;
  const preserve = <T extends { reply?: SuggestedReply }>(row: T): T => {
    const edited = row.reply ? edits[row.reply.id] : undefined;
    return edited === undefined ? row : { ...row, reply: { ...row.reply!, draft: edited } };
  };
  return { ...data, opportunities: data.opportunities.map(preserve),
    relevantConversations: (data.relevantConversations ?? []).map(preserve) };
}
