"use client";

/**
 * Shared top bar for every pre-report onboarding screen (analyzing,
 * competitors, refining, profile/keywords, scanning, restoring, error) --
 * the Scooptr equivalent of the design handoff's persistent step row
 * (design_handoff_scooptr, Scooptr Onboarding.dc.html). Landing and the
 * post-scan report each already have their own header, so this is only
 * ever mounted for the steps between them.
 *
 * Purely presentational: it takes the step the caller is already on and
 * renders progress, it never drives navigation or holds state of its own.
 * The five steps mirror the real view sequence in ThreadlineExperience's
 * `View` union (landing is shown separately, before this bar exists;
 * "report" is shown separately, after it): analyzing -> competitors ->
 * refining/profile -> scanning/restoring.
 */

import styles from "./OnboardingHeader.module.css";

export const ONBOARDING_STEPS = ["Website", "Reading", "Competitors", "Keywords", "Scanning"] as const;

export function OnboardingHeader({
  activeIndex,
  statusLabel,
}: {
  /** Index into ONBOARDING_STEPS of the step currently showing. */
  activeIndex: number;
  /** Optional short status shown in place of the step row (e.g. "Market Scan paused" on the error screen). */
  statusLabel?: string;
}) {
  return (
    <>
      {/* Design handoff (design_handoff_scooptr) specifies Instrument Sans
       * and IBM Plex Mono; loaded here (rather than globally) so the rest
       * of the product experience keeps its existing fonts -- same
       * per-surface scoping used on the landing page and app shell. */}
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      <link
        href="https://fonts.googleapis.com/css2?family=Instrument+Sans:ital,wght@0,400;0,500;0,600;0,700&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        rel="stylesheet"
      />
      <header className={styles.bar}>
        <span className={styles.logo}>
          <span className={styles.logoMark} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className={styles.logoText}>Scooptr</span>
        </span>
        {statusLabel ? (
          <span className={styles.status}>{statusLabel}</span>
        ) : (
          <div className={styles.steps}>
            {ONBOARDING_STEPS.map((label, index) => (
              <div
                key={label}
                className={`${styles.step} ${
                  index === activeIndex ? styles.stepActive : index < activeIndex ? styles.stepDone : ""
                }`}
              >
                <span className={styles.stepDot} />
                <span>{label}</span>
              </div>
            ))}
          </div>
        )}
      </header>
    </>
  );
}
