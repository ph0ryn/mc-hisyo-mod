import { Type } from "typebox";

// Optional-test ESM artifact, not the production bridge bundle. Harness loopback only.
export default function directorProbe(pi) {
  const origin = process.env.PI_PROBE_ORIGIN;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? ""))
    throw new Error("Loopback origin required");
  const scenario = process.env.PI_PROBE_SCENARIO;
  const api = process.env.PI_PROBE_API ?? "openai-completions";
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api))
    throw new Error("Unverified API refused");
  let binding;
  let valid = false;
  let settled = true;
  let contextCount = 0;
  let savedBinding;

  async function request(path, body) {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
    return result;
  }
  function requireBinding(captured) {
    if (!valid || !captured || captured !== binding)
      throw new Error("Inactive run binding; side effect rejected");
  }
  async function sendMessage(captured, text) {
    requireBinding(captured);
    return request("/message", { ...captured, text });
  }

  pi.registerProvider("scratch-local", {
    baseUrl: `${origin}/provider${api === "anthropic-messages" ? "" : "/v1"}`,
    apiKey: "dummy-not-a-real-provider-key",
    api,
    models: [
      {
        id: "dummy-model",
        name: "Local dummy only",
        reasoning: true,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsStore: false },
      },
    ],
  });
  pi.registerTool({
    name: "send_message",
    label: "Game Tool Stub",
    description: "Local harness stub only; no game attached.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, args, signal) {
      const captured = binding;
      if (signal?.aborted) throw new Error("Aborted tool invocation");
      const result = await sendMessage(captured, args.text);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
  pi.registerCommand("bind-run", {
    description: "Scratch binding/ACK probe",
    async handler(args) {
      if (!settled) throw new Error("Cannot bind before settled");
      const next = JSON.parse(args);
      if (!next.worldSessionId || !next.runId) throw new Error("Binding required");
      binding = Object.freeze(next);
      savedBinding = binding;
      valid = true;
      contextCount = 0;
      await request("/bound", binding);
    },
  });
  pi.registerCommand("probe-stale", {
    description: "Scratch stale-side-effect negative test",
    async handler() {
      try {
        await sendMessage(savedBinding, "must-not-display");
        await request("/event", { type: "stale_tool_unexpectedly_allowed" });
      } catch (error) {
        await request("/event", { type: "stale_tool_rejected", error: String(error) });
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    await request("/startup", {
      esm: true,
      mode: ctx.mode,
      tools: pi.getActiveTools(),
      systemPrompt: ctx.getSystemPrompt(),
    });
  });
  pi.on("agent_start", () => {
    settled = false;
  });
  pi.on("context", async (event, ctx) => {
    const captured = binding;
    contextCount++;
    try {
      requireBinding(captured);
      const latest = await request("/state", { ...captured, contextCount });
      requireBinding(captured);
      return {
        messages: [
          ...event.messages,
          {
            role: "user",
            content: `LATEST_STATE ${JSON.stringify(latest)}`,
            timestamp: Date.now(),
          },
        ],
      };
    } catch (error) {
      if (scenario === "throw-only") throw error;
      valid = false;
      ctx.abort();
      await request("/event", {
        type: "context_abort",
        contextCount,
        abortedSynchronously: ctx.signal?.aborted,
        error: String(error),
      });
      // Throw is diagnostic only: it is known to be swallowed by Pi's context runner.
      throw error;
    }
  });
  pi.on("agent_end", async () => {
    await request("/event", { type: "extension_agent_end" });
  });
  pi.on("agent_settled", async (event) => {
    settled = true;
    await request("/event", { type: "extension_agent_settled", aborted: event.aborted });
  });
}
