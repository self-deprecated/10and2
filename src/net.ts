// How the connector reaches 10 & 2 from a company laptop: through the proxy HTTPS_PROXY names (NO_PROXY's hosts
// directly), trusting the certificates the computer trusts as well as Node's own, so a company's TLS inspection, whose
// root certificate IT installs in the system's store, doesn't stop it. Node does neither by default.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];
export const proxied = (env: NodeJS.ProcessEnv = process.env) => PROXY_VARS.some((v) => !!env[v]);
const version = (v = process.versions.node) => v.split(".").map(Number) as [number, number, number];
const atLeast = (want: [number, number], [major, minor] = version()) => major > want[0] || (major === want[0] && minor >= want[1]);
/** Node's own proxy support for an agent (`proxyEnv`): 22.21 and 24.5 (23 never had it). */
export const agentProxy = (v = version()) => v[0] === 22 ? atLeast([22, 21], v) : atLeast([24, 5], v);

/** Linux's bundle of trusted certificates, where each family keeps it (what curl and git use). */
const BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt", "/etc/ssl/ca-bundle.pem", "/etc/ssl/cert.pem"];
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

/**
 * The system's trusted certificates: its keychain or certificate store on macOS and Windows, and on Linux the bundle
 * curl uses (SSL_CERT_FILE, else the distribution's), read directly: Node's own reading there looks where the Node build
 * was configured to, which for nodejs.org's builds (nvm, fnm, Volta) isn't where any distribution keeps them.
 */
export function systemCertificates(platform = process.platform, env = process.env, read = (p: string) => readFileSync(p, "utf8")): string[] {
  if (platform !== "linux") return tls.getCACertificates?.("system") ?? [];
  for (const file of [env.SSL_CERT_FILE, ...BUNDLES]) {
    if (!file) continue;
    try { return read(file).match(PEM) ?? []; } catch { /* not this one */ }
  }
  return [];
}

/**
 * Makes this process use the proxy and trust the system's certificates: fetch and Node's own requests through the
 * proxy (Node 24.14 and later; on an older Node, only with NODE_USE_ENV_PROXY=1, which `proxyAdvice` says), and every
 * TLS connection trusting the system's certificates besides Node's (Node 22.19 and later). The link's WebSocket is
 * given its own agent (`linkAgent`). Errors leave Node's defaults.
 */
export function useSystemNetwork(env = process.env) {
  try { if (proxied(env)) (http as { setGlobalProxyFromEnv?: (e: NodeJS.ProcessEnv) => void }).setGlobalProxyFromEnv?.(env); } catch { /* Node's defaults */ }
  if (env.NODE_USE_SYSTEM_CA === "0" || typeof tls.setDefaultCACertificates !== "function") return;
  try {
    const system = systemCertificates();
    if (system.length) tls.setDefaultCACertificates([...new Set([...tls.getCACertificates("default"), ...system])]);
  } catch { /* Node's defaults */ }
}

/** What to do when this Node can't use the proxy by itself, or null when it can (or there's none). */
export function proxyAdvice(env = process.env, v = version()): string | null {
  if (!proxied(env) || typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv === "function" || env.NODE_USE_ENV_PROXY === "1") return null;
  const update = "update Node to 24.14 or newer";
  return agentProxy(v)
    ? `Node ${v.join(".")} uses your proxy (HTTPS_PROXY) only when told to: run it again as NODE_USE_ENV_PROXY=1 10and2 …, or ${update}.`
    : `Node ${v.join(".")} can't use your proxy (HTTPS_PROXY): ${update}.`;
}

/** The agent the link's WebSocket dials through: the proxy's, when there is one and Node can; else Node's direct one. */
export function linkAgent(url: string, env = process.env): http.Agent | undefined {
  if (!proxied(env) || !agentProxy()) return undefined;
  const options = { proxyEnv: env } as http.AgentOptions;
  return url.startsWith("wss:") ? new https.Agent(options) : new http.Agent(options);
}
