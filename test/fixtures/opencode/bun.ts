// Just enough of Bun, on Node, to run 10 & 2's OpenCode plugin (extensions/opencode/10and2.js) in a test: `Bun.serve`
// on a unix socket, or on 127.0.0.1, answering with the plugin's fetch. Bun knows a server's port as soon as it's
// made; Node only once it's listening, so the port here is one the test picked beforehand.
import { createServer } from "node:http";
import type { Server } from "node:http";

type ServeOptions = { unix?: string; hostname?: string; port?: number; idleTimeout?: number; fetch: (req: Request) => Response | Promise<Response> };

export function fakeBun(port: number) {
  const servers: Server[] = [];
  const serve = (o: ServeOptions) => {
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
        const r = await o.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers, body }));
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    servers.push(server);
    // A unix socket is made at once (its file exists when this returns), as Bun's is.
    if (o.unix) server.listen(o.unix);
    else server.listen(o.port || port, o.hostname);
    return { port: o.unix ? undefined : o.port || port };
  };
  const close = () => Promise.all(servers.map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  return { Bun: { serve }, close };
}
