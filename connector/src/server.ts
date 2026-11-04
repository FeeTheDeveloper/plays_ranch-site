import { createServer } from "node:http";
import { bootstrap } from "./bootstrap.js";
import { jsonLogger } from "./log.js";

const { config, store, handler } = await bootstrap();

const server = createServer((req, res) => {
  handler(req, res).catch((err) => {
    jsonLogger("error", "unhandled_request_error", { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) res.writeHead(500).end();
  });
});

server.listen(config.port, () => {
  jsonLogger("info", "connector_listening", { port: config.port });
});

const shutdown = (signal: string) => {
  jsonLogger("info", "connector_shutdown", { signal });
  server.close(() => {
    void store.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
