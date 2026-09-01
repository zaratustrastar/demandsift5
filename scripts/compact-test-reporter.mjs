// Node's default assertion reporter can print megabytes of compiled data URLs
// and HTML. Keep baseline receipts readable without hiding failed test names.
export default async function* report(events) {
  for await (const event of events) {
    if (event.type === "test:fail") {
      const error = event.data.details?.error;
      const cause = error?.cause ?? error;
      const message = String(cause?.message ?? "failure").replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, "[compiled test module]").slice(0, 240);
      yield `FAIL ${event.data.name}\n  ${event.data.file ?? ""}:${event.data.line ?? ""}\n  ${message}\n`;
    } else if (event.type === "test:summary" && !event.data.file) {
      yield `SUMMARY ${JSON.stringify(event.data)}\n`;
    } else if (event.type === "test:diagnostic" && /^(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b/.test(event.data.message)) {
      yield `${event.data.message}\n`;
    }
  }
}
