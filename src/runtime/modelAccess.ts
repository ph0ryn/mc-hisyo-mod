import { join } from "node:path";
import {
  createModels,
  InMemoryCredentialStore,
  type Api,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { HisyoConfigError, type TrustedHisyoConfig } from "./hisyoConfig.js";
import { environmentKey, PiCredentialStore } from "./piCredentialStore.js";

export interface ModelAccess {
  readonly models: Models;
  readonly model: Model<Api>;
  close(): Promise<void>;
}

/** Native SDK provider only: no global model/settings/catalog files or ambient credentials. */
export async function createModelAccess(
  config: Pick<TrustedHisyoConfig, "agentDirectory" | "apiKeyEnv">,
  options: { readEnv?: (name: string) => string | undefined } = {},
): Promise<ModelAccess> {
  const readEnv = options.readEnv ?? ((name: string) => process.env[name]);
  const fileStore =
    config.apiKeyEnv === undefined
      ? new PiCredentialStore(join(config.agentDirectory, "auth.json"), readEnv)
      : undefined;
  const credentials = fileStore ?? new InMemoryCredentialStore();
  try {
    if (config.apiKeyEnv !== undefined) {
      const key = environmentKey(config.apiKeyEnv, readEnv);
      await credentials.modify("openai", async () => ({ type: "api_key", key }));
    }
    if (!(await credentials.read("openai"))) throw new HisyoConfigError("key");
    const runtime = createModels({
      credentials,
      authContext: { env: async () => undefined, fileExists: async () => false },
    });
    runtime.setProvider(openaiProvider());
    const model = runtime.getModel("openai", "gpt-6-luna");
    if (!model) throw new HisyoConfigError("model");
    let closed = false;
    const models: Models = new Proxy(runtime, {
      get(target, property, receiver) {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (closed) throw new HisyoConfigError("authentication");
          const result: unknown = Reflect.apply(value, target, args);
          if (property === "getAuth") {
            return Promise.resolve(result).catch(() => {
              // SDK ModelsError retains provider causes, including OAuth response bodies.
              throw new HisyoConfigError("authentication");
            });
          }
          return result;
        };
      },
    });
    return Object.freeze({
      models,
      model,
      async close() {
        closed = true;
        await fileStore?.close();
      },
    });
  } catch (error) {
    await fileStore?.close();
    if (error instanceof HisyoConfigError) throw error;
    throw new HisyoConfigError("authentication");
  }
}
