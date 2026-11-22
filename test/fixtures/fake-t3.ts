// A fake T3 Code server for the T3 adapter's tests: the ticket endpoint and a socket that speaks the captured Effect RPC
// frames (t3.test.ts, two-key.test.ts).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/** A fake T3: ticket endpoint plus a socket that speaks the captured Effect RPC frames. */
export async function fakeT3(handlers: { onRequest: (frame: any, ws: WebSocket) => void; tokens?: Set<string> }) {
  const tokens = handlers.tokens ?? new Set(["good"]);
  const frames: any[] = [];
  const sockets: WebSocket[] = [];
  const http = createServer((req, res) => {
    if (req.url === "/api/auth/websocket-ticket" && req.method === "POST") {
      const ok = tokens.has(String(req.headers.authorization).replace("Bearer ", ""));
      res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
      return res.end(JSON.stringify(ok ? { ticket: "tk" } : { error: "no" }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url!, "http://x");
    if (url.searchParams.get("orchestrationProtocol") !== "2" || url.searchParams.get("wsTicket") !== "tk") {
      socket.end("HTTP/1.1 426 Upgrade Required\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.push(ws);
      ws.on("message", (d) => {
        const f = JSON.parse(String(d));
        frames.push(f);
        if (f._tag === "Request") handlers.onRequest(f, ws);
      });
    });
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, frames, sockets, close: () => { for (const s of sockets) s.terminate(); wss.close(); http.close(); } };
}
export const exit = (ws: WebSocket, requestId: number, value: unknown) => ws.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Success", value } }));
export const fail = (ws: WebSocket, requestId: number, message: string) =>
  ws.send(JSON.stringify({ _tag: "Exit", requestId, exit: { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "EnvironmentAuthorizationError", message } } } }));

