// Node's WebSockets (the `ws` package), for the brain on Lattice and the eval harness. The Durable Object opens its own.
import { WebSocket } from "ws";
import type { LiveConn, OpenSocket, SessionConfig } from "./live.ts";

export const nodeSocket: OpenSocket = (url, headers, on) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 15_000, maxPayload: 8 << 20 });
    let open = false;
    ws.on("open", () => {
      open = true;
      resolve({ send: (data) => ws.readyState === WebSocket.OPEN && ws.send(data), close: () => ws.close() });
    });
    ws.on("message", (data) => on.message(String(data)));
    ws.on("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    // Without a listener an error would be thrown; before opening it fails the attach, afterwards a close follows.
    ws.on("error", (e) => !open && reject(e));
    ws.on("close", () => {
      if (open) on.close();
      else reject(new Error("closed before opening"));
    });
  });

/** Primary WebSocket session (the eval harness): the caller sends `session.input_audio.append` itself. */
export async function createWsSession(apiKey: string, session: SessionConfig, baseURL = "https://api.openai.com/v1"): Promise<LiveConn & { started: Promise<string> }> {
  const ws = new WebSocket(`${baseURL.replace(/^http/, "ws")}/live/sessions`, {
    headers: { authorization: `Bearer ${apiKey}` },
    handshakeTimeout: 15_000,
    maxPayload: 8 << 20,
  });
  const listeners: ((ev: any) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let resolveStarted!: (id: string) => void;
  let rejectStarted!: (e: Error) => void;
  const started = new Promise<string>((res, rej) => {
    resolveStarted = res;
    rejectStarted = rej;
  });
  ws.on("open", () => ws.send(JSON.stringify({ type: "session.start", session })));
  ws.on("message", (data) => {
    let ev: any;
    try {
      ev = JSON.parse(String(data));
    } catch {
      return;
    }
    if (ev?.type === "session.started") resolveStarted(ev.session?.id ?? "ws-session");
    for (const l of listeners) l(ev);
  });
  ws.on("unexpected-response", (_req, res) => rejectStarted(new Error(`OpenAI refused the session (HTTP ${res.statusCode})`)));
  ws.on("error", (e) => rejectStarted(e));
  ws.on("close", () => {
    rejectStarted(new Error("closed before start"));
    closeListeners.forEach((l) => l());
  });
  return {
    started,
    send: (ev) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(ev)),
    onEvent: (l) => listeners.push(l),
    onClose: (l) => closeListeners.push(l),
    terminate: () => ws.terminate(),
  };
}
