// Local executable fixture: actual stdio pipes, no SDK, providers or user configuration.
import { appendFileSync, readFileSync, watch } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

const fixtureIndex = process.argv.indexOf("--fixture");
const config = JSON.parse(
  fixtureIndex < 0
    ? (process.env.MC_HISYO_FAKE ?? "{}")
    : readFileSync(process.argv[fixtureIndex + 1], "utf8"),
);
const log = (record) =>
  appendFileSync(config.capture ?? process.env.MC_HISYO_CAPTURE, `${JSON.stringify(record)}\n`);
if (process.argv.includes("--version")) {
  if (config.version === "hang") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 10_000);
  } else {
    console.log(config.version ?? "1.2.0");
    process.exit(0);
  }
}
let agent;
let releaseBind;
if (config.bridge) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  log({
    launch: {
      args,
      keys: Object.keys(process.env),
      cwd: process.cwd(),
      home: process.env.HOME,
      session: value("--session"),
      settings: JSON.parse(
        readFileSync(`${process.env.PI_CODING_AGENT_DIR}/settings.json`, "utf8"),
      ),
    },
  });
  if (config.bridge !== "missing") {
    const bootstrap = JSON.parse(process.env.MC_HISYO_BRIDGE);
    agent = createConnection({ host: bootstrap.host, port: bootstrap.port });
    const write = (record) => agent.write(`${JSON.stringify({ jsonrpc: "2.0", ...record })}\n`);
    agent.on("connect", () =>
      write({
        id: "hello",
        method: "bridge.hello",
        params: { protocolVersion: 1, role: "agent", token: bootstrap.token },
      }),
    );
    createInterface({ input: agent }).on("line", (line) => {
      const record = JSON.parse(line);
      log({ bridge: record });
      if (record.id === "hello" && !record.error)
        write({ id: "ready", method: "director.ready", params: {} });
      if (record.method === "director.run.bind") {
        const acknowledge = () => write({ id: record.id, result: record.params });
        if (config.delayBind) releaseBind = acknowledge;
        else acknowledge();
      }
    });
  }
}
const mode = config.mode ?? "manual";
const model = { provider: "local", id: "director", api: "openai-completions" };
const state = {
  model,
  thinkingLevel: "medium",
  isStreaming: false,
  isCompacting: false,
  autoCompactionEnabled: false,
  pendingMessageCount: 0,
  ...config.state,
};
let prompt;
let heldState;
let aborted = false;
let active = false;
function emit(...records) {
  for (const record of records) log({ out: record });
  const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  if (mode === "split") {
    const end = bytes.indexOf(Buffer.from("😀")) + 1;
    process.stdout.write(bytes.subarray(0, end));
    setImmediate(() => process.stdout.write(bytes.subarray(end)));
  } else process.stdout.write(bytes);
}
const response = (request, data) => ({
  id: request.id,
  type: "response",
  command: request.type,
  success: true,
  ...(data === undefined ? {} : { data }),
});
const ack = () => emit(response(prompt, { disposition: config.disposition ?? "started" }));
const settled = () => emit({ type: "agent_settled", aborted, ...config.terminal });
let consumed = 0;
const controlPath = config.control ?? process.env.MC_HISYO_CONTROL;
const control = watch(controlPath, () => {
  const commands = readFileSync(controlPath, "utf8").slice(consumed);
  consumed += commands.length;
  for (const command of commands.trim().split("\n")) {
    if (command === "settle") settled();
    if (command === "disconnect-agent") agent?.destroy();
    if (command === "release-bind") {
      releaseBind?.();
      releaseBind = undefined;
    }
    if (command === "ack") {
      if (mode === "preflight") {
        active = true;
        aborted = false;
      }
      ack();
    }
    if (command === "release-state") emit(response(heldState, state));
  }
});
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  log({ in: request });
  if (request.type === "get_available_models")
    emit(response(request, { models: config.models ?? [model] }));
  if (request.type === "get_available_thinking_levels")
    emit(response(request, { levels: config.levels ?? ["off", "low", "medium", "high"] }));
  if (request.type === "get_state") {
    if (mode === "delay-state") {
      heldState = request;
      return;
    }
    if (mode === "timeout") return;
    if (mode === "batch") {
      emit([]);
      return;
    }
    if (mode === "stderr") process.stderr.write("x".repeat(32_768) + "END");
    if (mode === "malformed") {
      process.stdout.write("not-json\n");
      return;
    }
    if (mode === "utf8") {
      process.stdout.write(Buffer.from([255, 10]));
      return;
    }
    if (mode === "oversized") {
      process.stdout.write("x".repeat(1024 * 1024 + 1) + "\n");
      return;
    }
    if (mode === "truncated") {
      process.stdout.write("{", () => process.exit(0));
      return;
    }
    if (mode === "wrong-id") {
      emit({ ...response(request, state), id: "99999" });
      return;
    }
    if (mode === "wrong-command") {
      emit({ ...response(request, state), command: "abort" });
      return;
    }
    if (mode === "rpc-error") {
      emit({ ...response(request), success: false, error: "Fixture refusal" });
      return;
    }
    emit(response(request, { ...state, note: "あ😀" }));
  }
  if (request.type === "prompt") {
    prompt = request;
    if (mode === "preflight") return;
    active = true;
    aborted = false;
    if (mode === "no-ack") return;
    if (mode === "coalesced" || mode === "duplicate") {
      const terminal = { type: "agent_settled", aborted };
      emit(
        response(prompt, { disposition: "started" }),
        { type: "agent_end", willRetry: true },
        terminal,
        ...(mode === "duplicate" ? [terminal] : []),
      );
      return;
    }
    if (mode === "settled-first") {
      settled();
      ack();
      return;
    }
    ack();
    emit({
      type: "agent_end",
      messages: [{ role: "assistant", content: "SILENT" }],
      willRetry: true,
    });
    if (mode === "auto" || mode === "split") settled();
    if (mode === "exit") process.stdout.write("", () => process.exit(0));
  }
  if (request.type === "abort") {
    if (active) aborted = true;
    emit(response(request));
    if (mode === "preflight" && active) settled();
  }
  if (request.type === "clear_queue")
    emit(response(request, { steering: config.queued ?? [], followUp: [] }));
});
input.on("close", () => {
  log({ eof: true });
  if (mode !== "ignore-stop") {
    control.close();
    agent?.destroy();
    process.exitCode = 0;
  }
});
if (mode === "ignore-stop") process.on("SIGTERM", () => log({ term: true }));
