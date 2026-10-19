import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { usage } from "../cliOptions.js";
import { protocolVersion } from "./bridge.js";
import { hisyoTools } from "./hisyoTools.js";

// These assertions cover published contracts, not internal class/file spellings.
test("the executable and CLI help publish the single hisyo name", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  expect(manifest.bin).toEqual({ hisyo: "./dist/cli.mjs" });
  expect(usage).toContain("Usage: hisyo");
});

test("tools publish log searches and hooks without a second vocabulary", () => {
  expect(hisyoTools.map(({ name, method }) => ({ name, method }))).toEqual([
    { name: "get_game_state", method: "game.state.get" },
    { name: "list_game_files", method: "game.files.list" },
    { name: "read_game_file", method: "game.files.read" },
    { name: "search_game_files", method: "game.files.search" },
    { name: "send_message", method: "game.message.send" },
    { name: "list_event_types", method: "hisyo.events.list" },
    { name: "search_events", method: "hisyo.events.search" },
    { name: "add_hook", method: "hisyo.hooks.add" },
    { name: "remove_hook", method: "hisyo.hooks.remove" },
    { name: "list_hooks", method: "hisyo.hooks.list" },
  ]);
});

test("the renamed wire contract uses protocol version 2", () => {
  expect(protocolVersion).toBe(2);
});
