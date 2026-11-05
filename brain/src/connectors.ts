// The Node brain's end of the connector links (docs/launch/contracts.md §2): each machine dials in with its own token;
// names come from our config, never from the peer. The protocol itself is connector-client.ts, shared with the cloud.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { CLOSE, PING, PONG, RemoteAdapter, SUBPROTOCOL, type Wire } from "./connector-client.ts";

export { RemoteAdapter } from "./connector-client.ts";
const MAX_FRAME = 8 << 20;
/** The connector pings every 30 s; a socket silent for this long is gone. */
const SILENCE_MS = 75_000;
export type ConnectorConfig = { name: string; tokenSha256: string; local?: boolean };
export function parseConnectors(text: string): ConnectorConfig[] {
  let raw: any;
  try { raw = JSON.parse(text); } catch { throw new Error("DRIVER_CONNECTORS isn't JSON"); }
  if (!Array.isArray(raw)) throw new Error("DRIVER_CONNECTORS must be an array");
  const names = new Set<string>();
  const tokens = new Set<string>();
  let local = false;
  return raw.map((v) => {
    if (!v || typeof v.name !== "string" || !/^[a-zA-Z0-9][\w.-]{0,63}$/.test(v.name) || typeof v.tokenSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(v.tokenSha256) || (v.local !== undefined && typeof v.local !== "boolean")) throw new Error("DRIVER_CONNECTORS needs a machine name, tokenSha256 (64 hex digits), and optional local boolean");
    const hash = v.tokenSha256.toLowerCase();
    if (names.has(v.name) || tokens.has(hash) || (local && v.local)) throw new Error("DRIVER_CONNECTORS repeats a name, token or local machine");
    names.add(v.name); tokens.add(hash); local ||= v.local === true;
    return { name: v.name, tokenSha256: hash, ...(v.local ? { local: true } : {}) };
  });
}

export type ConnectorMachine = ConnectorConfig & { adapter: RemoteAdapter };

export function attachConnectors(server: Server, machines: ConnectorMachine[]) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, handleProtocols: (offered) => offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false });
  const sockets = new Map<WebSocket, { machine: ConnectorMachine; wire: Wire }>();
  const refuse = (socket: { end: (s: string) => void }, status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/connector") { refuse(socket, "404 Not Found"); return; }
    const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const hash = createHash("sha256").update(bearer ?? "").digest();
    const machine = machines.find((m) => timingSafeEqual(hash, Buffer.from(m.tokenSha256, "hex")));
    if (!bearer || !machine) { refuse(socket, "401 Unauthorized"); return; }
    const offered = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim());
    if (!offered.includes(SUBPROTOCOL)) { refuse(socket, "426 Upgrade Required"); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let lastSeen = Date.now();
      const wire: Wire = { send: (t) => ws.send(t), close: (code, reason) => ws.close(code, reason), lastSeen: () => lastSeen };
      sockets.set(ws, { machine, wire });
      const timer = setInterval(() => { if (Date.now() - lastSeen > SILENCE_MS) ws.terminate(); }, 10_000);
      ws.on("error", () => ws.terminate());
      ws.on("close", () => { clearInterval(timer); sockets.delete(ws); machine.adapter.detach(wire); });
      ws.on("message", (data, binary) => {
        lastSeen = Date.now();
        const text = String(data);
        if (binary) { ws.close(1002, "binary frame"); return; }
        if (text === PING) { ws.send(PONG); return; }
        if (!machine.adapter.receive(wire, text)) ws.close(CLOSE.protocol, "invalid frame");
      });
      machine.adapter.attach(wire);
    });
  });
  return {
    close() { for (const ws of sockets.keys()) ws.terminate(); wss.close(); },
    revoke(name: string) {
      // Static config is removed on restart; this closes a device at once and denies it for the life of this server.
      const at = machines.findIndex((m) => m.name === name);
      if (at < 0) return;
      const [m] = machines.splice(at, 1);
      m.adapter.revoke();
    },
  };
}
