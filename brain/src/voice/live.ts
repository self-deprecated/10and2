// Connections to a GPT-Live-1 session, the same on Lattice (Node) and in a Durable Object: sessions are created and hung
// up over `fetch`, and the sideband is a WebSocket opened by the platform's `OpenSocket` (socket-node.ts on Node, the
// brain's Worker in the cloud). The phone's audio goes straight to OpenAI over WebRTC; the brain attaches as the sideband.
import { describe } from "../util.ts";

export interface LiveConn {
  send(ev: object): void;
  onEvent(listener: (ev: any) => void): void;
  onClose(listener: () => void): void;
  terminate(): void;
}

export type SessionConfig = Record<string, unknown>;

/** An open WebSocket, as little as the brain needs of one. */
export interface Socket {
  send(data: string): void;
  close(): void;
}

/** Opens a WebSocket with these headers; resolves once it's open, rejects if it can't open within 15 s. */
export type OpenSocket = (url: string, headers: Record<string, string>, on: { message: (data: string) => void; close: () => void }) => Promise<Socket>;

/** OpenAI's API, or `OPENAI_BASE_URL` (as the OpenAI SDK reads it too): tests point it at a stand-in. */
const openai = () => process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

async function openAiError(res: Response, what: string): Promise<Error> {
  const body: any = await res.json().catch(() => null);
  return Object.assign(new Error(`${what} (HTTP ${res.status})${body?.error?.message ? `: ${body.error.message}` : ""}`), { status: res.status });
}

/**
 * One attempt to end a session at OpenAI. Resolves once OpenAI confirms the session is over (including "already
 * ended"), and throws otherwise: `Hangups` retries until it goes through.
 */
export async function hangup(apiKey: string, sessionId: string, baseURL = openai()): Promise<void> {
  const res = await fetch(`${baseURL}/live/sessions/${encodeURIComponent(sessionId)}/hangup`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(10_000),
  });
  // Already ended is what a hang-up is for.
  if (res.ok || res.status === 404 || res.status === 409 || res.status === 400) return void (await res.body?.cancel());
  throw await openAiError(res, "OpenAI didn't hang up");
}

/** Who answers for a session once it exists: `created` records it, `close` hangs it up until OpenAI confirms. */
export type SessionTrack = { created: (sessionId: string) => void; close: (sessionId: string) => void };

export async function createWebRtcSession(
  apiKey: string,
  session: SessionConfig,
  offerSdp: string,
  log: (m: string) => void,
  track: SessionTrack,
  openSocket: OpenSocket,
  baseURL = openai(),
): Promise<{ sessionId: string; answerSdp: string; conn: LiveConn }> {
  // Never retried: a retried create can leave a second, billed session running.
  const res = await fetch(`${baseURL}/live/sessions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ session, transport: { type: "webrtc", sdp: offerSdp } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw await openAiError(res, "OpenAI refused the session");
  const created: any = await res.json();
  const sessionId = created.session.id as string;
  const answerSdp = created.transport.sdp as string;
  try {
    // It bills from now on: record it before anything else. If even that fails, the catch still hangs it up.
    track.created(sessionId);
    const listeners: ((ev: any) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    // Attach before the phone gets its answer, so the brain hears from the first word.
    const socket = await openSocket(`${baseURL.replace(/^http/, "ws")}/live/sessions/${encodeURIComponent(sessionId)}/attach`, { authorization: `Bearer ${apiKey}` }, {
      message: (data) => {
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          return log(`voice ${sessionId}: sideband sent something that isn't JSON`);
        }
        for (const l of listeners) l(ev);
      },
      close: () => closeListeners.forEach((l) => l()),
    }).catch((e) => {
      throw new Error(`sideband attach failed: ${describe(e)}`);
    });
    return {
      sessionId,
      answerSdp,
      conn: {
        send: (ev) => socket.send(JSON.stringify(ev)),
        onEvent: (l) => listeners.push(l),
        onClose: (l) => closeListeners.push(l),
        terminate: () => {
          socket.close();
          // Unless the sideband already brought session.closed, make sure OpenAI stops billing.
          track.close(sessionId);
        },
      },
    };
  } catch (e) {
    // A failed attach still leaves a created session running (reference §12, item 17).
    track.close(sessionId);
    throw e;
  }
}
