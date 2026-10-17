export const supportedPiVersion = "1.2.0";
export { directorToolNames } from "../protocol/directorTools.js";
export const physicalModelApis: ReadonlySet<string> = new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
]);
