import { join, resolve } from "node:path";
import type { CliOptions } from "../cliOptions.js";

const messages = {
  read: "Unable to read Pi credentials.",
  json: "Pi credentials require strict JSON; JSONC is not supported.",
  credential:
    "Selected credential is unsupported; use ChatGPT OAuth or an API key literal or whole ${NAME}.",
  key: "No credential is available from the selected credential source.",
  authentication: "Unable to access or refresh the selected Pi credential.",
  model: "The installed SDK does not provide the pinned openai/gpt-6-luna model.",
  path: "Pi configuration paths must be nonempty.",
} as const;

export class HisyoConfigError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
  get diagnostic(): string {
    return messages[this.code];
  }
}

export interface ConfigInput {
  homeDirectory: string;
  readEnv: (name: string) => string | undefined;
}
export interface TrustedHisyoConfig {
  readonly dataDirectory: string;
  readonly agentDirectory: string;
  readonly apiKeyEnv?: string;
}
export const validEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;

function path(value: string, home: string): string {
  if (!value.trim()) throw new HisyoConfigError("path");
  return resolve(
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}

/** Select only locations; global Pi model/settings files are never configuration inputs. */
export function resolveTrustedConfig(options: CliOptions, input: ConfigInput): TrustedHisyoConfig {
  return Object.freeze({
    agentDirectory: path(
      options.agentDirectory ??
        input.readEnv("PI_CODING_AGENT_DIR") ??
        join(input.homeDirectory, ".pi", "agent"),
      input.homeDirectory,
    ),
    dataDirectory: path(
      options.dataDirectory ?? join(input.homeDirectory, ".mc-hisyo"),
      input.homeDirectory,
    ),
    ...(options.apiKeyEnv === undefined ? {} : { apiKeyEnv: options.apiKeyEnv }),
  });
}
