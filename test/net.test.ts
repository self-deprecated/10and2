import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { agentProxy, linkAgent, proxyAdvice, proxied, systemCertificates } from "../src/net.ts";

const pem = (n: number) => `-----BEGIN CERTIFICATE-----\nMII${n}\n-----END CERTIFICATE-----`;

test("on Linux the system's certificates are the bundle curl uses: SSL_CERT_FILE, else the distribution's", () => {
  const files: Record<string, string> = {
    "/etc/pki/tls/certs/ca-bundle.crt": `# Fedora\n${pem(1)}\n${pem(2)}\n`,
    "/corp/ca.pem": pem(3),
  };
  const read = (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; };
  assert.deepEqual(systemCertificates("linux", {}, read), [pem(1), pem(2)]);
  assert.deepEqual(systemCertificates("linux", { SSL_CERT_FILE: "/corp/ca.pem" }, read), [pem(3)]);
  assert.deepEqual(systemCertificates("linux", {}, () => { throw new Error("ENOENT"); }), []);
});

test("a proxy is used by the link through Node's own agent (22.21, 24.5), and what to do on a Node that can't", () => {
  assert.equal(proxied({}), false);
  assert.equal(proxied({ https_proxy: "http://proxy:3128" }), true);
  assert.equal(agentProxy([22, 13, 0]), false);
  assert.equal(agentProxy([22, 21, 0]), true);
  assert.equal(agentProxy([23, 11, 0]), false);
  assert.equal(agentProxy([24, 4, 0]), false);
  assert.equal(agentProxy([24, 5, 0]), true);
  assert.equal(agentProxy([26, 0, 0]), true);
  assert.equal(linkAgent("wss://x/connector", {}), undefined, "no proxy: Node's direct connection");
  if (agentProxy()) {
    assert.ok(linkAgent("wss://x/connector", { HTTPS_PROXY: "http://proxy:3128" }) instanceof https.Agent);
    assert.ok(linkAgent("ws://127.0.0.1:8790/connector", { HTTP_PROXY: "http://proxy:3128" }) instanceof http.Agent);
  }
  assert.equal(proxyAdvice({}), null);
  assert.equal(proxyAdvice({ HTTPS_PROXY: "http://p:1", NODE_USE_ENV_PROXY: "1" }), null);
  if (typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv !== "function") {
    assert.match(proxyAdvice({ HTTPS_PROXY: "http://p:1" }, [22, 21, 0]) ?? "", /NODE_USE_ENV_PROXY=1 10and2/);
    assert.match(proxyAdvice({ HTTPS_PROXY: "http://p:1" }, [22, 13, 0]) ?? "", /can't use your proxy.*24\.14/);
  } else assert.equal(proxyAdvice({ HTTPS_PROXY: "http://p:1" }), null, "this Node uses it by itself");
});
