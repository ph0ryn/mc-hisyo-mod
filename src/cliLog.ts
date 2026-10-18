/** Human-readable diagnostics only; never forward raw Pi stderr or RPC envelopes. */
export function writeCliLog(event: string, details: Record<string, unknown> = {}): void {
  const json = JSON.stringify(details).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  // ponytail: 4,096-character console previews; add opt-in full logs if larger results need inspection.
  const summary = json.length > 4_096 ? `${json.slice(0, 4_096)}… [truncated]` : json;
  process.stderr.write(`[${new Date().toISOString()}] ${event} ${summary}\n`);
}
