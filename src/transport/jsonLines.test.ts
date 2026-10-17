import { expect, test } from "vite-plus/test";
import { encodeJsonLine, JsonLineDecoder } from "./jsonLines.js";

test("multibyte frames survive every possible byte split and coalesced delivery", () => {
  const values = [{ text: "日本語😀é\nnext" }, { text: "second" }];
  const frames = Buffer.concat(values.map((value) => encodeJsonLine(value)));
  for (let split = 0; split <= frames.length; split++) {
    const decoder = new JsonLineDecoder();
    const decoded: unknown[] = [];
    const receive = (line: string) => decoded.push(JSON.parse(line) as unknown);
    decoder.push(frames.subarray(0, split), receive);
    decoder.push(frames.subarray(split), receive);
    decoder.finish();
    expect(decoded).toEqual(values);
  }
});

test.each([
  [0xc0, 0xaf], // overlong
  [0xed, 0xa0, 0x80], // surrogate
  [0xf4, 0x90, 0x80, 0x80], // above U+10FFFF
  [0x80], // lone continuation
  [0xe3, 0x81], // truncated multibyte character
])("invalid UTF-8 %j fails before delivering a line", (...bytes) => {
  const decoder = new JsonLineDecoder();
  const lines: string[] = [];
  expect(() => decoder.push(Buffer.from([...bytes, 10]), (line) => lines.push(line))).toThrow();
  expect(lines).toEqual([]);
});

test("the byte ceiling excludes LF but never counts multibyte characters as one byte", () => {
  const frame = encodeJsonLine("日", 5);
  const decoder = new JsonLineDecoder(5);
  const lines: string[] = [];
  decoder.push(frame.subarray(0, -1), (line) => lines.push(line));
  expect(lines).toEqual([]);
  decoder.push(Buffer.from("\n"), (line) => lines.push(line));
  decoder.finish();
  expect(lines).toEqual(['"日"']);
  expect(() => encodeJsonLine("日本", 5)).toThrow("byte limit");
  for (const over of [Buffer.from('"日本"\n'), Buffer.from('"日本"')])
    expect(() => new JsonLineDecoder(5).push(over, () => {})).toThrow("byte limit");
});

test("complete frames remain delivered but EOF rejects a trailing partial frame", () => {
  const decoder = new JsonLineDecoder();
  const lines: string[] = [];
  decoder.push(Buffer.from('1\n2\n{"partial":'), (line) => lines.push(line));
  expect(lines).toEqual(["1", "2"]);
  expect(() => decoder.finish()).toThrow("Incomplete JSONL frame at EOF");
});
