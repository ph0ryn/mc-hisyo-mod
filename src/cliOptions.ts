import { parseArgs } from "node:util";
import { HisyoConfigError, validEnvName } from "./runtime/hisyoConfig.js";

export interface CliOptions {
  help: boolean;
  bridgeOnly: boolean;
  dataDirectory?: string;
  executable: string;
  provider?: string;
  model?: string;
  agentDirectory?: string;
  apiKeyEnv?: string;
}

export const usage = `Usage: hisyo [--bridge-only] [--data-dir PATH] [--help]

Minecraft hisyo

Options:
  --help              Show usage without touching state or starting Pi.
  --bridge-only       Start the authenticated bridge without Pi or runs.
  --data-dir PATH     Private state directory (default: ~/.mc-hisyo).
                      Its parent must exist; existing directories must be owned 0700.
  --pi PATH           Pi executable (default: pi on PATH).
  --provider P        Must be openai; specify together with --model.
  --model ID          Must be gpt-6-luna (project default; global defaults are ignored).
  --pi-agent-dir DIR  Pi credential source (default: PI_CODING_AGENT_DIR or ~/.pi/agent).
  --api-key-env NAME  Use this environment variable instead of stored credentials.

Pi options cannot be combined with --bridge-only. Pi is pinned to openai/gpt-6-luna
with medium thinking. ChatGPT OAuth is refreshed by Pi in the original credential store;
API keys are also supported. Custom models, overrides and credential commands are rejected.
Private discovery currently requires POSIX permissions. Keep parent directories trusted.
Stop with Ctrl-C or SIGTERM. Stale connection.json requires manual recovery after its owner stops.
`;

const optionMessages = {
  arguments: "Invalid arguments. Check hisyo --help.",
  bridgeOnly: "Pi options cannot be combined with --bridge-only.",
  pair: "Specify both --provider and --model, or neither.",
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
        pi: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
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
    [values.pi, values.provider, values.model, values["pi-agent-dir"], values["api-key-env"]].some(
      (value) => value !== undefined,
    )
  )
    throw new CliOptionsError("bridgeOnly");
  if ((values.provider === undefined) !== (values.model === undefined))
    throw new CliOptionsError("pair");
  if (values["api-key-env"] !== undefined && !validEnvName.test(values["api-key-env"]))
    throw new CliOptionsError("environment");
  return {
    help: values.help ?? false,
    bridgeOnly: values["bridge-only"] ?? false,
    executable: values.pi ?? "pi",
    ...(values["data-dir"] === undefined ? {} : { dataDirectory: values["data-dir"] }),
    ...(values.provider === undefined ? {} : { provider: values.provider }),
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values["pi-agent-dir"] === undefined ? {} : { agentDirectory: values["pi-agent-dir"] }),
    ...(values["api-key-env"] === undefined ? {} : { apiKeyEnv: values["api-key-env"] }),
  };
}

/** Never expose arbitrary exceptions, child diagnostics, or nested cleanup errors. */
export function cliErrorMessage(error: unknown): string {
  if (error instanceof CliOptionsError) return optionMessages[error.code];
  if (error instanceof HisyoConfigError) return error.diagnostic;
  return "Hisyo operation failed.";
}
