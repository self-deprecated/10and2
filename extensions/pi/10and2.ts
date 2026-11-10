// 10and2 Pi extension (installed by `10and2 pi install`)
/**
 * Lets 10 & 2's connector see and reach this Pi (measured on Pi 1.5.1). Inside every interactive (TUI) or RPC Pi
 * process it listens on a private unix socket and keeps a registry file beside it:
 *   <agentDir>/10and2/<sessionId>.sock
 *   <agentDir>/10and2/<sessionId>.json  { sessionId, sessionFile, cwd, name, pid, mode, status, prompt, questions, piVersion, updatedAt }
 * Print and JSON runs belong to whoever started them, so they get neither.
 *
 * Wire protocol: newline-delimited JSON, one object per line, both directions.
 *   → {"type":"user","text":"…","id":"x","deliverAs":"steer"|"followUp"}   the user's words, as if typed
 *       idle: starts a turn; busy: "steer" (default) lands after the current model response and its tool calls,
 *       "followUp" once the agent has nothing left to do
 *   ← {"type":"ack","id":"x","delivered":"prompt"|"steer"|"followUp"}  or  {"type":"error","id":"x","error":"…"}
 *   → {"type":"status"}       ← {"type":"status", …registry}
 *   → {"type":"subscribe"}    keeps the connection; pushes {"type":"status",…} on every change,
 *       {"type":"settled","aborted","stopReason","text","errorMessage"?}, {"type":"question","questionId","title","options"},
 *       {"type":"question_closed","questionId"}
 *   → {"type":"answer","questionId":"…","value":"SQLite"}   ← {"type":"ack","delivered":"answer"}  (first answer wins)
 * status: "idle" | "busy" | "waiting" (Pi is blocked on any extension's dialog; `prompt` says which, and since when).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir, VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type Status = "idle" | "busy" | "waiting";
type Question = { title: string; options: string[]; answer: (value: string) => void };

export default function (pi: ExtensionAPI) {
	let server: net.Server | undefined;
	let ctx: ExtensionContext | undefined;
	let status: Status = "idle";
	// The dialog Pi is blocked on, any extension's.
	let prompt: { kind: string; title: string | null; since: string } | undefined;
	let sockPath = "";
	let regPath = "";
	const subscribers = new Set<net.Socket>();
	// Questions the connector can answer while this Pi shows the same question; whichever answer comes first wins.
	const questions = new Map<string, Question>();

	const dir = () => path.join(getAgentDir(), "10and2");

	function snapshot() {
		const sm = ctx?.sessionManager;
		return {
			sessionId: sm?.getSessionId(),
			sessionFile: sm?.getSessionFile() ?? null,
			cwd: sm?.getCwd() ?? ctx?.cwd,
			name: sm?.getSessionName() ?? null,
			pid: process.pid,
			mode: ctx?.mode,
			status,
			prompt: prompt ?? null,
			questions: [...questions].map(([questionId, q]) => ({ questionId, title: q.title, options: q.options })),
			piVersion: VERSION,
			updatedAt: new Date().toISOString(),
		};
	}

	function writeRegistry() {
		if (!regPath) return;
		try {
			const tmp = `${regPath}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(snapshot()) + "\n", { mode: 0o600 });
			fs.renameSync(tmp, regPath);
		} catch {
			// The registry is a convenience for the connector; Pi carries on without it.
		}
	}

	function broadcast(obj: unknown) {
		const line = JSON.stringify(obj) + "\n";
		for (const s of subscribers) s.write(line);
	}

	function changed() {
		writeRegistry();
		broadcast({ type: "status", ...snapshot() });
	}

	function setStatus(next: Status) {
		if (next === status) return;
		status = next;
		changed();
	}

	function handle(sock: net.Socket, msg: any) {
		const reply = (o: object) => sock.write(JSON.stringify({ id: msg?.id, ...o }) + "\n");
		if (msg?.type === "status") return reply({ type: "status", ...snapshot() });
		if (msg?.type === "subscribe") {
			subscribers.add(sock);
			return reply({ type: "status", ...snapshot() });
		}
		if (msg?.type === "user") {
			const text = typeof msg.text === "string" ? msg.text.trim() : "";
			if (!text) return reply({ type: "error", error: "empty text" });
			if (!ctx) return reply({ type: "error", error: "no session" });
			const idle = ctx.isIdle();
			const deliverAs = msg.deliverAs === "followUp" ? "followUp" : "steer";
			try {
				// deliverAs is ignored when idle (the message starts a turn) and required while streaming. Words starting
				// with "/" stay words: extension commands and prompt templates aren't expanded.
				pi.sendUserMessage(text, { deliverAs });
			} catch (e) {
				return reply({ type: "error", error: String((e as Error)?.message ?? e) });
			}
			return reply({ type: "ack", delivered: idle ? "prompt" : deliverAs });
		}
		if (msg?.type === "answer") {
			const q = questions.get(msg.questionId);
			if (!q) return reply({ type: "error", error: "no such question" });
			q.answer(String(msg.value));
			return reply({ type: "ack", delivered: "answer" });
		}
		reply({ type: "error", error: `unknown type ${msg?.type}` });
	}

	/**
	 * Asks the user something the connector can answer too: this Pi shows it as a picker meanwhile, and the first answer
	 * wins (the other side's is dismissed). A headless run of Driver's own has nobody at its picker, so only the connector
	 * answers there.
	 */
	async function ask(c: ExtensionContext, title: string, options: string[]): Promise<{ value?: string; via: string }> {
		const questionId = Math.random().toString(36).slice(2, 10);
		const dismiss = new AbortController();
		let remote: string | undefined;
		const remoteAnswer = new Promise<void>((resolve) => {
			questions.set(questionId, {
				title,
				options,
				answer: (v) => {
					remote = v;
					dismiss.abort();
					resolve();
				},
			});
		});
		changed();
		broadcast({ type: "question", questionId, title, options });
		try {
			const local = c.hasUI && process.env.TENANDTWO_PI_HEADLESS !== "1"
				? c.ui.select(title, options, { signal: dismiss.signal })
				: remoteAnswer.then(() => undefined);
			const value = await local;
			if (remote !== undefined) return { value: remote, via: "connector" };
			return { value, via: "local" };
		} finally {
			questions.delete(questionId);
			changed();
			broadcast({ type: "question_closed", questionId });
		}
	}

	// Test only: a model can't be made to ask in tests, so this command takes the path an ask tool would.
	if (process.env.TENANDTWO_PI_TEST === "1") {
		pi.registerCommand("tt-ask", {
			description: "10 & 2 test: ask a question Driver can answer",
			handler: async (args, c) => {
				const r = await ask(c, args || "Which database?", ["Postgres", "SQLite", "Skip"]);
				pi.appendEntry("tenandtwo-answer", r);
				c.ui.notify(`Answer: ${r.value ?? "none"} (${r.via === "connector" ? "from Driver" : "here"})`, "info");
			},
		});
	}

	function listen(p: string): Promise<boolean> {
		return new Promise((resolve) => {
			const srv = net.createServer((sock) => {
				let buf = "";
				sock.setEncoding("utf8");
				sock.on("data", (chunk) => {
					buf += chunk;
					if (buf.length > 1024 * 1024) return sock.destroy();
					let i: number;
					while ((i = buf.indexOf("\n")) >= 0) {
						const line = buf.slice(0, i).trim();
						buf = buf.slice(i + 1);
						if (!line) continue;
						let msg: unknown;
						try {
							msg = JSON.parse(line);
						} catch {
							sock.write(JSON.stringify({ type: "error", error: "bad json" }) + "\n");
							continue;
						}
						handle(sock, msg);
					}
				});
				sock.on("close", () => subscribers.delete(sock));
				sock.on("error", () => subscribers.delete(sock));
			});
			srv.once("error", () => resolve(false));
			srv.listen(p, () => {
				try {
					fs.chmodSync(p, 0o600);
				} catch {
					srv.close();
					return resolve(false);
				}
				server = srv;
				resolve(true);
			});
		});
	}

	// A socket file left by a crashed Pi refuses connections; a live owner accepts them.
	function ownerAlive(p: string): Promise<boolean> {
		return new Promise((resolve) => {
			const c = net.connect(p);
			c.once("connect", () => {
				c.destroy();
				resolve(true);
			});
			c.once("error", () => resolve(false));
		});
	}

	pi.on("session_start", async (_event, c) => {
		if (c.mode !== "tui" && c.mode !== "rpc") return;
		ctx = c;
		status = c.isIdle() ? "idle" : "busy";
		const id = c.sessionManager.getSessionId();
		sockPath = path.join(dir(), `${id}.sock`);
		regPath = path.join(dir(), `${id}.json`);
		try {
			fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
			if (fs.existsSync(sockPath)) {
				if (await ownerAlive(sockPath)) {
					// Another Pi has this session open and stays the one Driver talks to. Both would write to the same
					// file and split it into branches, so the user hears about it.
					if (c.hasUI) c.ui.notify("This session is already open in another Pi. Close one of them, or your messages will end up on separate branches.", "warning");
					sockPath = regPath = "";
					ctx = undefined;
					return;
				}
				fs.rmSync(sockPath, { force: true });
			}
		} catch {
			sockPath = regPath = "";
			ctx = undefined;
			return;
		}
		if (!(await listen(sockPath))) {
			sockPath = regPath = "";
			ctx = undefined;
			return;
		}
		writeRegistry();
	});

	pi.on("agent_start", () => setStatus("busy"));
	pi.on("ui_prompt_start", (event) => {
		prompt = { kind: event.kind, title: event.title ?? null, since: new Date().toISOString() };
		status = "waiting";
		changed();
	});
	pi.on("ui_prompt_end", () => {
		prompt = undefined;
		status = ctx?.isIdle() ? "idle" : "busy";
		changed();
	});
	pi.on("session_info_changed", () => changed());
	pi.on("agent_settled", (event) => {
		const last = [...(ctx?.sessionManager.getBranch() ?? [])]
			.reverse()
			.find((e: any) => e.type === "message" && e.message?.role === "assistant") as any;
		const m = last?.message;
		const text = Array.isArray(m?.content)
			? m.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
			: "";
		setStatus("idle");
		broadcast({ type: "settled", aborted: event.aborted ?? false, stopReason: m?.stopReason, errorMessage: m?.errorMessage, text });
	});

	pi.on("session_shutdown", async () => {
		for (const s of subscribers) s.destroy();
		subscribers.clear();
		await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
		server = undefined;
		if (sockPath) fs.rmSync(sockPath, { force: true });
		if (regPath) fs.rmSync(regPath, { force: true });
		sockPath = regPath = "";
		ctx = undefined;
	});
}
