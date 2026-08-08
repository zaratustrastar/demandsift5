import { generateReplyWithOpenAi } from "./ai";
import type { OpportunityRecord, ReplyRecord, ScanBusinessProfile } from "./contracts";
import { ApiError } from "./http";
import { getStateRepository } from "./repository";

function alternateDraft(
  profile: ScanBusinessProfile,
  opportunity: OpportunityRecord,
  generation: number,
): string {
  const verifiedFact = profile.features[generation % Math.max(profile.features.length, 1)] ?? profile.summary;
  const lead =
    generation % 2 === 0
      ? "I’d start by writing down the must-have outcome and testing a small real workflow in each option. Setup effort and the quality of the day-to-day process usually reveal more than a long feature list."
      : "The most useful comparison is the one based on your actual bottleneck: pick one recurring task, define what a good result looks like, and see which option gets there with the least ongoing maintenance.";
  return `${lead}\n\nFor transparency, I work with ${profile.name}. Its public site describes ${verifiedFact}. If that is directly relevant to the workflow you mentioned, it may be worth a look alongside the other options—but I’d use the same test for all of them.`;
}

export async function regenerateReply(input: {
  reply: ReplyRecord;
  opportunity: OpportunityRecord;
  profile: ScanBusinessProfile;
}): Promise<ReplyRecord> {
  if (input.reply.status === "published") {
    throw new ApiError("Published replies cannot be regenerated.", 409, "reply_already_published");
  }
  const nextGeneration = input.reply.generation + 1;
  let content: string;
  let usage = null;
  try {
    const generated = await generateReplyWithOpenAi({
      profile: input.profile,
      opportunity: input.opportunity,
      variation: nextGeneration,
    });
    content =
      generated?.content ?? alternateDraft(input.profile, input.opportunity, nextGeneration);
    usage = generated?.usage ?? null;
  } catch (error) {
    console.error("OpenAI reply regeneration failed; using safe draft", error);
    content = alternateDraft(input.profile, input.opportunity, nextGeneration);
  }
  const updated: ReplyRecord = {
    ...input.reply,
    content,
    generation: nextGeneration,
    updatedAt: new Date().toISOString(),
  };
  const repository = getStateRepository();
  await repository.saveReply(updated);
  if (usage) {
    const scan = await repository.getScan(updated.scanId);
    if (scan?.result) {
      scan.result.usage.push(usage);
      scan.updatedAt = new Date().toISOString();
      await repository.saveScan(scan);
    }
  }
  return updated;
}
