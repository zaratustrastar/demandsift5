/**
 * Whether a scan-pipeline error should leave the record retryable rather
 * than terminal.
 *
 * Split into its own dependency-free module so it can be unit tested
 * directly: `runScan` (lib/server/scan-workflow.ts) has heavy dependencies
 * on AI/Reddit providers that make it impractical to execute end-to-end in
 * a unit test, but this specific decision -- "does a thrown error mean the
 * scan is done, or is a background job attempt about to retry it" -- has
 * none of its own and deserves direct coverage, since getting it wrong is
 * exactly what caused a real production bug: the frontend saw a
 * terminal-looking "failed" status while a retry was already scheduled.
 *
 * Mirrors `TERMINAL_SCAN_ERROR_CODES` in scripts/background-worker.mjs --
 * that script is a standalone Node process with no build step shared with
 * this app, so the two lists cannot import a common module and are kept in
 * sync by hand. Anything NOT in this set is treated as retryable by the job
 * queue's own disposition logic; this copy only needs to agree on which
 * codes are genuinely terminal (retrying would fail identically).
 */
export const JOB_LEVEL_TERMINAL_ERROR_CODES = new Set([
  "scan_review_required",
  "scan_review_changed",
  "scan_configuration_invalid",
  "triage_coverage_incomplete",
  "website_snapshot_mismatch",
  "reddit_enrichment_failed",
  "openai_structured_output_failed",
  "scan_execution_timeout",
  "ai_recovery_exhausted",
  "provider_auth_failed",
  "provider_invalid_request",
  "provider_quota_exhausted",
  "apify_start_ambiguous",
  "apify_recovery_exhausted",
  "apify_reconciliation_required",
]);

export function jobWillRetryScanFailure(input: {
  code?: string;
  jobAttempts?: number;
  jobMaxAttempts?: number;
}): boolean {
  return (
    typeof input.jobAttempts === "number" &&
    typeof input.jobMaxAttempts === "number" &&
    input.jobAttempts < input.jobMaxAttempts &&
    !(input.code && JOB_LEVEL_TERMINAL_ERROR_CODES.has(input.code))
  );
}


function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

/**
 * Convert pipeline failures into stable queue-facing codes. Structured-output
 * providers can fail with several precise messages; all are terminal only
 * after the provider's own bounded same-model retry and comparable-model
 * fallback have been exhausted.
 */
export function scanPipelineErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  const message = errorMessage(error);
  if (
    /OpenAI returned no structured (?:chat )?response text/iu.test(message)
    || /OpenAI returned malformed structured JSON/iu.test(message)
    || /OpenAI structured chat retry did not return a result/iu.test(message)
    || /OpenAI returned (?:an invalid|unknown externalId|duplicate externalId)/iu.test(message)
  ) {
    return "openai_structured_output_failed";
  }
  if (/Reddit enrichment failed/iu.test(message)) return "reddit_enrichment_failed";
  if (/Reddit discovery failed/iu.test(message)) return "reddit_discovery_failed";
  return undefined;
}
