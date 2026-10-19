import { parseArgs } from "node:util";
import { HisyoConfigError, validEnvName } from "./runtime/hisyoConfig.js";

export interface CliOptions {
  help: boolean;
  bridgeOnly: boolean;
  dataDirectory?: string;
  agentDirectory?: string;
  apiKeyEnv?: string;
}

export const usage = `Usage: hisyo [--bridge-only] [--data-dir PATH] [--help]

Minecraft hisyo

Options:
  --help              Show usage without touching state or starting the runtime.
  --bridge-only       Start the authenticated bridge without model access or runs.
  --data-dir PATH     Private state directory (default: ~/.mc-hisyo).
                      Its parent must exist; existing directories must be owned 0700.
  --pi-agent-dir DIR  Pi credential source (default: PI_CODING_AGENT_DIR or ~/.pi/agent).
  --api-key-env NAME  Use this environment variable instead of stored credentials.

Credential options cannot be combined with --bridge-only. The SDK runtime is pinned to
openai/gpt-6-luna with medium thinking. ChatGPT OAuth is refreshed and persisted in the
original credential store under its shared lock. API keys are also supported.
Global Pi models/settings are ignored; credential commands and overrides are rejected.
Private discovery currently requires POSIX permissions. Keep parent directories trusted.
Stop with Ctrl-C or SIGTERM. Stale connection.json requires manual recovery after its owner stops.
`;

const optionMessages = {
  arguments: "Invalid arguments. Check hisyo --help.",
  bridgeOnly: "Credential options cannot be combined with --bridge-only.",
  environment: "Use a valid environment variable name for --api-key-env.",
} as const;
class CliOptionsError extends Error {
  constructor(readonly code: keyof typeof optionMessages) {
    super(optionMessages[code]);
  }
}

export function parseOptions(args: string[]): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        help: { type: "boolean" },
        "bridge-only": { type: "boolean" },
        "data-dir": { type: "string" },
        "pi-agent-dir": { type: "string" },
        "api-key-env": { type: "string" },
      },
      allowPositionals: false,
    }));
  } catch {
    throw new CliOptionsError("arguments");
  }
  if (Object.values(values).some((value) => typeof value === "string" && !value.trim()))
    throw new CliOptionsError("arguments");
  if (
    values["bridge-only"] &&
    [values["pi-agent-dir"], values["api-key-env"]].some((value) => value !== undefined)
  )
    throw new CliOptionsError("bridgeOnly");
  if (values["api-key-env"] !== undefined && !validEnvName.test(values["api-key-env"]))
    throw new CliOptionsError("environment");
  return {
    help: values.help ?? false,
    bridgeOnly: values["bridge-only"] ?? false,
    ...(values["data-dir"] === undefined ? {} : { dataDirectory: values["data-dir"] }),
    ...(values["pi-agent-dir"] === undefined ? {} : { agentDirectory: values["pi-agent-dir"] }),
    ...(values["api-key-env"] === undefined ? {} : { apiKeyEnv: values["api-key-env"] }),
  };
}

/** Never expose arbitrary exceptions, provider diagnostics, or nested cleanup errors. */
export function cliErrorMessage(error: unknown): string {
  if (error instanceof CliOptionsError) return optionMessages[error.code];
  if (error instanceof HisyoConfigError) return error.diagnostic;
  return "Hisyo operation failed.";
}
