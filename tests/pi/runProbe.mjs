import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

// Optional real-PATH-Pi boundary test; never contacts a real model provider.
const extensionPath = fileURLToPath(new URL("./directorProbe.mjs", import.meta.url));
const supportedApis = ["openai-completions", "openai-responses", "anthropic-messages"];
const supportedScenarios = ["success", "throw-only", "abort-first", "abort-second"];
const apis = process.env.PI_PROBE_APIS?.split(",") ?? supportedApis;
const scenarios = process.argv.slice(2).length ? process.argv.slice(2) : supportedScenarios;
for (const api of apis) assert.ok(supportedApis.includes(api), `Unverified API refused: ${api}`);
for (const scenario of scenarios)
  assert.ok(supportedScenarios.includes(scenario), `Unknown scenario: ${scenario}`);
const version = spawnSync("pi", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, `PATH pi --version failed: ${version.error ?? version.stderr}`);
assert.equal(version.stdout.trim(), "1.2.0", "Only the validated Pi 1.2.0 is supported");
const output = mkdtempSync(join(tmpdir(), "mc-hisyo-pi-"));
const results = [];

async function run(scenario, api) {
  const folder = join(output, api, scenario);
  for (const name of ["", "agent", "sessions", "home", "cwd", "tmp"])
    mkdirSync(join(folder, name), { recursive: true, mode: 0o700 });
  const promptPath = join(folder, "system.md");
  // Director-owned scratch settings only, never the user's agent directory.
  writeFileSync(
    join(folder, "agent", "settings.json"),
    JSON.stringify({ compaction: { enabled: false }, cacheWarming: "off" }, null, 2),
    { mode: 0o600 },
  );
  writeFileSync(
    promptPath,
    "You are a local feasibility probe. Use only the game Tool stub. Never run OS commands.\n",
  );
  const records = [];
  const waiters = new Set();
  const http = [];
  let stdout = "";
  let stderr = "";
  let failure;
  let child;
  let closeResult;
  let providerCount = 0;
  let stateCount = 0;
  let gameCount = 0;
  let hostActive = true;
  let failureProviderCount;
  let failureGameCount;
  const record = (entry) => {
    records.push({ seq: records.length + 1, ...entry });
    for (const waiter of waiters) waiter();
  };
  function waitFor(predicate, label) {
    const prior = records.find(predicate);
    if (prior) return Promise.resolve(prior);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Timeout waiting for ${label}`));
      }, 12000);
      const check = () => {
        const found = records.find(predicate);
        if (found) {
          clearTimeout(timer);
          waiters.delete(check);
          resolve(found);
        }
      };
      waiters.add(check);
    });
  }
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      http.push({ path: req.url, body });
      if (req.url.startsWith("/provider/")) {
        providerCount++;
        record({
          source: "http",
          type: "provider_request",
          number: providerCount,
          path: req.url,
          tools: body.tools?.map((tool) => tool.function?.name ?? tool.name),
        });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const toolArgs = JSON.stringify({ text: "local dummy only" });
        const text = "Local probe complete.";
        const send = (type, data) =>
          res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        if (api === "openai-completions") {
          assert.equal(req.url, "/provider/v1/chat/completions");
          const base = {
            id: `chatcmpl-${providerCount}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "dummy-model",
          };
          const event = (delta, finish_reason = null) =>
            res.write(
              `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          event({ role: "assistant" });
          if (providerCount === 1) {
            event({
              tool_calls: [
                {
                  index: 0,
                  id: "call_stub",
                  type: "function",
                  function: { name: "send_message", arguments: toolArgs },
                },
              ],
            });
            event({}, "tool_calls");
          } else {
            event({ content: text });
            event({}, "stop");
          }
          res.end("data: [DONE]\n\n");
        } else if (api === "openai-responses") {
          assert.equal(req.url, "/provider/v1/responses");
          const response = {
            id: `resp_${providerCount}`,
            status: "in_progress",
            model: "dummy-model",
            output: [],
          };
          send("response.created", { response });
          const item =
            providerCount === 1
              ? {
                  type: "function_call",
                  id: "fc_stub",
                  call_id: "call_stub",
                  name: "send_message",
                  arguments: toolArgs,
                  status: "completed",
                }
              : {
                  type: "message",
                  id: "msg_stub",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text, annotations: [] }],
                };
          send("response.output_item.added", {
            output_index: 0,
            item: { ...item, arguments: "", content: [] },
          });
          if (providerCount === 1)
            send("response.function_call_arguments.delta", {
              output_index: 0,
              item_id: item.id,
              delta: toolArgs,
            });
          else
            send("response.output_text.delta", {
              output_index: 0,
              item_id: item.id,
              content_index: 0,
              delta: text,
            });
          send("response.output_item.done", { output_index: 0, item });
          send("response.completed", {
            response: {
              ...response,
              status: "completed",
              output: [item],
              usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
            },
          });
          res.end();
        } else {
          assert.ok(req.url.startsWith("/provider/v1/messages"));
          send("message_start", {
            message: {
              id: `msg_${providerCount}`,
              type: "message",
              role: "assistant",
              model: "dummy-model",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          });
          if (providerCount === 1) {
            send("content_block_start", {
              index: 0,
              content_block: { type: "tool_use", id: "call_stub", name: "send_message", input: {} },
            });
            send("content_block_delta", {
              index: 0,
              delta: { type: "input_json_delta", partial_json: toolArgs },
            });
          } else {
            send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
            send("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
          }
          send("content_block_stop", { index: 0 });
          send("message_delta", {
            delta: {
              stop_reason: providerCount === 1 ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 1 },
          });
          send("message_stop", {});
          res.end();
        }
        return;
      }
      if (req.url === "/state") {
        stateCount++;
        const failAt = scenario === "abort-second" ? 2 : scenario === "success" ? -1 : 1;
        if (stateCount === failAt) {
          if (scenario !== "throw-only") hostActive = false;
          failureProviderCount = providerCount;
          failureGameCount = gameCount;
          record({
            source: "http",
            type: "latest_state_failed",
            stateCount,
            providerCount,
            gameCount,
            hostActive,
          });
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Required latest state unavailable (local fixture)" }));
          return;
        }
      }
      if (req.url === "/message") {
        if (!hostActive) {
          record({ source: "http", type: "host_rejected_side_effect" });
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid run" }));
          return;
        }
        gameCount++;
        record({ source: "http", type: "game_stub_message", number: gameCount });
      } else record({ source: "http", type: req.url.slice(1), body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          req.url === "/state"
            ? { tick: 42 + stateCount, health: 20, snapshot: stateCount }
            : { ok: true },
        ),
      );
    } catch (error) {
      record({ source: "harness", type: "server_error", path: req.url, error: String(error) });
      failure ??= `Fixture error at ${req.url}: ${String(error)}`;
      if (res.headersSent) res.destroy(error);
      else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--extension",
    extensionPath,
    "--no-mcp",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--append-system-prompt",
    "",
    "--system-prompt",
    promptPath,
    "--no-approve",
    "--no-builtin-tools",
    "--tools",
    "send_message",
    "--session-dir",
    join(folder, "sessions"),
    "--model",
    "scratch-local/dummy-model",
    "--thinking",
    "medium",
    "--api-key",
    "dummy-not-a-real-provider-key",
  ];
  const env = {
    PATH: process.env.PATH,
    HOME: join(folder, "home"),
    USER: "pi-local-probe",
    TMPDIR: join(folder, "tmp"),
    PI_CODING_AGENT_DIR: join(folder, "agent"),
    PI_CODING_AGENT_SESSION_DIR: join(folder, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    PI_PROBE_ORIGIN: origin,
    PI_PROBE_SCENARIO: scenario,
    PI_PROBE_API: api,
  };
  writeFileSync(
    join(folder, "command.json"),
    JSON.stringify({ command: "pi", args, env, cwd: join(folder, "cwd") }, null, 2),
  );
  child = spawn("pi", args, { cwd: join(folder, "cwd"), env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closeResult = { code, signal };
      record({ source: "process", type: "exit", ...closeResult });
      resolve(closeResult);
    }),
  );
  child.on("error", (error) =>
    record({ source: "process", type: "spawn_error", error: String(error) }),
  );
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    const text = decoder.write(chunk);
    stdout += text;
    buffer += text;
    let index;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        record({ source: "rpc", ...JSON.parse(line) });
      } catch (error) {
        record({ source: "harness", type: "invalid_stdout", line, error: String(error) });
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  let serial = 0;
  async function rpc(type, data = {}) {
    const id = `req-${++serial}`;
    const response = waitFor(
      (r) => r.source === "rpc" && r.type === "response" && r.id === id,
      `${type} response`,
    );
    child.stdin.write(`${JSON.stringify({ id, type, ...data })}\n`);
    const result = await response;
    assert.equal(result.success, true, JSON.stringify(result));
    return result;
  }
  try {
    const startup = await waitFor(
      (r) => r.source === "http" && r.type === "startup",
      "extension startup",
    );
    assert.deepEqual(startup.body.tools, ["send_message"]);
    assert.equal(startup.body.mode, "rpc");
    const state = await rpc("get_state");
    assert.equal(state.data.model.provider, "scratch-local");
    assert.equal(state.data.model.id, "dummy-model");
    // Runtime gate before binding or a paid-capable prompt: reject unknown APIs.
    assert.equal(state.data.model.api, api);
    assert.ok(
      ["openai-completions", "openai-responses", "anthropic-messages"].includes(
        state.data.model.api,
      ),
    );
    assert.equal(state.data.thinkingLevel, "medium");
    assert.equal(
      state.data.autoCompactionEnabled,
      false,
      "Auto-compaction must be off before prompts",
    );
    const levels = await rpc("get_available_thinking_levels");
    assert.ok(levels.data.levels.includes("medium"));
    const binding = { worldSessionId: "scratch-world-session", runId: `run-${scenario}` };
    const bind = await rpc("prompt", { message: `/bind-run ${JSON.stringify(binding)}` });
    assert.equal(bind.data.disposition, "handled");
    await waitFor((r) => r.source === "http" && r.type === "bound", "binding ACK");
    assert.equal(providerCount, 0, "No provider before binding");
    assert.equal(
      records.filter((r) => r.type === "agent_settled").length,
      0,
      "Handled command must not start a run",
    );
    // Install final lifecycle subscription before sending the prompt.
    const settledPromise = waitFor(
      (r) => r.source === "rpc" && r.type === "agent_settled",
      "agent_settled",
    );
    const prompt = await rpc("prompt", { message: "Run the local game Tool stub once." });
    assert.equal(prompt.data.disposition, "started");
    const settled = await settledPromise;
    const after = await rpc("get_state");
    const queue = await rpc("clear_queue");
    assert.equal(after.data.isStreaming, false);
    assert.deepEqual(queue.data.steering, []);
    assert.deepEqual(queue.data.followUp, []);
    const messages = await rpc("get_messages");
    assert.ok(
      !JSON.stringify(messages.data).includes("LATEST_STATE"),
      "Transient state must not persist in conversation",
    );
    if (scenario === "success") {
      const requests = http.filter((r) => r.path.startsWith("/provider/"));
      for (const request of requests)
        assert.equal(JSON.stringify(request.body).match(/LATEST_STATE/g)?.length, 1);
      assert.ok(JSON.stringify(requests[0].body).includes('snapshot\\\":1'));
      assert.ok(JSON.stringify(requests[1].body).includes('snapshot\\\":2'));
    }
    if (scenario.startsWith("abort")) {
      assert.equal(settled.aborted, true);
      assert.equal(
        providerCount,
        failureProviderCount,
        "No provider requests after latest-state failure",
      );
      assert.equal(gameCount, failureGameCount, "No game effects after latest-state failure");
      assert.ok(
        records.some(
          (r) =>
            r.type === "event" &&
            r.body.type === "context_abort" &&
            r.body.abortedSynchronously === true,
        ),
      );
      const stale = await rpc("prompt", { message: "/probe-stale" });
      assert.equal(stale.data.disposition, "handled");
      assert.ok(records.some((r) => r.type === "event" && r.body.type === "stale_tool_rejected"));
      assert.equal(
        http.filter((r) => r.path === "/message").length,
        failureGameCount,
        "Stale Tool rejected before bridge HTTP",
      );
      if (scenario === "abort-first") assert.equal(providerCount, 0);
      else {
        assert.equal(providerCount, 1);
        assert.equal(gameCount, 1);
        assert.equal(stateCount, 2);
      }
    } else {
      assert.equal(settled.aborted, false);
      assert.equal(providerCount, 2);
      assert.equal(gameCount, 1);
      assert.equal(stateCount, 2);
    }
    const end = records.find((r) => r.source === "rpc" && r.type === "agent_end");
    assert.ok(end && end.seq < settled.seq, "agent_end precedes final settled");
    assert.equal(records.filter((r) => r.source === "rpc" && r.type === "agent_settled").length, 1);
    assert.ok(!records.some((r) => r.type === "invalid_stdout"));
  } catch (error) {
    failure = String(error.stack ?? error);
  } finally {
    child.stdin.end();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(deadline);
    await new Promise((resolve) => server.close(resolve));
  }
  writeFileSync(join(folder, "stdout.jsonl"), stdout);
  writeFileSync(join(folder, "stderr.txt"), stderr);
  writeFileSync(join(folder, "trace.json"), JSON.stringify(records, null, 2));
  writeFileSync(join(folder, "http.json"), JSON.stringify(http, null, 2));
  const result = {
    api,
    scenario,
    passed: !failure && closeResult.code === 0,
    providerCount,
    stateCount,
    gameCount,
    failureProviderCount,
    failureGameCount,
    exit: closeResult,
    failure,
    folder,
  };
  writeFileSync(join(folder, "result.json"), JSON.stringify(result, null, 2));
  return result;
}
for (const api of apis)
  for (const scenario of scenarios) {
    const result = await run(scenario, api);
    results.push(result);
    console.log(JSON.stringify(result));
  }
const resultsPath = join(output, "results.json");
writeFileSync(
  resultsPath,
  JSON.stringify({ version: version.stdout.trim(), versionExit: version.status, results }, null, 2),
);
console.log(`RESULTS ${resultsPath}`);
if (results.some((r) => !r.passed)) process.exitCode = 1;
