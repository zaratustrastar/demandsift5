import { createHash } from "node:crypto";
import type { BusinessUnderstanding, EnrichedRedditConversation, DeepQualification, ModelConfiguration } from "../domain/types";
import type { ReplyRecord } from "../server/contracts";
import { canonicalJson } from "./triage-dispatcher";

export const REPLY_INPUT_VERSION = "reply-v2-grounded-full-context";

export type ReplyGenerationCheckpoint = {
  inputVersion: string;
  reply: ReplyRecord;
};

/** Exact same-scan reuse key. It includes profile, model, source/context,
 * qualification, instructions and prompt-policy version; no negative cache. */
export function replyInputVersion(input: {
  business: BusinessUnderstanding;
  models: ModelConfiguration;
  conversation: EnrichedRedditConversation;
  qualification: DeepQualification;
  instructions?: string;
}): string {
  return createHash("sha256").update(canonicalJson({ version: REPLY_INPUT_VERSION, ...input })).digest("hex");
}
