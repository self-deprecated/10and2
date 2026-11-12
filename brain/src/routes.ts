// Every route Driver's brain and Worker answer, as data (docs/launch/standards.md §1): who may call it, who answers it,
// and what a retry does. Nothing routes from this table; the if-chains in server.ts, cloud/src/router.ts, brain.ts,
// byot.ts and pairing.ts do. The checks read both: brain/test/routes.test.ts fails on a route handled there and missing
// here (or listed here and handled nowhere, or for another method), and on one missing from docs/launch/contracts.md; the
// workerd test asks every route for its refusal without the right credential, and every id a route takes (`ids`) with
// another account's.

/**
 * Who may call a route.
 * - `signed_in`: a Clerk session token (contracts §1); on Lattice, the access code. Anything else is 401 `sign_in`.
 * - `anonymous`: no credential, by design, and nothing about an account.
 * - `pairing`: no credential, by design: starts or polls a pairing, which holds nothing until a signed-in user approves
 *   it (contracts §2). Limited per address; the device code is the poll's secret.
 * - `connector`: a machine's device credential (contracts §2); on Lattice, a static token.
 * - `webhook`: the sender's signature (`signature`).
 * - `internal`: only the Worker's own fetches to a user's object (cloud/src/brain.ts), never a request from outside:
 *   the Worker forwards only `/api/*` and `/connector*` with their own paths, so an outside `/internal/*` is 404. These
 *   objects don't look at the method; `method` is the one the Worker sends.
 */
export type Access = "signed_in" | "anonymous" | "pairing" | "connector" | "webhook" | "internal";

/** What an id in a request names, in the account it belongs to. */
export type IdKind = "thread" | "kept" | "proposal" | "reading" | "conversation" | "draft" | "device" | "run" | "message" | "place";

/**
 * A field of a request that names something in the caller's account: the path's `:id`, a query parameter, or a body
 * field (`draft.itemId`: in `draft`, an object or one encoded as JSON; `items.0.keptId`: in its first item). `as`: how
 * the id is written there (`<id>:1`); `with`: the rest of the body, so the request gets as far as using the id, where
 * `<id>` is the id again, `<own:thread>` one of the caller's own threads and `<fresh>` new each time. The workerd test proves it gets that far:
 * the caller's own id must be answered (or change their account) unlike an id from nowhere. Two exceptions say why:
 * `unused`, a field the phone sends that the brain doesn't read (so both answers must stay the same); `unseen`, one
 * whose effect nothing answers right away (so the request with the caller's own id must succeed).
 */
export type IdField = { in: "path" | "query" | "body"; field: string; kind: IdKind; as?: string; with?: Record<string, unknown>; unused?: string; unseen?: string };

export type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** With `:name` for each id in it. */
  path: string;
  access: Access;
  /** The webhook's signature: Stripe's, RevenueCat's, or Clerk's (Svix). */
  signature?: "stripe" | "revenuecat" | "clerk";
  /** Who answers it in the cloud: the Worker itself (router.ts), a pairing's object, or the user's brain. */
  by: "worker" | "pairing" | "brain";
  /** Which brains serve it: the cloud's, Lattice's (the brain on Node), or both. */
  where: "cloud" | "lattice" | "both";
  /** A query and a body valid enough to pass the route's checks, were it reached. */
  query?: string;
  body?: unknown;
  /**
   * A write the phone may send again (a retry after a lost answer, a double tap) that has one effect however often it
   * comes: `key` is what makes it so. brain/test/routes.test.ts sends each twice and expects one effect and the same
   * answer, unless `tested` names the file and test that already show it.
   */
  idempotent?: { key: string; tested?: [file: string, test: string] };
  /** Every field of its request that names something in the account, optional and nested ones too (see `IdField`). */
  ids?: IdField[];
};

const REQUEST_ID = "4f1c2a9e-0001";
const body = (field: string, kind: IdKind, more: Omit<IdField, "in" | "field" | "kind"> = {}): IdField => ({ in: "body", field, kind, ...more });
const query = (field: string, kind: IdKind): IdField => ({ in: "query", field, kind });
const pathId = (kind: IdKind): IdField => ({ in: "path", field: "id", kind });
/** A reply dictated to one of the caller's threads, heard back and kept: what a draft's ids are read in. */
const DICTATED = { mode: "reading", heardBack: true, keepReplies: "keep", draft: JSON.stringify({ id: "draft-<fresh>", itemId: "<own:thread>", parts: [{ text: "Ship it tonight." }] }) };
/** The same, its words said while a reading's first paragraph played (`readingId` and `paragraph`), which it quotes. */
/** A reply left unsent, back to the call to be kept (`keptDraft`), in place of the kept reply it carried on with. */
const LEFT_UNSENT = { mode: "reading", keptItemId: "<own:thread>", keptParts: 1, keptDraft: JSON.stringify({ id: "draft-<fresh>", itemId: "<own:thread>", parts: [{ text: "Ship it tonight." }] }) };
const QUOTING = { ...DICTATED, draft: JSON.stringify({ id: "draft-<fresh>", itemId: "<own:thread>", parts: [{ text: "Ship it tonight.", readingId: "f".repeat(24), paragraph: 0 }] }) };
/** A snooze's time: tomorrow, as the phone sends it. */
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString();

export const ROUTES: Route[] = [
  // Unauthenticated, with nothing about anyone.
  { method: "GET", path: "/health", access: "anonymous", by: "worker", where: "both" },
  { method: "GET", path: "/", access: "anonymous", by: "brain", where: "lattice" },
  { method: "GET", path: "/api/config", access: "anonymous", by: "worker", where: "cloud" },
  { method: "POST", path: "/api/demo/anonymous", access: "anonymous", by: "worker", where: "cloud", body: { installId: "6f9619ff-8b86-d011-b42d-00c04fc964ff", sdp: "v=0 offer" } },

  // Only the Worker's own fetches to a user's Brain or Demo object (cloud/src/brain.ts) reach these.
  { method: "POST", path: "/internal/delete", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/end-call", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/grant", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/close-active", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/analytics-consent", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/devices/add", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/credit", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/revenuecat", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/plan", access: "internal", by: "brain", where: "cloud" },
  { method: "POST", path: "/internal/demo-usage", access: "internal", by: "brain", where: "cloud" },
  { method: "GET", path: "/internal/account", access: "internal", by: "brain", where: "cloud" },
  { method: "GET", path: "/internal/costs", access: "internal", by: "brain", where: "cloud" },

  // Webhooks, each by its signature.
  {
    method: "POST", path: "/stripe/webhook", access: "webhook", signature: "stripe", by: "worker", where: "cloud",
    body: { id: "evt_1", type: "checkout.session.completed", data: { object: { id: "cs_test_1", client_reference_id: "user_a", payment_status: "paid", metadata: { pack: "minutes_60" } } } },
    idempotent: { key: "the Checkout Session (`stripe:<id>`)", tested: ["cloud/test/workerd.test.ts", "credits: a new account's trial, metered by"] },
  },
  {
    method: "POST", path: "/revenuecat/webhook", access: "webhook", signature: "revenuecat", by: "worker", where: "cloud",
    body: { event: { id: "rc_evt_1", type: "NON_RENEWING_PURCHASE", app_user_id: "user_a", product_id: "ai.selfdeprecated.driver.minutes60" } },
    idempotent: { key: "the store's transaction", tested: ["cloud/test/workerd.test.ts", "credits: an App Store pack through RevenueCat, checked against its API, credited once"] },
  },
  {
    method: "POST", path: "/clerk/webhook", access: "webhook", signature: "clerk", by: "worker", where: "cloud",
    body: { type: "user.deleted", data: { id: "user_a", deleted: true } },
    idempotent: { key: "the user: wiping an empty brain does nothing", tested: ["cloud/test/workerd.test.ts", "Clerk's user.deleted wipes a Driver user's brain"] },
  },

  // Connectors (contracts §2).
  { method: "POST", path: "/connector/pair", access: "pairing", by: "pairing", where: "cloud", body: { name: "Quartz", platform: "linux" } },
  { method: "POST", path: "/connector/pair/poll", access: "pairing", by: "pairing", where: "cloud", body: { deviceCode: "ABCDEFGH.0123456789" } },
  { method: "GET", path: "/connector", access: "connector", by: "brain", where: "both" },
  { method: "POST", path: "/connector/revoke", access: "connector", by: "brain", where: "cloud" },
  { method: "GET", path: "/api/connector/pairing", access: "signed_in", by: "pairing", where: "cloud", query: "userCode=ABCD-EFGH" },
  { method: "POST", path: "/api/connector/approve", access: "signed_in", by: "pairing", where: "cloud", body: { userCode: "ABCD-EFGH" } },
  { method: "POST", path: "/api/connector/deny", access: "signed_in", by: "pairing", where: "cloud", body: { userCode: "ABCD-EFGH" } },

  // The account (contracts §1, §3, §4).
  { method: "DELETE", path: "/api/account", access: "signed_in", by: "worker", where: "cloud" },
  { method: "GET", path: "/api/account", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/account/usage", access: "signed_in", by: "brain", where: "cloud" },
  { method: "PUT", path: "/api/account/call-audio", access: "signed_in", by: "brain", where: "cloud", body: { on: false } },
  { method: "PUT", path: "/api/analytics", access: "signed_in", by: "brain", where: "both", body: { share: true } },
  { method: "POST", path: "/api/machines/revoke", access: "signed_in", by: "brain", where: "cloud", body: { deviceId: "d-0123456789" }, ids: [body("deviceId", "device")] },
  { method: "GET", path: "/api/credits/packs", access: "signed_in", by: "worker", where: "cloud" },
  { method: "POST", path: "/api/credits/checkout", access: "signed_in", by: "worker", where: "cloud", body: { pack: "minutes_30" } },
  { method: "POST", path: "/api/credits/portal", access: "signed_in", by: "worker", where: "cloud", body: {} },
  { method: "POST", path: "/api/byot/unlock", access: "signed_in", by: "brain", where: "cloud", body: {} },
  { method: "PUT", path: "/api/byot", access: "signed_in", by: "brain", where: "cloud", body: { key: "sk-proj-0123456789abcdefWXYZ" } },
  { method: "DELETE", path: "/api/byot", access: "signed_in", by: "brain", where: "cloud" },

  // Calls (contracts §3).
  { method: "POST", path: "/api/session", access: "signed_in", by: "brain", where: "both", body: { sdp: "v=0 offer", mode: "new" }, ids: [
      body("conversationId", "conversation", { with: { mode: "continue" } }),
      body("readingIds", "reading", { with: { mode: "reading", heard: "<id>:99" } }),
      body("heard", "reading", { as: "<id>:99", with: { mode: "reading", readingIds: "<own:reading>" } }),
      body("keptItemId", "thread", { with: { mode: "reading", keptParts: 1 } }),
      body("draft.id", "draft", { with: DICTATED }),
      body("draft.itemId", "thread", { with: DICTATED }),
      body("draft.parts.0.readingId", "reading", { with: QUOTING }),
      body("keptDraft.id", "draft", { with: LEFT_UNSENT }),
      body("keptDraft.itemId", "thread", { with: LEFT_UNSENT }),
      body("keptId", "kept", { with: LEFT_UNSENT }),
    ] },
  { method: "POST", path: "/api/session/stop", access: "signed_in", by: "brain", where: "both", body: { cancelWaits: false } },
  { method: "GET", path: "/api/wait", access: "signed_in", by: "brain", where: "both", query: "conversation=c-0123456789&wait=0", ids: [query("conversation", "conversation")] },
  { method: "POST", path: "/api/wait/cancel", access: "signed_in", by: "brain", where: "both", body: {} },
  { method: "GET", path: "/api/drafts/:id", access: "signed_in", by: "brain", where: "both", ids: [pathId("draft")] },
  { method: "GET", path: "/api/calls/current", access: "signed_in", by: "brain", where: "both" },
  {
    method: "POST", path: "/api/proposals/:id/confirm", access: "signed_in", by: "brain", where: "both", body: { requestId: REQUEST_ID }, ids: [pathId("proposal")],
    idempotent: { key: "requestId" },
  },
  {
    method: "POST", path: "/api/proposals/:id/cancel", access: "signed_in", by: "brain", where: "both", body: { requestId: REQUEST_ID }, ids: [pathId("proposal")],
    idempotent: { key: "requestId" },
  },
  { method: "GET", path: "/api/updates", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/conversations", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/conversations/:id", access: "signed_in", by: "brain", where: "both", ids: [pathId("conversation")] },
  { method: "POST", path: "/api/memory/forget", access: "signed_in", by: "brain", where: "both", body: {} },

  // Threads and taps.
  { method: "POST", path: "/api/refresh", access: "signed_in", by: "brain", where: "both", body: {} },
  { method: "GET", path: "/api/state", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/threads", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/timeline", access: "signed_in", by: "brain", where: "both", query: "kind=actions&thread=t-12", ids: [query("thread", "thread")] },
  {
    method: "POST", path: "/api/star", access: "signed_in", by: "brain", where: "both", body: { id: "t-12", starred: true }, ids: [body("id", "thread")],
    idempotent: { key: "starred: it sets the star, never toggles it" },
  },
  {
    method: "POST", path: "/api/snooze", access: "signed_in", by: "brain", where: "both", body: { id: "t-12", until: TOMORROW, requestId: REQUEST_ID }, ids: [body("id", "thread")],
    idempotent: { key: "requestId" },
  },
  {
    method: "POST", path: "/api/settle", access: "signed_in", by: "brain", where: "both", body: { id: "t-12", requestId: REQUEST_ID }, ids: [body("id", "thread")],
    idempotent: { key: "requestId" },
  },
  {
    method: "POST", path: "/api/reply", access: "signed_in", by: "brain", where: "both", body: { id: "t-12", text: "Run it tonight.", requestId: REQUEST_ID }, ids: [body("id", "thread"), body("keptId", "kept"), body("messageId", "message", { with: { id: "<own:thread>" }, unused: "the brain quotes `quote`, never looks the message up" }),
      // A new thread's prompt with no project (`new:` and {"n":"iso00001"}), started where Not sent's picker says.
      body("placeId", "place", { with: { id: "new:eyJuIjoiaXNvMDAwMDEifQ", requestId: "<fresh>" } }),
      // A thread's drafts sent as one message, a reply kept in a call among them.
      body("parts.0.keptId", "kept", { with: { id: "<own:thread>", requestId: "<fresh>", parts: [{ text: "Ship it tonight." }] } })],
    idempotent: { key: "requestId" },
  },

  // Kept replies.
  { method: "GET", path: "/api/kept", access: "signed_in", by: "brain", where: "both" },
  // What the account has done with the app lately: the paywall's header.
  { method: "GET", path: "/api/usage", access: "signed_in", by: "brain", where: "both" },
  // Where a new thread can start, as Driver says them: Not sent's project picker.
  { method: "GET", path: "/api/places", access: "signed_in", by: "brain", where: "both" },
  {
    method: "POST", path: "/api/kept/send", access: "signed_in", by: "brain", where: "both", body: { items: [{ keptId: "K-0123456789", requestId: REQUEST_ID }] }, ids: [body("items.0.keptId", "kept")],
    idempotent: { key: "items[].requestId" },
  },
  {
    method: "PUT", path: "/api/kept/:id", access: "signed_in", by: "brain", where: "both", body: { text: "Run it tonight." }, ids: [pathId("kept")],
    idempotent: { key: "text: it sets the words" },
  },
  { method: "DELETE", path: "/api/kept/:id", access: "signed_in", by: "brain", where: "both", idempotent: { key: "the id: one already gone is discarded too" }, ids: [pathId("kept")] },

  // The user's vocabulary: the words their speech is misheard as (vocabulary.ts).
  { method: "GET", path: "/api/vocabulary", access: "signed_in", by: "brain", where: "both" },
  {
    method: "PUT", path: "/api/vocabulary", access: "signed_in", by: "brain", where: "both", body: { words: [{ word: "embargo", misheard: ["embar go"] }] },
    idempotent: { key: "words: it sets the user's whole list" },
  },

  // Replies read out, and the briefing.
  { method: "GET", path: "/api/inbox", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/replies", access: "signed_in", by: "brain", where: "both", query: "id=t-12", ids: [query("id", "thread")] },
  { method: "GET", path: "/api/voices", access: "signed_in", by: "brain", where: "both" },
  { method: "GET", path: "/api/voices/sample", access: "signed_in", by: "brain", where: "both", query: "voice=marin" },
  { method: "POST", path: "/api/readings", access: "signed_in", by: "brain", where: "both", body: { ids: "t-12", style: "written" }, ids: [body("ids", "thread"), body("messageId", "message", { with: { ids: "<own:thread>" } })] },
  { method: "POST", path: "/api/readings/text", access: "signed_in", by: "brain", where: "both", body: { segments: ["Run it tonight."] } },
  { method: "GET", path: "/api/readings/:id/:n", access: "signed_in", by: "brain", where: "both", query: "voice=marin", ids: [pathId("reading")] },
  { method: "POST", path: "/api/briefing", access: "signed_in", by: "brain", where: "both", body: {} },
  { method: "POST", path: "/api/read", access: "signed_in", by: "brain", where: "both", body: { id: "t-12", messageId: "m-1" }, ids: [
    body("id", "thread", { with: { messageId: "<own:message>" } }),
    body("messageId", "message", { with: { id: "<own:thread>" } }),
    body("conversationId", "conversation", { with: { id: "<own:thread>", messageId: "<own:message>" }, unseen: "a reply heard in a conversation isn't news again in its next call" }),
  ] },

  // The phone's logs.
  {
    method: "POST", path: "/api/diagnostics/log", access: "signed_in", by: "brain", where: "both", body: { run: "phone-0123456789", from: 0, text: "one\ntwo" }, ids: [body("run", "run", { with: { from: 2 } })],
    idempotent: { key: "run and from: lines it has already are skipped" },
  },
  {
    method: "POST", path: "/api/diagnostics/reading-test", access: "signed_in", by: "brain", where: "both", body: { run: "test-0123456789", from: 0, text: "one\ntwo" }, ids: [body("run", "run", { with: { from: 2 } })],
    idempotent: { key: "run and from: lines it has already are skipped" },
  },
];

/** A route's path with each `:name` filled in with a value every route's pattern takes. */
export const samplePath = (r: Route) => r.path.replace(/:n\b/g, "0").replace(/:\w+/g, "0123456789abcdef01234567");

/** Placeholders written either way (`:id`, `<id>`) are the same for comparing. */
export const pathKey = (path: string) => path.replace(/(:\w+|<\w+>)/g, ":");
