import { resolve } from "node:path";
import { loadConfig, type Config, type Env } from "./config.js";
import { createVerifier } from "./auth/verifier.js";
import { createFetchHandler } from "./http.js";
import { jsonLogger, type Logger } from "./log.js";
import { loadDataset } from "./store/dataset-file.js";
import { MemoryRegistryStore } from "./store/memory.js";
import { PostgresRegistryStore } from "./store/postgres.js";
import type { RegistryStore } from "./store/store.js";

export async function createStore(config: Config): Promise<RegistryStore> {
  if (config.registry.source === "postgres") {
    return new PostgresRegistryStore(config.registry.databaseUrl!, { ssl: config.registry.databaseSsl });
  }
  const dataset = await loadDataset(resolve(config.registry.fixturePath!));
  return new MemoryRegistryStore(dataset, "fixture");
}

/** Node runtime: one shared store (connection pool) for the process lifetime. */
export async function bootstrap(env: Env = process.env, logger: Logger = jsonLogger) {
  const config = loadConfig(env);
  const store = await createStore(config);
  const handler = createFetchHandler({
    resourceUrl: config.resourceUrl,
    issuer: config.auth.issuer,
    requiredScope: config.auth.requiredScope,
    scopesSupported: config.auth.scopesSupported,
    serviceVersion: config.serviceVersion,
    verifier: createVerifier(config),
    openStore: () => store,
    logger,
  });
  logger("info", "connector_configured", {
    resource: config.resourceUrl,
    auth_mode: config.auth.mode,
    registry_source: store.kind,
    data_status: store.dataStatus,
    version: config.serviceVersion,
  });
  return { config, store, handler };
}
