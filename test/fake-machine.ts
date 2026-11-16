// A made-up computer for trying 10 & 2 against a real brain (docs/launch/ring.md): the connector's own pairing, Link,
// Local and Ledger, with the tests' stand-in work system behind them. It has one thread, "Fastest lap" in lap-timer.
// A follow-up sent to it starts a run that replies by itself after `--reply-after` seconds, so "ask Fastest lap to add a
// test and call me back when it's done" is answered with a real reply, and the phone can be rung.
//
//   node connector/test/fake-machine.ts --brain https://10and2-stg.selfdep.com [--reply-after 60] [--control 7311]
//
// The first run pairs it: approve the code on the website, signed in. The credential and ledger are kept in
// ~/.cache/driver-fake-machine/<host>/. While it runs, 127.0.0.1:<control> takes POST /run, /reply and /ask (a question),
// and GET / shows the thread.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Action, Receipt } from "../src/contract.ts";
import { Ledger } from "../src/ledger.ts";
import { Link } from "../src/link.ts";
import { Local } from "../src/local.ts";
import { Expired, linkUrl, originOf, pair } from "../src/pair.ts";
import { parsePolicy } from "../src/policy.ts";
import { FakeAdapter, item } from "./fakes.ts";

const { values } = parseArgs({ options: { brain: { type: "string" }, "reply-after": { type: "string", default: "60" }, control: { type: "string", default: "7311" } } });
if (!values.brain) throw new Error("usage: node connector/test/fake-machine.ts --brain https://10and2-stg.selfdep.com");
const origin = originOf(values.brain);
const replyAfter = Number(values["reply-after"]) * 1000;
const dir = join(homedir(), ".cache", "driver-fake-machine", new URL(origin).host);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

const credentialFile = join(dir, "credential");
let credential = "";
try {
  credential = readFileSync(credentialFile, "utf8").trim();
} catch {
  // A code that runs out before it's approved is replaced by a new one, so this can wait for whoever approves it.
  for (;;) {
    try {
      credential = await pair(origin, { name: "Fake laptop", platform: process.platform }, {
        show: (p) => log(`approve this computer: ${p.verificationUrl} (code ${p.userCode})`),
      });
      break;
    } catch (e) {
      if (!(e instanceof Expired)) throw e;
      log("that code expired; here's a new one");
    }
  }
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  log("paired");
}

const ID = "fastest-lap";
const now = () => new Date().toISOString();
const hourAgo = new Date(Date.now() - 3600_000).toISOString();
const fake = new FakeAdapter([item(ID, { title: "Fastest lap", group: "lap-timer", status: "completed", updatedAt: hourAgo, lastRunAt: hourAgo })]);
fake.placeList = [{ id: "p-lap-timer", name: "lap-timer", activeAt: null }];
let replies = 0;
const setReport = (text: string, question: string | null = null) => {
  const reply = { runId: `r${replies}`, messageId: `m${replies}`, at: now() };
  fake.reports.set(ID, { text, question, reply });
  fake.past.set(ID, [{ ...reply, text, prompt: null }, ...(fake.past.get(ID) ?? [])]);
};
setReport("The lap report now puts a star next to the fastest lap of each session.");
const thread = () => fake.items.find((i) => i.id === ID)!;
let timer: NodeJS.Timeout | undefined;

function run() {
  clearTimeout(timer);
  Object.assign(thread(), { status: "running", pendingQuestion: false, questionId: null, updatedAt: now() });
  fake.emit([ID]);
  log(`Fastest lap: running; it replies in ${replyAfter / 1000} s`);
  timer = setTimeout(reply, replyAfter);
}
function reply() {
  clearTimeout(timer);
  replies++;
  setReport(`Done (reply ${replies}). I added a test for the fastest lap's star, and all 42 tests pass.`);
  Object.assign(thread(), { status: "completed", pendingQuestion: false, questionId: null, updatedAt: now(), lastRunAt: now() });
  fake.emit([ID], true);
  log("Fastest lap: replied");
}
function ask() {
  clearTimeout(timer);
  replies++;
  setReport("Should the star go on the fastest lap overall, or on each driver's fastest lap?", "Overall, or per driver?");
  Object.assign(thread(), { status: "completed", pendingQuestion: true, questionId: `q${replies}`, updatedAt: now(), lastRunAt: now() });
  fake.emit([ID], true);
  log("Fastest lap: asks a question");
}

// A follow-up starts a run, as a coding agent would.
const execute = fake.execute.bind(fake);
fake.execute = async (action: Action, key: string): Promise<Receipt> => {
  const receipt = await execute(action, key);
  log(`${action.kind}${"message" in action ? `: ${action.message}` : ""}`);
  if (action.kind === "follow_up" && action.itemId === ID) run();
  return receipt;
};

const policy = parsePolicy(JSON.stringify({ brain: linkUrl(origin), projects: "*", actions: ["follow_up", "settle", "snooze", "archive", "start_work"], maxRuntimeMode: "full-access" }));
const link = new Link({
  url: policy.brain, token: credential, adapter: new Local([{ prefix: "", adapter: fake, retrySafe: true }], policy), ledger: new Ledger(join(dir, "ledger")), log,
  onFatal: (code) => {
    log(`disconnected for good (${code}): revoked on the website? Delete ${credentialFile} to pair again.`);
    process.exit(1);
  },
  onState: (s) => log(s.linked ? `linked to ${origin}` : `not linked${s.error ? `: ${s.error}` : ""}`),
});
link.start();

createServer((req, res) => {
  const act = { "/run": run, "/reply": reply, "/ask": ask }[req.url ?? ""];
  if (req.method === "POST" && act) act();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(thread()));
}).listen(Number(values.control), "127.0.0.1", () => log(`control: http://127.0.0.1:${values.control} (POST /run, /reply, /ask)`));
