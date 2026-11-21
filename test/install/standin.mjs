// The install tests' stand-ins, run as root inside the container (scenario.sh), with no network:
//  - npm's registry at http://127.0.0.1:4873, serving the 10and2 tarballs in /pkgs; `latest` is the version named in
//    /run/standin/latest (a scenario changes it to upgrade);
//  - 10 & 2's cloud at https://10and2.selfdep.com (the connector's default address, pointed here in /etc/hosts, with a
//    certificate made now): pairing approves at once with one credential, and the link (/connector) goes to
//  - the real brain from the package under test (`10and2 brain run`), which accepts that credential and no other.
// It writes /run/standin/ready once all three answer. Nothing calls a model: the brain's AI address is a closed port.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as http } from "node:http";
import { createServer as https } from "node:https";
import { connect } from "node:net";

const RUN = "/run/standin";
const PKGS = "/pkgs";
const BRAIN_PORT = 8790;
mkdirSync(RUN, { recursive: true });
const log = (s) => appendFileSync(`${RUN}/events`, `${s}\n`);

// --- the registry ---
const packages = readdirSync(PKGS).filter((f) => f.endsWith(".tgz")).map((file) => {
  const data = readFileSync(`${PKGS}/${file}`);
  const manifest = JSON.parse(execFileSync("tar", ["-xzOf", `${PKGS}/${file}`, "package/package.json"], { encoding: "utf8" }));
  return { file, manifest, data, integrity: `sha512-${createHash("sha512").update(data).digest("base64")}`, shasum: createHash("sha1").update(data).digest("hex") };
});
const REGISTRY = "http://127.0.0.1:4873";
http((req, res) => {
  const url = new URL(req.url, REGISTRY);
  if (url.pathname === "/10and2") {
    const latest = readFileSync(`${RUN}/latest`, "utf8").trim();
    const versions = Object.fromEntries(packages.map((p) => [p.manifest.version, {
      ...p.manifest, _id: `10and2@${p.manifest.version}`, dist: { tarball: `${REGISTRY}/10and2/-/${p.file}`, integrity: p.integrity, shasum: p.shasum },
    }]));
    log(`registry: 10and2 (latest ${latest})`);
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "10and2", "dist-tags": { latest }, versions }));
  }
  const p = packages.find((p) => url.pathname === `/10and2/-/${p.file}`);
  if (p) return res.writeHead(200, { "content-type": "application/octet-stream" }).end(p.data);
  res.writeHead(404, { "content-type": "application/json" }).end("{}");
}).listen(4873, "127.0.0.1");

// --- the brain, from the package under test, accepting the one credential pairing hands out ---
const credential = `dc1.${Buffer.from("user_installtest").toString("base64url")}.${randomBytes(12).toString("base64url")}.${randomBytes(32).toString("base64url")}`;
writeFileSync(`${RUN}/credential`, credential, { mode: 0o600 });
mkdirSync("/opt/brain", { recursive: true });
execFileSync("tar", ["-xzf", `${PKGS}/new.tgz`, "-C", "/opt/brain"]);
mkdirSync("/var/lib/standin-brain", { recursive: true });
const brainLog = openSync(`${RUN}/brain.log`, "a");
spawn(process.execPath, ["/opt/brain/package/bin/10and2.js", "brain", "run"], {
  stdio: ["ignore", brainLog, brainLog],
  env: {
    PATH: process.env.PATH, HOME: "/var/lib/standin-brain", TENANDTWO_NO_SERVICE: "1",
    OPENAI_API_KEY: "sk-install-test-never-used", OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    DRIVER_ACCESS_CODE: randomBytes(18).toString("base64url"), DRIVER_PORT: String(BRAIN_PORT),
    DRIVER_CONNECTORS: JSON.stringify([{ name: "installtest", tokenSha256: createHash("sha256").update(credential).digest("hex") }]),
  },
}).on("exit", (code, signal) => log(`brain: exited (${signal ?? code})`));

// --- the cloud's pairing, and the link passed through to the brain ---
const HOST = "10and2.selfdep.com";
mkdirSync("/etc/10and2-test", { recursive: true });
execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "2", "-subj", `/CN=${HOST}`,
  "-addext", `subjectAltName=DNS:${HOST}`, "-keyout", `${RUN}/key.pem`, "-out", "/etc/10and2-test/ca.pem"], { stdio: "ignore" });
const body = (req) => new Promise((resolve) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } }); });
const cloud = https({ key: readFileSync(`${RUN}/key.pem`), cert: readFileSync("/etc/10and2-test/ca.pem") }, async (req, res) => {
  const json = (status, b) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(b));
  if (req.method === "POST" && req.url === "/connector/pair") {
    const m = await body(req);
    log(`cloud: pair ${m.name} (${m.platform})`);
    return json(200, { deviceCode: "install-test", userCode: "TEST-CODE", verificationUrl: `https://${HOST}/connect?code=TEST-CODE`, expiresIn: 600, interval: 1 });
  }
  if (req.method === "POST" && req.url === "/connector/pair/poll") { log("cloud: approved"); return json(200, { status: "approved", credential }); }
  if (req.method === "POST" && req.url === "/connector/revoke") {
    const ok = req.headers.authorization === `Bearer ${credential}`;
    log(`cloud: revoke${ok ? "" : " (wrong credential)"}`);
    return json(ok ? 200 : 401, {});
  }
  json(404, { error: "not found" });
});
cloud.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/connector")) return socket.destroy();
  log(`cloud: link from ${req.headers["user-agent"] ?? "the connector"}`);
  const brain = connect(BRAIN_PORT, "127.0.0.1", () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    brain.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
    if (head.length) brain.write(head);
    socket.pipe(brain).pipe(socket);
  });
  brain.on("error", () => socket.destroy());
  socket.on("error", () => brain.destroy());
});
cloud.listen(443, "127.0.0.1");

// --- ready once the brain answers ---
for (let i = 0; i < 300; i++) {
  if (await fetch(`http://127.0.0.1:${BRAIN_PORT}/`).then((r) => r.ok, () => false)) { writeFileSync(`${RUN}/ready`, ""); break; }
  await new Promise((r) => setTimeout(r, 100));
}
