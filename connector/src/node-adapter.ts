import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { FetchHandler } from "./http.js";

/** Runs a web-standard fetch handler behind node:http (local dev, tests, container hosting). */
export function toNodeHandler(handler: FetchHandler, origin: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
      else if (v !== undefined) headers.set(k, v);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(new URL(req.url ?? "/", origin), {
      method: req.method,
      headers,
      body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
      // @ts-expect-error Node's fetch requires duplex for streamed request bodies.
      duplex: hasBody ? "half" : undefined,
    });
    const response = await handler(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });
    res.writeHead(response.status, outHeaders);
    res.end(Buffer.from(await response.arrayBuffer()));
  };
}
