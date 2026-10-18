import { afterEach, expect, test, vi } from "vite-plus/test";
import { writeCliLog } from "./cliLog.js";

afterEach(() => vi.restoreAllMocks());

test("CLI diagnostics have timestamps, stay on stderr, and escape terminal controls", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const stdout = vi.spyOn(process.stdout, "write");
  writeCliLog("tool_execution_start", { text: "hello\n\u001b[2J\u009b2J\u2028\u2029" });
  expect(stderr).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(
      /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] tool_execution_start \{"text":"hello\\n\\u001b\[2J\\u009b2J\\u2028\\u2029"\}\n$/,
    ),
  );
  expect(stdout).not.toHaveBeenCalled();
});

test("large tool results are bounded with an explicit truncation marker", () => {
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  writeCliLog("tool_execution_end", { result: "x".repeat(100_000) });
  const line = String(stderr.mock.calls[0]![0]);
  expect(line.length).toBeLessThan(4_300);
  expect(line).toContain("[truncated]");
  expect(line.endsWith("\n")).toBe(true);
});
