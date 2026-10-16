import { defaultMaxFrameBytes, encodeJsonLine, JsonLineDecoder } from "../transport/jsonLines.js";

export const maxPiJudgmentBytes = defaultMaxFrameBytes;
// Serialized batch JSON has no raw control characters: re-escaping costs at most 2x.
// The existing 256-byte reserve covers known prompt/user-echo envelopes (tested).
// Other raw input or aggregated Pi events must still fit this finite line limit.
export const maxPiFrameBytes = 2 * maxPiJudgmentBytes + 256;

export function encodePiJsonLine(value: unknown): Buffer {
  return encodeJsonLine(value, maxPiFrameBytes);
}

export function createPiJsonLineDecoder(): JsonLineDecoder {
  return new JsonLineDecoder(maxPiFrameBytes);
}
