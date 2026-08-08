import type { EmailMessage, EmailProvider } from "@/lib/providers/contracts";
import { isProductionRuntime } from "@/lib/server/runtime-env";

type EmailLogger = (entry: string) => void;

function validateMessage(message: EmailMessage) {
  const recipient = message.to.trim();
  if (
    recipient.length < 3 ||
    recipient.length > 320 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)
  ) {
    throw new Error("Email recipient is invalid.");
  }
  if (!message.subject.trim() || message.subject.length > 998) {
    throw new Error("Email subject is invalid.");
  }
  if (!message.text.trim() || message.text.length > 1_000_000) {
    throw new Error("Email text is invalid.");
  }
  if (message.html && message.html.length > 1_000_000) {
    throw new Error("Email HTML is too large.");
  }
  if (!message.idempotencyKey.trim() || message.idempotencyKey.length > 255) {
    throw new Error("Email idempotency key is invalid.");
  }
}

/**
 * Development-only email sink. It intentionally never logs recipient,
 * subject, body, HTML, or the caller-provided idempotency key.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console-email";
  private readonly sent = new Map<string, string>();

  constructor(private readonly logger: EmailLogger = (entry) => console.info(entry)) {}

  async send(message: EmailMessage): Promise<{ providerMessageId: string }> {
    validateMessage(message);
    const existing = this.sent.get(message.idempotencyKey);
    if (existing) return { providerMessageId: existing };

    const providerMessageId = `local_email_${crypto.randomUUID().replaceAll("-", "")}`;
    this.sent.set(message.idempotencyKey, providerMessageId);
    if (this.sent.size > 10_000) {
      const oldest = this.sent.keys().next().value;
      if (oldest) this.sent.delete(oldest);
    }
    this.logger(
      JSON.stringify({
        event: "local_email_accepted",
        provider: this.name,
        providerMessageId,
      }),
    );
    return { providerMessageId };
  }
}

const localEmail = new ConsoleEmailProvider();

export function createEmailProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  registered: Readonly<Record<string, EmailProvider>> = {},
): EmailProvider {
  const configured = env.EMAIL_PROVIDER?.trim().toLocaleLowerCase("en-US");
  const selected = configured || (isProductionRuntime(env) ? "" : "console");
  if (!selected) {
    throw new Error("EMAIL_PROVIDER must select a configured production email provider.");
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(selected)) {
    throw new Error("EMAIL_PROVIDER contains an unsupported provider name.");
  }
  if (selected === "console" || selected === "local") {
    if (isProductionRuntime(env)) {
      throw new Error("The console email provider is disabled in production.");
    }
    return localEmail;
  }
  const provider = registered[selected];
  if (!provider) {
    throw new Error("EMAIL_PROVIDER does not identify a registered email provider.");
  }
  return provider;
}
