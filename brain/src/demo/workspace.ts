// Demo mode's fixed workspace: a developer's coding-agent threads across five projects, Driver's own among them, as
// they stand when a demo starts. Times are minutes before the demo starts, so every demo hears "12 minutes ago" alike.
// Plain data, no runtime imports: it runs wherever the brain does (Node on Lattice, a Durable Object later).
import type { ItemStatus } from "../adapter.ts";
import type { Card } from "../store.ts";

/** What the briefing says of a reply, written here rather than by the classifier, so a demo never waits on a model. */
export type DemoCard = Pick<Card, "state" | "summary" | "ask" | "suggested" | "answers">;
/** A finished reply: the message that started its run, and how long before the demo it finished. */
export type DemoReply = { text: string; prompt: string; agoMin: number; card: DemoCard };
/** The reply a follow-up gets when the user's words match `when` (or, for a question, pick the option). */
export type Scripted = { when: RegExp; progress: string; text: string; card: DemoCard };
export type DemoThread = {
  id: string;
  title: string;
  project: string;
  status: ItemStatus;
  /** Its replies, newest first. A running thread's first is its last finished one. */
  replies: DemoReply[];
  /** The user has opened it since its latest reply, so that reply isn't new. */
  visited?: boolean;
  /** When the user last wrote in it, if not when its latest run started. */
  wroteAgoMin?: number;
  settled?: boolean;
  snoozedDays?: number;
  /** The thread that spawned it (a subagent). */
  parent?: string;
  /** Asking a question with options (as Claude's AskUserQuestion does); each option's answer gets its reply. */
  question?: { id: string; text: string; options: { label: string; reply: Scripted }[] };
  /** Working when the demo starts, and finishing on its own `finishesInSec` later. */
  running?: { startedAgoMin: number; prompt: string; progress: string; summary: string; finishesInSec: number; text: string; card: DemoCard };
  /** Replies to the follow-ups a demo is likely to send; anything else is written to fit (see adapter.ts). */
  next?: Scripted[];
};

/** How long a follow-up's run takes, and a new thread's first run: long enough to hang up and be called back. */
export const FOLLOW_UP_SECONDS = 20;
export const NEW_WORK_SECONDS = 30;
/** The one machine the demo's threads are on, as the phone shows it. */
export const DEMO_MACHINE = "Demo laptop";

/** What Driver says first, before anything has changed: the briefing's opener for the workspace as it starts. */
export const OPENER =
  "Morning. Two things want a decision: the CarPlay reply tone is asking how to handle music, and the Postgres backups are ready to deploy whenever you say. TestFlight build 58 is waiting for your go to upload, and checkout is blocked on a Stripe test key. Five finished review subthreads could be tidied.";

const decide = (summary: string, ask: string | null = null, answers: string[] = []): DemoCard => ({ state: "needs_decision", summary, ask, suggested: "follow_up", answers });
const ready = (summary: string): DemoCard => ({ state: "ready_to_apply", summary, ask: null, suggested: "follow_up" });
const done = (summary: string): DemoCard => ({ state: "done_unreviewed", summary, ask: null, suggested: "settle" });

export const THREADS: DemoThread[] = [
  // --- driver: Driver itself ---
  {
    id: "demo-carplay-tone",
    title: "CarPlay reply tone",
    project: "driver",
    status: "waiting",
    replies: [{
      agoMin: 14,
      prompt: "Make the reply tone play over CarPlay too, not just the phone speaker.",
      text: "The reply tone now plays over CarPlay as well as the phone speaker. It goes through the same audio session as the call, so it follows whatever route is active, and I added a test that switches routes mid-tone. One thing I need from you before I finish: what should happen to music that's playing when a reply comes in?",
      card: decide("The reply tone plays over CarPlay now; it's asking what to do with music that's playing.", "Duck the music, pause it, or play the tone only?", ["Duck it", "Pause it", "Tone only"]),
    }],
    question: {
      id: "q-carplay-music",
      text: "What should happen to music playing when a reply arrives?",
      options: [
        {
          label: "Duck the music (Recommended)",
          reply: {
            when: /duck|lower|quieter/i,
            progress: "Setting the audio session to duck other audio while the tone plays.",
            text: "Done: music now ducks to about a third of its volume for the tone and comes back over half a second afterwards. I tried it with Apple Music and a podcast in the simulator's CarPlay window, and on the phone speaker. The tone test covers ducking now; all 112 tests pass. It's committed on the branch carplay-tone, not merged. Shall I merge it and ship a TestFlight build?",
            card: ready("Music ducks for the reply tone now; tests pass, and it's ready to merge and ship."),
          },
        },
        {
          label: "Pause the music",
          reply: {
            when: /pause|stop/i,
            progress: "Making the tone pause other audio and resume it afterwards.",
            text: "Done: a reply tone now pauses whatever's playing and resumes it a second after the tone ends. Podcasts pick up where they were. I tested it in the simulator's CarPlay window and on the phone speaker; all 112 tests pass. It's committed on the branch carplay-tone, not merged. Merge it?",
            card: ready("The reply tone pauses music and resumes it; tests pass, ready to merge."),
          },
        },
        {
          label: "Tone only",
          reply: {
            when: /tone only|just the tone|leave|mix|nothing/i,
            progress: "Mixing the tone over other audio without touching it.",
            text: "Done: the tone now plays mixed over the music without changing it, a little louder so it's heard over a song. Tested in the simulator's CarPlay window; all 112 tests pass. Committed on the branch carplay-tone, not merged. Merge it?",
            card: ready("The reply tone plays over the music untouched; tests pass, ready to merge."),
          },
        },
      ],
    },
  },
  {
    id: "demo-demo-mode",
    title: "Demo mode for App Review",
    project: "driver",
    status: "running",
    replies: [{
      agoMin: 55,
      prompt: "Sketch how a demo mode could work for Apple's reviewer: no machine connected, nothing real changes.",
      text: "Here's the plan: a demo adapter in the brain with a fixed fake workspace, selected per account, so the reviewer gets real voice with nothing connected. Every command succeeds and changes nothing, and replies arrive within seconds so call-backs show off. It needs no change to the voice side. Shall I build it?",
      card: decide("It has a plan for a demo mode with a fake workspace and is asking whether to build it.", "Build it?", ["Yes, build it", "Not yet"]),
    }],
    wroteAgoMin: 40,
    running: {
      startedAgoMin: 40,
      prompt: "Yes, build it. Make the fake threads believable.",
      progress: "Writing the fake workspace: 13 threads across 5 projects so far, with questions and subagents.",
      summary: "It's building demo mode: a fake workspace for App Review.",
      finishesInSec: 75,
      text: "Demo mode is in. The brain has a demo adapter with a fixed workspace of 13 threads across 5 projects, with questions, subagents and a snoozed thread; every command succeeds without changing anything, and replies arrive about 20 seconds after a follow-up. It's picked per account, so App Review lands in it. All 412 tests pass. It's on the branch demo-mode, not merged yet. Want me to merge it and deploy to the staging brain?",
      card: ready("Demo mode is built and tests pass; it's asking to merge it and deploy to staging."),
    },
    next: [{
      when: /merge|deploy|ship|go ahead|yes|do it/i,
      progress: "Merging demo-mode and deploying the staging brain.",
      text: "Merged demo-mode into main and deployed it to the staging brain. I signed in with the App Review account on the simulator: it went straight into the demo workspace, a call-back came 21 seconds after a follow-up, and nothing reached a real machine. Production is untouched.",
      card: done("Demo mode is merged and running on the staging brain; App Review's account lands in it."),
    }],
  },
  {
    id: "demo-testflight-58",
    title: "TestFlight build 58",
    project: "driver",
    status: "completed",
    replies: [
      {
        agoMin: 38,
        prompt: "Bump the build, run the tests and archive it, but don't upload yet.",
        text: "Build 58 is archived and signed. All 112 unit tests and the 9 UI tests pass, and the archive is 41 megabytes. I haven't uploaded it: it's the first build for external testers, so Apple's Beta App Review will look at it, and that wants the reviewer notes and the privacy policy link in App Store Connect. Both are filled in. Shall I upload it and submit it for review?",
        card: decide("Build 58 is archived and tests pass; it's waiting for your go to upload it and submit it for review.", "Upload build 58 and submit it for review?", ["Yes, upload it", "Not yet"]),
      },
      {
        agoMin: 300,
        prompt: "Why did build 57 crash when CarPlay disconnected?",
        text: "Build 57 crashed when CarPlay disconnected during a reading: the reader kept a reference to the old audio route and played into it after it was gone. I've made the reader rebuild its route on every change, and added a test that pulls CarPlay mid-reading. Fixed on main; it'll be in build 58.",
        card: done("It found and fixed the CarPlay disconnect crash from build 57."),
      },
    ],
    next: [{
      when: /upload|submit|ship|send it|go ahead|yes|do it/i,
      progress: "Uploading build 58 to App Store Connect.",
      text: "Build 58 is uploaded and submitted for Beta App Review, with the reviewer notes and the demo sign-in. Internal testers have it now; external testers get it once Apple approves it, usually within a day. I'll leave the review to Apple; nothing else is pending.",
      card: done("Build 58 is uploaded and submitted for Beta App Review; internal testers have it."),
    }],
  },
  {
    id: "demo-review-reading",
    title: "Review the reading pipeline",
    project: "driver",
    status: "completed",
    replies: [{
      agoMin: 70,
      prompt: "Have five reviewers go over the reading pipeline, then fix whatever more than one of them finds.",
      text: "All five reviews are in. Three of them found the same bug: a reply split into parts could drop the last sentence when it ended without a full stop. I fixed it and added a test with a reply that ends in a code block. The other findings were style nits, which I've left alone. Everything's committed and merged; the five review subthreads are finished and can be settled.",
      card: done("All five reviews are in; the bug three of them found is fixed and merged."),
    }],
  },
  ...["Orion", "Astra", "Fable", "Lyra", "Vega"].map((name, k): DemoThread => ({
    id: `demo-review-reading-${k + 1}`,
    title: `Review round ${k + 1}: ${name}`,
    project: "driver",
    status: "completed",
    parent: "demo-review-reading",
    visited: true,
    replies: [{
      agoMin: 75 + k,
      prompt: "Review the reading pipeline for correctness.",
      text: k < 3 ? "One real bug: a reply split into parts loses its last sentence when it doesn't end with a full stop. Everything else is style." : "No bugs found. Two style nits in reading.ts: a long function that could be split, and a comment that no longer matches the code.",
      card: done(k < 3 ? "Found the dropped last sentence bug." : "No bugs found; two style nits."),
    }],
  })),
  {
    id: "demo-dark-mode",
    title: "Dark mode for Settings",
    project: "driver",
    status: "completed",
    settled: true,
    visited: true,
    replies: [{
      agoMin: 1600,
      prompt: "Settings looks wrong in dark mode, fix it.",
      text: "Settings now follows dark mode: the section backgrounds and the voice picker were hard-coded white. Merged.",
      card: done("Settings follows dark mode now; merged."),
    }],
  },

  // --- storefront: a web shop ---
  {
    id: "demo-checkout-stripe",
    title: "Checkout with Stripe Payment Element",
    project: "storefront",
    status: "completed",
    replies: [
      {
        agoMin: 55,
        prompt: "Now wire the Payment Element into the checkout page and test it end to end.",
        text: "The Payment Element is wired into checkout, with Apple Pay and cards, and the order is only marked paid from the webhook. I can't test it end to end: there's no Stripe test key in .env.local, and I can't create one. If there's one I can use, tell me where it is, or paste it into .env.local and I'll carry on.",
        card: { state: "blocked", summary: "Checkout is wired up, but it can't be tested without a Stripe test key.", ask: "Where's a Stripe test key it can use?", suggested: "follow_up" },
      },
      {
        agoMin: 180,
        prompt: "Plan moving checkout from Stripe Checkout redirects to the Payment Element.",
        text: "Plan: keep the cart and order models as they are, add a payment intent when checkout opens, render the Payment Element in place of the redirect button, and confirm the order only from the webhook so a closed tab can't lose a payment. About a day's work. I'll start with the webhook.",
        card: done("It planned the move to the Payment Element, starting with the webhook."),
      },
    ],
    wroteAgoMin: 180,
    next: [{
      when: /doppler|key|env|vault|use|found|paste|there/i,
      progress: "Loading the Stripe test key and running checkout end to end.",
      text: "Found the test key in Doppler's dev config and loaded it locally. Checkout works end to end in test mode: a card payment, Apple Pay in Safari, and a declined card that shows the right message. The webhook marks the order paid within a second. I added three Playwright tests; all 41 pass. It's committed on the branch payment-element, not merged. Shall I open a pull request?",
      card: ready("Checkout works end to end with the test key; tests pass and it's ready for a pull request."),
    }],
  },
  {
    id: "demo-flaky-cart",
    title: "Fix the flaky cart test",
    project: "storefront",
    status: "completed",
    visited: true,
    replies: [{
      agoMin: 130,
      prompt: "The cart total test fails about one run in ten. Find out why and fix it.",
      text: "The flake was a race: the test read the cart total before the price update from the server had landed. The test now waits for the update, and the cart no longer shows a stale total for a moment either, which was a real bug. I ran it 200 times with no failures. Merged into main after CI passed.",
      card: done("The flaky cart test was a race; it's fixed, along with a real stale-total bug, and merged."),
    }],
  },
  {
    id: "demo-product-search",
    title: "Product search with Postgres full text",
    project: "storefront",
    status: "running",
    replies: [{
      agoMin: 45,
      prompt: "Compare Postgres full text search with Meilisearch for product search.",
      text: "For 48,000 products Postgres full text search is enough: queries take under 20 milliseconds with a GIN index, it handles stemming and typos well enough with trigrams, and it needs nothing new to run. Meilisearch is better at typos but means another service to host and keep in sync. I'd go with Postgres.",
      card: done("It recommends Postgres full text search over Meilisearch for product search."),
    }],
    visited: true,
    running: {
      startedAgoMin: 25,
      prompt: "Go with Postgres. Build it, with the backfill.",
      progress: "Backfilling search vectors: 31,000 of 48,000 products done. The search endpoint and its tests are written.",
      summary: "It's building product search on Postgres and backfilling the index.",
      finishesInSec: 9 * 60,
      text: "Product search is in: a GIN index over names, descriptions and tags, with trigram matching for typos. The backfill finished for all 48,000 products, and searches take 8 to 15 milliseconds. The search box shows results as you type. 23 new tests pass. It's on the branch product-search, not merged. Shall I open a pull request?",
      card: ready("Product search is built and fast; it's ready for a pull request."),
    },
  },
  {
    id: "demo-next-upgrade",
    title: "Upgrade to Next 16",
    project: "storefront",
    status: "cancelled",
    visited: true,
    replies: [{
      agoMin: 4 * 1440,
      prompt: "Upgrade the storefront to Next 16.",
      text: "(run was cancelled before finishing)",
      card: { state: "stale", summary: "The Next 16 upgrade was cancelled before it finished, four days ago.", ask: null, suggested: "archive" },
    }],
  },

  // --- infra ---
  {
    id: "demo-postgres-backups",
    title: "Postgres backups to R2",
    project: "infra",
    status: "completed",
    replies: [{
      agoMin: 22,
      prompt: "Set up nightly Postgres backups to R2 and check a restore works.",
      text: "Nightly backups are ready: a script that dumps the database, compresses it and uploads it to R2, and a timer that runs it at 2 AM. I tested it against a scratch bucket: a 1.2 gigabyte dump uploaded in 40 seconds, and restoring it into a scratch database worked. It isn't deployed: switching the server restarts Postgres for about five seconds. Should I deploy it now, or tonight at 2 AM?",
      card: decide("Nightly backups to R2 are tested; deploying restarts Postgres for five seconds, so it's asking when.", "Deploy now, or tonight at 2 AM?", ["Now", "Tonight at 2"]),
    }],
    next: [{
      when: /deploy|tonight|now|go ahead|yes|do it|switch/i,
      progress: "Switching the server to deploy the backup timer.",
      text: "Deployed. Postgres restarted for four seconds during the switch and everything came back healthy. I ran the backup once by hand: the dump uploaded to R2 in 38 seconds, and I restored it into a scratch database to check it. From tonight it runs at 2 AM, and backups older than 30 days are deleted.",
      card: done("Backups are deployed and checked; they run nightly at 2 AM."),
    }],
  },
  {
    id: "demo-tls-renewal",
    title: "Renew the TLS certificates",
    project: "infra",
    status: "completed",
    visited: true,
    snoozedDays: 3,
    replies: [{
      agoMin: 1500,
      prompt: "Check when the TLS certificates expire.",
      text: "All four certificates renew automatically; the earliest expires in 41 days. Nothing to do yet.",
      card: done("The TLS certificates renew automatically; nothing to do yet."),
    }],
  },

  // --- launch-site ---
  {
    id: "demo-launch-post",
    title: "Write the launch post",
    project: "launch-site",
    status: "completed",
    replies: [{
      agoMin: 48,
      prompt: "Draft the launch post from the notes in the post folder.",
      text: "The launch post is drafted: about 900 words, with a short story about the first drive, what the app does, how to join the beta, and three screenshots. One question: prices aren't final yet. Do you want the pricing section in with today's numbers, or should I leave it out until they're settled?",
      card: decide("The launch post is drafted; it's asking whether to keep the pricing section in.", "Keep the pricing section, or leave it out until prices are final?", ["Keep it in", "Leave it out"]),
    }],
    next: [
      {
        when: /leave it out|take it out|out|without|wait|later|drop|remove/i,
        progress: "Taking the pricing section out of the draft.",
        text: "I took the pricing section out and added a line saying prices come with the beta. The draft is now about 820 words; the preview is running locally on the blog page. It's ready for you to read.",
        card: ready("The launch post is ready to read, without the pricing section."),
      },
      {
        when: /keep|in|leave it in|include|today/i,
        progress: "Checking the pricing section against today's numbers.",
        text: "I kept the pricing section and checked it against today's numbers, with a note that prices may change during the beta. The draft is about 900 words; the preview is running locally on the blog page. It's ready for you to read.",
        card: ready("The launch post is ready to read, with today's prices and a note they may change."),
      },
    ],
  },

  // --- api ---
  {
    id: "demo-rate-limits",
    title: "Rate limiting for the public API",
    project: "api",
    status: "completed",
    visited: true,
    replies: [{
      agoMin: 160,
      prompt: "Add rate limiting to the public API, per API key.",
      text: "The public API now limits each key to 60 requests a minute, with bursts of up to 20, and answers 429 with a Retry-After header past that. Limits live in Redis, so they hold across all three servers. Load-tested at 5,000 requests a second with no errors. Merged after CI passed.",
      card: done("Rate limiting per API key is in, load-tested and merged."),
    }],
  },
  {
    id: "demo-auth-migration",
    title: "Move sign-in to Clerk",
    project: "api",
    status: "completed",
    replies: [{
      agoMin: 210,
      prompt: "Plan moving our 1,800 users' sign-in to Clerk.",
      text: "There are two ways to move the 1,800 existing users. One: import them into Clerk with their password hashes, so nobody notices; Clerk supports our bcrypt hashes. Two: send everyone a magic link on their next sign-in and drop passwords. The first is invisible to users and takes about a day; the second is simpler but costs some sign-ins. I'd do the first. Which do you want?",
      card: decide("It has two ways to move the 1,800 users to Clerk and recommends importing their password hashes.", "Import password hashes, or switch everyone to magic links?", ["Import the hashes", "Magic links"]),
    }],
    wroteAgoMin: 210,
    next: [{
      when: /import|hash|first|one|recommend|invisible/i,
      progress: "Exporting users and importing them into Clerk's development instance.",
      text: "I imported all 1,800 users into Clerk's development instance with their bcrypt hashes, and signed in as three test users with their old passwords: all worked. The API now checks Clerk's session tokens, with the old sessions still accepted for a week so nobody is signed out. 64 tests pass. Nothing's in production yet; the cutover is one config switch whenever you want it.",
      card: ready("Users are imported into Clerk's development instance and sign-in works; production cutover is one switch."),
    }],
  },
];
