#!/usr/bin/env node
// Probe: is Supabase Realtime private-only? (GV-490 / GVM-575)
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// GVM-575 closed a real hole: `presence-<ledgerId>` and `ledger-changes-<ledgerId>`
// carry workspace data (who has the app open, which rows just changed), and a
// PUBLIC Realtime channel is authorised by nobody — any logged-in user who knew a
// workspace id could join. The fix has two halves. The repo half is visible:
// migrations 202/205/206 put RLS policies on `realtime.messages`, and the mobile
// client opens both topics with `private: true`. The other half is a CHECKBOX in
// the Supabase dashboard — Realtime → "Allow public access to channels" — which no
// migration writes, no query reads and no CI job can grep. It was switched off on
// 2026-08-12; nothing in any repo could tell you that, which is the whole reason
// docs/release-attestations.json has a `realtime_public_access_closed` entry.
//
// This script is what makes that attestation checkable rather than remembered. It
// opens a raw WebSocket to the project's Realtime endpoint and tries the exact
// thing the attacker would: a join of `presence-<id>` WITHOUT `private: true`.
//
//   • The join is REFUSED (the platform answers "PrivateOnly")  → exit 0. Closed.
//   • The join SUCCEEDS                                          → exit 1. The hole
//     is open: the policies are being bypassed, not enforced.
//   • Nothing conclusive happened (bad URL/key, no network, …)   → exit 2. Do NOT
//     read that as a pass; it means the probe learned nothing.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   SUPABASE_URL=https://<ref>.supabase.co \
//   SUPABASE_ANON_KEY=<anon key> \
//   npm run probe:realtime-public-access
//
//   Optional:
//     SUPABASE_ACCESS_TOKEN=<a signed-in member's JWT>  adds phase 2 — the same
//         topic joined WITH `private: true` must still reach SUBSCRIBED, i.e. the
//         switch closed the hole without taking presence and live sync down. Only
//         meaningful together with LEDGER_ID / --ledger of a workspace that token's
//         user is a member of.
//     LEDGER_ID / --ledger <uuid>   the workspace id to probe. Phase 1 does not
//         need a real one — a public join is refused by the platform before any
//         policy is consulted, and would SUCCEED against a nonexistent id while the
//         switch is on — so a random uuid is generated when none is given.
//     --timeout <ms>                default 10000.
//
// DELIBERATELY NOT in `npm run validate`: it needs the network and a live project.
// It is also the one tool here that is MEANT to point at production — unlike the
// load-rehearsal toolkit, which refuses to. It reads nothing and writes nothing:
// no rows, no broadcast, and presence payloads are never printed (they contain
// member ids). Keys come from the environment, never from the repo.
//
// Dependency-free on purpose (node:* plus the global WebSocket, Node >= 22) —
// this repo has no runtime dependencies and the probe does not get to be the first.

const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(`--${name}`);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const ACCESS_TOKEN = (process.env.SUPABASE_ACCESS_TOKEN || "").trim();
const LEDGER_ID = (argValue("ledger") || process.env.LEDGER_ID || "").trim();
const TIMEOUT_MS = Number(argValue("timeout") || process.env.PROBE_TIMEOUT_MS || 10_000);

const EXIT_CLOSED = 0; // public join refused — the good outcome
const EXIT_OPEN = 1; // public join accepted — launch blocker
const EXIT_INCONCLUSIVE = 2; // learned nothing; never treat as a pass

function fail(code, ...lines) {
  for (const line of lines) console.error(line);
  process.exit(code);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  fail(
    EXIT_INCONCLUSIVE,
    "probe-realtime-public-access: SUPABASE_URL and SUPABASE_ANON_KEY are required.",
    "  SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<anon key> npm run probe:realtime-public-access",
    "Exit 2 = inconclusive. Nothing was probed, so nothing is attested.",
  );
}
if (typeof WebSocket !== "function") {
  fail(EXIT_INCONCLUSIVE, "probe-realtime-public-access: no global WebSocket — needs Node >= 22.");
}

const ledgerId = LEDGER_ID || crypto.randomUUID();
const topic = `realtime:presence-${ledgerId}`;
const socketUrl = `${SUPABASE_URL.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(
  SUPABASE_ANON_KEY,
)}&vsn=1.0.0`;

/**
 * One join attempt against the Realtime socket, spoken in Phoenix's own protocol
 * (realtime-js is not a dependency here). Resolves with the verdict rather than
 * throwing, so the caller decides what each outcome means.
 *
 * @returns {Promise<{outcome: "joined"|"refused"|"inconclusive", reason: string}>}
 */
function attemptJoin({ isPrivate, accessToken }) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      resolve({ outcome, reason });
    };

    const timer = setTimeout(
      () => done("inconclusive", `no reply within ${TIMEOUT_MS} ms`),
      TIMEOUT_MS,
    );

    let ws;
    try {
      ws = new WebSocket(socketUrl);
    } catch (err) {
      clearTimeout(timer);
      resolve({ outcome: "inconclusive", reason: `could not open socket: ${err.message}` });
      return;
    }

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({
          topic,
          event: "phx_join",
          ref: "1",
          join_ref: "1",
          payload: {
            config: {
              broadcast: { ack: false, self: false },
              presence: { key: "" },
              postgres_changes: [],
              private: isPrivate,
            },
            access_token: accessToken || SUPABASE_ANON_KEY,
          },
        }),
      );
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.topic !== topic) return; // heartbeats and other topics
      // A refusal arrives either as a phx_reply with status "error" or as the
      // socket-level phx_error / phx_close on this topic. Presence state is never
      // read or printed — only the join verdict is.
      if (msg.event === "phx_reply") {
        const status = msg.payload?.status;
        if (status === "ok") return done("joined", "phx_reply status=ok");
        const reason =
          msg.payload?.response?.reason ??
          msg.payload?.response?.error ??
          JSON.stringify(msg.payload?.response ?? {});
        return done("refused", `phx_reply status=${status}: ${reason}`);
      }
      if (msg.event === "phx_error" || msg.event === "phx_close") {
        const reason = msg.payload?.reason ?? msg.payload?.response?.reason ?? msg.event;
        return done("refused", `${msg.event}: ${reason}`);
      }
      if (msg.event === "system") {
        const status = msg.payload?.status;
        if (status === "error") return done("refused", `system: ${msg.payload?.message ?? "error"}`);
        if (status === "ok") return done("joined", `system: ${msg.payload?.message ?? "ok"}`);
      }
    });

    ws.addEventListener("error", () => done("inconclusive", "websocket error (URL, key or network)"));
    ws.addEventListener("close", (event) => {
      // A close BEFORE any reply is not a refusal of the join — it is the socket
      // never getting far enough to answer, and calling it a refusal would turn a
      // network problem into a green gate.
      done("inconclusive", `socket closed before a reply (code ${event.code})`);
    });
  });
}

const projectRef = SUPABASE_URL.replace(/^https?:\/\//, "").split(".")[0];
console.log(`Realtime public-access probe (GV-490) — project ${projectRef}`);
console.log(`  topic: presence-${ledgerId}${LEDGER_ID ? "" : "  (generated; phase 1 does not need a real workspace)"}`);

const publicJoin = await attemptJoin({ isPrivate: false, accessToken: ACCESS_TOKEN });

if (publicJoin.outcome === "inconclusive") {
  fail(
    EXIT_INCONCLUSIVE,
    `  phase 1 (public join): INCONCLUSIVE — ${publicJoin.reason}`,
    "Nothing was proved. Do not attest realtime_public_access_closed off this run.",
  );
}
if (publicJoin.outcome === "joined") {
  fail(
    EXIT_OPEN,
    `  phase 1 (public join): JOINED — ${publicJoin.reason}`,
    'LAUNCH BLOCKER: this project still allows public channels, so the migration 202/205/206',
    "policies are bypassable — an attacker opens the same topic without `private: true` and",
    "reads workspace presence and change traffic.",
    'Fix: Supabase dashboard → Realtime settings → turn OFF "Allow public access to channels",',
    "then re-run this probe (GVM-575 / GV-490).",
  );
}
console.log(`  phase 1 (public join): REFUSED — ${publicJoin.reason}`);
if (!/privateonly/i.test(publicJoin.reason)) {
  console.log(
    '  note: the refusal did not name "PrivateOnly". It is still a refusal, but check the reason',
  );
  console.log("        above — a rate limit or a bad key refuses joins too, and proves nothing here.");
}

if (!ACCESS_TOKEN) {
  console.log("  phase 2 (member private join): SKIPPED — set SUPABASE_ACCESS_TOKEN + LEDGER_ID to run it.");
  console.log("Public channels are refused. Half of the attestation is evidenced; the rest is in");
  console.log("docs/release-attestations.json → realtime_public_access_closed.");
  process.exit(EXIT_CLOSED);
}

const privateJoin = await attemptJoin({ isPrivate: true, accessToken: ACCESS_TOKEN });
if (privateJoin.outcome === "joined") {
  console.log(`  phase 2 (member private join): SUBSCRIBED — ${privateJoin.reason}`);
  console.log("Closed to the public, open to members. Both halves evidenced.");
  process.exit(EXIT_CLOSED);
}
fail(
  EXIT_INCONCLUSIVE,
  `  phase 2 (member private join): ${privateJoin.outcome.toUpperCase()} — ${privateJoin.reason}`,
  "The public hole is closed, but a member could not join either — presence and live sync are",
  "down for real users. Check that the token belongs to a member of LEDGER_ID and that",
  "migrations 202/205/206 are applied, then re-run.",
);
