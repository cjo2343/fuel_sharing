// The Realtime half of the load rehearsal (GV-493).
//
// Migrations 202/205/206 put the two workspace channels behind RLS on
// `realtime.messages`, GVM-575 turned "Allow public access to channels" OFF, and
// GVM-587 added a 15-second position broadcast on top of the presence topic. None of
// that existed when exercises 1 and 2 were run, so the rehearsal measured an app that
// no longer exists: every real client now holds an authenticated WEBSOCKET open for as
// long as the workspace is on screen, and each join costs a policy evaluation before a
// single row is read.
//
// This module is the protocol half, spoken in Phoenix directly. It is deliberately a
// SIBLING of tools/probe-realtime-public-access.mjs (GV-490) rather than a second
// implementation of it: the probe answers ONE question about ONE join and exits, this
// one has to hold N sockets open, multiplex two topics per socket, track presence,
// broadcast, and produce percentiles. What they share — the frame vocabulary, the
// refusal classification, "a close before a reply is not a refusal" — is here, and the
// probe's phrasing is what `classifyJoinFailure` recognises, so the two tools name the
// same failure the same way.
//
// Dependency-free, like everything else in this toolkit: node:* plus the GLOBAL
// WebSocket (Node >= 22, the same floor the probe states). No `ws`, no realtime-js.
//
// The exported pure functions are unit-tested in ../test-load-rehearsal.mjs. Nothing
// here opens a socket at import time, so the tests never touch the network.

import { mulberry32, percentile } from "./common.mjs";

// ── Protocol constants ───────────────────────────────────────────────────────

/** Phoenix protocol version in the socket query string, as realtime-js sends it. */
export const REALTIME_VSN = "1.0.0";

/**
 * Topic names, mirrored from govehlo-mobile/src/store/use-ledger-realtime.ts. The
 * `realtime:` prefix is Phoenix's own namespace — supabase-js prepends it, so a raw
 * client must too or the join lands on a topic no policy covers.
 */
export const PRESENCE_TOPIC_PREFIX = "presence-";
export const LEDGER_CHANGES_TOPIC_PREFIX = "ledger-changes-";

export const CHANNEL_PRESENCE = "presence";
export const CHANNEL_LEDGER_CHANGES = "ledger-changes";
export const CHANNELS = [CHANNEL_PRESENCE, CHANNEL_LEDGER_CHANGES];

/** GVM-587: the live-map broadcast event and its cadence (src/lib/on-my-way-live.ts). */
export const ON_MY_WAY_POSITION_EVENT = "omw-position";
export const LIVE_POSITION_INTERVAL_MS = 15_000;
/** Five decimals ≈ 1 m — the minimisation the client applies when the payload is BUILT. */
export const LIVE_POSITION_DECIMALS = 5;

/**
 * Phoenix heartbeat cadence. The platform drops a socket that stops heartbeating, and a
 * VU dropped mid-run would silently under-report the very thing being measured, so this
 * sits well inside the server's window rather than at it.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000;

/** The buckets a failed join is reported in. `other` is never silent — the raw
 *  reason is printed with it, because an unrecognised refusal is a finding, not noise. */
export const JOIN_FAILURE_REASONS = ["Unauthorized", "PrivateOnly", "MissingPartition", "timeout", "other"];

export function presenceTopic(ledgerId) {
  return `realtime:${PRESENCE_TOPIC_PREFIX}${ledgerId}`;
}

export function ledgerChangesTopic(ledgerId) {
  return `realtime:${LEDGER_CHANGES_TOPIC_PREFIX}${ledgerId}`;
}

export function realtimeSocketUrl(baseUrl, apiKey) {
  const base = String(baseUrl).replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(apiKey)}&vsn=${REALTIME_VSN}`;
}

// ── Frames ───────────────────────────────────────────────────────────────────
// Phoenix's JSON object form: { topic, event, payload, ref, join_ref }.

/**
 * The presence channel join, byte-for-byte the config use-ledger-realtime.ts passes to
 * `supabase.channel('presence-<id>', { config: { private: true, presence: { key } } })`.
 *
 * `private: true` is not decoration: policies bind PRIVATE channels only, so dropping it
 * would rehearse a join no policy is consulted for — which is precisely the hole GVM-575
 * closed and precisely what this phase exists to put load on.
 */
export function presenceJoinFrame({ ledgerId, memberId, accessToken, ref }) {
  return {
    topic: presenceTopic(ledgerId),
    event: "phx_join",
    ref: String(ref),
    join_ref: String(ref),
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: String(memberId ?? "") },
        postgres_changes: [],
        private: true,
      },
      access_token: accessToken,
    },
  };
}

/**
 * The live-sync channel join. Two postgres_changes bindings, one per published table —
 * a FILTERED binding requires a table (GVM-137), so the client binds per table rather
 * than once with a wildcard, and the rehearsal must ask for the same two or it measures
 * a cheaper subscription than the app opens.
 */
export function ledgerChangesJoinFrame({ ledgerId, accessToken, ref }) {
  return {
    topic: ledgerChangesTopic(ledgerId),
    event: "phx_join",
    ref: String(ref),
    join_ref: String(ref),
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        postgres_changes: [
          { event: "*", schema: "public", table: "ledger_events", filter: `ledger_id=eq.${ledgerId}` },
          { event: "*", schema: "public", table: "messages", filter: `ledger_id=eq.${ledgerId}` },
        ],
        private: true,
      },
      access_token: accessToken,
    },
  };
}

/** `channel.track({ online_at })` on the wire. */
export function presenceTrackFrame({ ledgerId, ref, joinRef, onlineAt }) {
  return {
    topic: presenceTopic(ledgerId),
    event: "presence",
    ref: String(ref),
    join_ref: String(joinRef),
    payload: { type: "presence", event: "track", payload: { online_at: onlineAt } },
  };
}

/** `channel.send({ type: 'broadcast', event, payload })` on the wire. */
export function broadcastFrame({ ledgerId, ref, joinRef, event, payload }) {
  return {
    topic: presenceTopic(ledgerId),
    event: "broadcast",
    ref: String(ref),
    join_ref: String(joinRef),
    payload: { type: "broadcast", event, payload },
  };
}

export function heartbeatFrame(ref) {
  return { topic: "phoenix", event: "heartbeat", ref: String(ref), payload: {} };
}

export function encodeFrame(frame) {
  return JSON.stringify(frame);
}

/** Never throws: a malformed frame is a frame to ignore, not a reason to kill a VU. */
export function decodeFrame(text) {
  try {
    const parsed = JSON.parse(typeof text === "string" ? text : String(text));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The reason a phx_reply carried, dug out of the several shapes the platform uses.
 * Mirrors tools/probe-realtime-public-access.mjs so both tools quote the same string.
 */
export function replyReason(payload) {
  return (
    payload?.response?.reason ??
    payload?.response?.error ??
    payload?.reason ??
    JSON.stringify(payload?.response ?? {})
  );
}

/**
 * Bucket a refusal. The two strings that matter are the platform's own:
 *
 *   • "PrivateOnly"  — public access is OFF and the join was not marked private. Under
 *     this harness every join IS private, so seeing it means a join frame lost its flag.
 *   • "Unauthorized" — the join was private and migrations 202/205/206's policies said
 *     no. That is the interesting failure: it means a real member could not subscribe.
 *   • "MissingPartition" — *"Realtime was unable to find the expected messages
 *     partition"* (exercise 3, finding T6). Realtime day-partitions `realtime.messages`;
 *     on a FRESH project the first joins race the tenant janitor that creates them. It is
 *     not a policy refusal and must not be filed as one — nor as `other`, or every
 *     fresh-project run buries the same string in the unrecognised bucket. On production
 *     the same string would mean a partition gap at a day roll-over.
 *
 * Anything else is bucketed `other` and reported WITH its raw text. A refusal nobody
 * recognised must not read as a clean run.
 */
export function classifyJoinFailure(reason) {
  const text = String(reason ?? "");
  if (/privateonly/i.test(text)) return "PrivateOnly";
  // Checked before Unauthorized on purpose: the platform's partition message is its own
  // failure mode, and a future wording that carried both words must not read as a policy
  // refusal — the operator would go looking at RLS for a janitor race.
  if (/partition/i.test(text)) return "MissingPartition";
  if (/unauthoriz/i.test(text)) return "Unauthorized";
  if (/timeout|timed out|no reply within/i.test(text)) return "timeout";
  return "other";
}

/**
 * What a decoded frame means, with no knowledge of which refs are outstanding — the
 * caller owns that. Keeping the two apart is what makes this testable without a socket.
 */
export function interpretFrame(frame) {
  if (!frame || typeof frame !== "object") return { kind: "ignore" };
  const { topic, event, ref, payload } = frame;
  switch (event) {
    case "phx_reply":
      return { kind: "reply", topic, ref, status: payload?.status ?? null, reason: replyReason(payload) };
    case "phx_error":
    case "phx_close":
      return { kind: "error", topic, reason: payload?.reason ?? payload?.response?.reason ?? event };
    case "system": {
      const status = payload?.status;
      if (status === "error") return { kind: "error", topic, reason: payload?.message ?? "system error" };
      return { kind: "system", topic, message: payload?.message ?? "" };
    }
    case "presence_state":
    case "presence_diff":
      return { kind: "presence_sync", topic };
    case "broadcast":
      return { kind: "broadcast", topic, broadcastEvent: payload?.event ?? null };
    case "postgres_changes":
      return { kind: "postgres_changes", topic };
    default:
      return { kind: "ignore", topic, event };
  }
}

// ── Sharer selection ─────────────────────────────────────────────────────────

/**
 * Which VUs run "Jeg er på vej" this run. DETERMINISTIC from the seed, for the same
 * reason every other fixture decision here is: a rerun at the same `--seed` must put the
 * ETA load on the same workspaces, or two runs cannot be compared and a workspace that
 * failed cannot be re-driven.
 *
 * `fraction` is clamped to [0,1]; anything above 0 selects at least one VU, because
 * "--sharers 0.05 with 8 VUs" meaning "no ETA load at all" is a silent skip.
 */
export function selectSharers(indices, fraction, seed) {
  const list = [...indices];
  const f = Math.max(0, Math.min(1, Number(fraction)));
  if (!Number.isFinite(f) || f === 0 || list.length === 0) return [];
  const target = Math.min(list.length, Math.max(1, Math.round(list.length * f)));
  const rand = mulberry32((Number(seed) ^ 0x5f3a7c1d) >>> 0);
  const scored = list.map((index) => ({ index, score: rand() }));
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored
    .slice(0, target)
    .map((s) => s.index)
    .sort((a, b) => a - b);
}

// ── Fake positions ───────────────────────────────────────────────────────────

function round5(value) {
  const factor = 10 ** LIVE_POSITION_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * A synthetic dot drifting across Jutland. Rounded to five decimals HERE, the way
 * buildLivePosition does it in the client, so the wire payload is the same size and
 * shape a real device sends — the payload is what the broadcast costs.
 *
 * These are invented coordinates for invented members on a throwaway project; no real
 * location is ever read, sent or stored by this harness (GDPR).
 */
export function fakePosition({ bookingId, memberId, index = 0, tick = 0, now = Date.now() }) {
  const lat = round5(56.1629 + (index % 20) * 0.004 + (tick % 240) * 0.0007);
  const lng = round5(10.2039 + (index % 20) * 0.006 - (tick % 240) * 0.0005);
  return { bookingId: String(bookingId), memberId: String(memberId), lat, lng, ts: now };
}

// ── Stats ────────────────────────────────────────────────────────────────────

/**
 * Realtime's own counters. Deliberately NOT folded into `Metrics`: that one counts HTTP
 * requests and derives req/s from them, and mixing socket joins into it would inflate
 * the throughput figure the whole evidence block is read for. The RPC latencies
 * (`rpc:set_on_my_way` / `rpc:clear_on_my_way`) DO go into `Metrics`, because those are
 * ordinary PostgREST calls and belong next to the other writes.
 */
export class RealtimeStats {
  constructor() {
    this.joinLatencies = new Map(); // channel -> ms[]
    this.joinFailures = new Map(); // `${channel}/${reason}` -> count
    this.failureSamples = []; // { channel, reason, detail }
    this.socketsOpened = 0;
    this.socketsFailed = 0;
    /** A selected sharer that never got to share: no bookable booking, or set_on_my_way
     *  refused. Counted separately from a dead socket so the evidence names the half
     *  that broke rather than blaming the transport for an RPC gate. */
    this.sharerFailures = 0;
    this.presenceSyncs = 0;
    this.postgresChanges = 0;
    this.broadcastsSent = 0;
    this.broadcastsReceived = 0;
    this.sharers = 0;
  }

  recordJoin(channel, ms) {
    if (!this.joinLatencies.has(channel)) this.joinLatencies.set(channel, []);
    this.joinLatencies.get(channel).push(ms);
  }

  recordJoinFailure(channel, rawReason) {
    const reason = classifyJoinFailure(rawReason);
    const key = `${channel}/${reason}`;
    this.joinFailures.set(key, (this.joinFailures.get(key) || 0) + 1);
    if (this.failureSamples.length < 20) {
      this.failureSamples.push({ channel, reason, detail: String(rawReason ?? "").slice(0, 160) });
    }
  }

  /** Per-channel join latency rows, in the same shape Metrics.perEndpoint() produces. */
  joinRows() {
    const rows = [];
    for (const [channel, xs] of [...this.joinLatencies.entries()].sort()) {
      rows.push({
        channel,
        count: xs.length,
        p50: Math.round(percentile(xs, 50)),
        p95: Math.round(percentile(xs, 95)),
        p99: Math.round(percentile(xs, 99)),
        max: Math.round(Math.max(...xs)),
      });
    }
    return rows;
  }

  failureRows() {
    return [...this.joinFailures.entries()]
      .map(([key, count]) => {
        const cut = key.lastIndexOf("/");
        return { channel: key.slice(0, cut), reason: key.slice(cut + 1), count };
      })
      .sort((a, b) => a.channel.localeCompare(b.channel) || a.reason.localeCompare(b.reason));
  }

  totalJoinFailures() {
    let total = 0;
    for (const n of this.joinFailures.values()) total += n;
    return total;
  }

  /** True when the phase produced a finding the run must exit non-zero on. */
  hasFailures() {
    return this.totalJoinFailures() > 0 || this.socketsFailed > 0 || this.sharerFailures > 0;
  }
}

// ── The socket ───────────────────────────────────────────────────────────────

/**
 * ONE websocket per VU, multiplexing both topics — which is what the client does, and
 * what makes this a rehearsal of the platform's real per-connection cost rather than of
 * twice as many connections as launch will have.
 *
 * Every method resolves rather than throws; the verdict is the return value and the
 * stats object is the record. A VU whose socket dies must not take the HTTP load down
 * with it — but it must not go unnoticed either, which is what `stats.socketsFailed`
 * and the non-zero exit in load.mjs are for.
 */
export class RealtimeSocket {
  constructor({ url, stats, timeoutMs = 15_000, WebSocketImpl = globalThis.WebSocket }) {
    this.url = url;
    this.stats = stats;
    this.timeoutMs = timeoutMs;
    this.WebSocketImpl = WebSocketImpl;
    this.ws = null;
    this.ref = 0;
    this.pending = new Map(); // ref -> { resolve, timer }
    this.joinRefs = new Map(); // channel -> join ref
    this.heartbeat = null;
    this.closed = false;
  }

  nextRef() {
    this.ref += 1;
    return this.ref;
  }

  connect() {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, reason });
      };
      const timer = setTimeout(() => done(false, `socket did not open within ${this.timeoutMs} ms`), this.timeoutMs);

      try {
        this.ws = new this.WebSocketImpl(this.url);
      } catch (err) {
        clearTimeout(timer);
        resolve({ ok: false, reason: `could not open socket: ${err.message}` });
        return;
      }

      this.ws.addEventListener("open", () => {
        this.heartbeat = setInterval(() => {
          this.sendRaw(heartbeatFrame(this.nextRef()));
        }, HEARTBEAT_INTERVAL_MS);
        done(true, "open");
      });
      this.ws.addEventListener("message", (event) => this.onMessage(event));
      this.ws.addEventListener("error", () => done(false, "websocket error (URL, key or network)"));
      this.ws.addEventListener("close", (event) => {
        this.settleAllPending(`socket closed (code ${event?.code ?? "?"})`);
        done(false, `socket closed before open (code ${event?.code ?? "?"})`);
      });
    });
  }

  onMessage(event) {
    const frame = decodeFrame(event?.data);
    const seen = interpretFrame(frame);
    switch (seen.kind) {
      case "reply": {
        const waiter = this.pending.get(String(seen.ref));
        if (waiter) {
          this.pending.delete(String(seen.ref));
          clearTimeout(waiter.timer);
          waiter.resolve(
            seen.status === "ok"
              ? { ok: true, reason: "phx_reply status=ok" }
              : { ok: false, reason: `phx_reply status=${seen.status}: ${seen.reason}` },
          );
        }
        return;
      }
      case "error": {
        // A topic-level error can arrive instead of a reply — resolve whatever is
        // outstanding on that topic rather than letting it time out and be filed as a
        // timeout, which would hide an Unauthorized behind a slower-looking bucket.
        this.settleAllPending(seen.reason, seen.topic);
        return;
      }
      case "presence_sync":
        this.stats.presenceSyncs += 1;
        return;
      case "postgres_changes":
        this.stats.postgresChanges += 1;
        return;
      case "broadcast":
        this.stats.broadcastsReceived += 1;
        return;
      default:
    }
  }

  settleAllPending(reason, topic = null) {
    for (const [ref, waiter] of [...this.pending.entries()]) {
      if (topic && waiter.topic && waiter.topic !== topic) continue;
      this.pending.delete(ref);
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: false, reason });
    }
  }

  sendRaw(frame) {
    if (this.closed || !this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(encodeFrame(frame));
      return true;
    } catch {
      return false;
    }
  }

  /** Send a frame and await its phx_reply (or a topic error, or the timeout). */
  push(frame) {
    return new Promise((resolve) => {
      const ref = String(frame.ref);
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        resolve({ ok: false, reason: `timeout: no reply within ${this.timeoutMs} ms` });
      }, this.timeoutMs);
      this.pending.set(ref, { resolve, timer, topic: frame.topic });
      if (!this.sendRaw(frame)) {
        this.pending.delete(ref);
        clearTimeout(timer);
        resolve({ ok: false, reason: "socket not open" });
      }
    });
  }

  /**
   * Join one channel and record the latency (or the classified refusal). `channel` is
   * the short name — `presence` / `ledger-changes` — which is what the evidence block
   * groups by.
   */
  async join(channel, frame) {
    const started = performance.now();
    const result = await this.push(frame);
    const ms = performance.now() - started;
    if (result.ok) {
      this.joinRefs.set(channel, frame.join_ref);
      this.stats.recordJoin(channel, ms);
    } else {
      this.stats.recordJoinFailure(channel, result.reason);
    }
    return result;
  }

  joinRefFor(channel) {
    return this.joinRefs.get(channel) ?? null;
  }

  close() {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.settleAllPending("socket closed by the harness");
    try {
      this.ws?.close();
    } catch {
      /* already closing */
    }
  }
}
