import { join, resolve } from "node:path";
import type { CliOptions } from "../cliOptions.js";
import { assertNativePiModel, type NativePiModel } from "../pi/nativePiModel.js";

const messages = {
  read: "Unable to read Pi configuration.",
  json: "Pi configuration requires strict JSON; JSONC is not supported.",
  schema: "Invalid Pi configuration fields.",
  pair: "Configure both defaultProvider and defaultModel, or specify --provider and --model.",
  native: "Selected provider configuration is unsupported; use native models without overrides.",
  credential: "Selected credential is unsupported; use an API key literal or whole ${NAME}.",
  key: "No API key is available from the selected credential source.",
  selector: "Invalid native provider/model selection.",
  path: "Pi configuration paths must be nonempty.",
} as const;
export class DirectorConfigError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
  get diagnostic(): string {
    return messages[this.code];
  }
}
export interface ConfigInput {
  homeDirectory: string;
  readText: (path: string) => string;
  readEnv: (name: string) => string | undefined;
}
export interface TrustedDirectorConfig {
  readonly dataDirectory: string;
  readonly agentDirectory: string;
  readonly executable: string;
  readonly model: Readonly<NativePiModel>;
}
export const validEnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DirectorConfigError("schema");
  return value as Record<string, unknown>;
}
function selected(record: Record<string, unknown>, name: string): unknown {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}
function readConfig(input: ConfigInput, path: string): Record<string, unknown> {
  let text: string;
  try {
    text = input.readText(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw new DirectorConfigError("read");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DirectorConfigError("json");
  }
  return object(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function path(value: string, home: string): string {
  if (!nonempty(value)) throw new DirectorConfigError("path");
  return resolve(
    value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value,
  );
}
function environmentKey(name: string, input: ConfigInput): string {
  if (!validEnvName.test(name)) throw new DirectorConfigError("credential");
  const value = input.readEnv(name);
  if (!nonempty(value)) throw new DirectorConfigError("key");
  return value;
}
function credential(value: unknown, input: ConfigInput): string {
  if (!nonempty(value)) throw new DirectorConfigError("credential");
  const variable = /^\$\{([^{}]*)\}$/.exec(value);
  if (variable) return environmentKey(variable[1]!, input);
  if (value.trimStart().startsWith("!") || value.includes("${"))
    throw new DirectorConfigError("credential");
  return value;
}

/** Host-selected, read-only snapshot. No Pi resolver, catalog, project discovery or writes. */
export function resolveTrustedConfig(
  options: CliOptions,
  input: ConfigInput,
): TrustedDirectorConfig {
  const agentDirectory = path(
    options.agentDirectory ??
      input.readEnv("PI_CODING_AGENT_DIR") ??
      join(input.homeDirectory, ".pi", "agent"),
    input.homeDirectory,
  );
  let provider: unknown = options.provider;
  let id: unknown = options.model;
  if (provider === undefined && id === undefined) {
    const settings = readConfig(input, join(agentDirectory, "settings.json"));
    provider = settings.defaultProvider;
    id = settings.defaultModel;
  }
  if (!nonempty(provider) || !nonempty(id)) throw new DirectorConfigError("pair");
  const models = readConfig(input, join(agentDirectory, "models.json"));
  const providers = models.providers === undefined ? {} : object(models.providers);
  const entry = selected(providers, provider);
  const native = entry === undefined ? {} : object(entry);
  if (Object.keys(native).some((field) => field !== "apiKey"))
    throw new DirectorConfigError("native");
  if (native.apiKey !== undefined && typeof native.apiKey !== "string")
    throw new DirectorConfigError("schema");
  let apiKey: string;
  if (options.apiKeyEnv !== undefined) apiKey = environmentKey(options.apiKeyEnv, input);
  else {
    const stored = selected(readConfig(input, join(agentDirectory, "auth.json")), provider);
    if (stored !== undefined) {
      const auth = object(stored);
      if (
        auth.type !== "api_key" ||
        Object.keys(auth).some((field) => field !== "type" && field !== "key")
      )
        throw new DirectorConfigError("credential");
      apiKey = credential(auth.key, input);
    } else if (native.apiKey !== undefined) apiKey = credential(native.apiKey, input);
    else throw new DirectorConfigError("key");
  }
  const model = Object.freeze({ provider, id, apiKey });
  try {
    assertNativePiModel(model);
  } catch {
    throw new DirectorConfigError("selector");
  }
  return Object.freeze({
    agentDirectory,
    dataDirectory: path(
      options.dataDirectory ?? join(input.homeDirectory, ".mc-hisyo"),
      input.homeDirectory,
    ),
    executable: options.executable.includes("/")
      ? path(options.executable, input.homeDirectory)
      : options.executable,
    model,
  });
}
