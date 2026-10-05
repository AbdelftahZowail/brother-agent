// brother-agent — proxy stratum: headless watch/notify loop + browser data route.
//
// Owns finish-notice delivery for brother sessions: a poller watches the
// durable seam file the engine half appends to
// ($XDG_STATE_HOME/opencode-webui/brother-watches.json — written by
// engine/definitions.cjs via brother_agent / brother_agent_watch), and when a
// watched child SETTLES it STEERS a notice into the parent session.
//
// DELIVERY DOCTRINE (why steer, not queue):
//   - steer  — delivered at the recipient's next LLM-call boundary (seconds;
//              non-destructive). Time-relevant signals the recipient should see
//              before its next decision. FINISH NOTICES USE THIS: a brother
//              works ONE long turn, so a queued notice would sit until that
//              turn ends — usually after the work it was about is done.
//   - queue  — delivered when the recipient's current turn ENDS (immediate if
//              idle). Non-urgent follow-ups only.
//   - interrupt+send / stop — aborts the recipient's active turn first;
//              destructive, only when work must stop NOW.
//
// FALSE-FINISH GUARD (the bug this fixes): a just-launched child is recorded in
// the seam BEFORE its prompt is accepted, and /api/session/active can briefly
// omit an idle-but-launching (or between-step) session. The old rule "not in the
// active map ⇒ finished" therefore fired a false "finished" at launch. Now a
// child may only be reported SETTLED after:
//   (1) it was observed RUNNING at least once (durable KV `seenActive`,
//       seeded from the live active map on the first tick so children already
//       running when this module loads are handled); AND
//   (2) it was absent from the active map on a first observation AND still
//       absent after a confirmation delay (immediate re-check just before
//       sending) — a single transient gap can never fire a notice.
// A watch whose prompt failed is removed engine-side (definitions.cjs), so no
// ghost. A child that never becomes active gets a defined outcome: after a
// grace window it is reported "did not start" (as a steer), not "finished".
//
// DEDUPE / RE-NOTIFY: KV `notified[childId]` records the delivered notice.
// Never double-notify the same finish: after delivery the child stays notified
// while it is absent. But a brother that runs AGAIN is re-armed — seeing it
// active clears its `notified` record — so its next finish is notifiable again.
// The seam entry is intentionally KEPT after delivery (re-notify needs it); it
// is pruned engine-side (>7d) and here after SEAM_KEEP_MS once inactive.
//
// Single-writer discipline per file: the engine owns the seam file's watch
// entries; this half may delete entries it has already delivered (now only via
// the aged prune). Delivery state (notified/seenActive per child) lives in this
// extension's KV, which is the dedupe authority.
//
// Engine access: the registration-file discovery contract
// ($XDG_STATE_HOME/opencode/service.json → {url, password}, Basic
// opencode:password). Read-only; never spawns. No bare imports and no core
// imports — node: builtins only, so this loads from any extension dir
// (shipped or scratch) with zero type/runtime coupling to core.

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const EXT_ID = "brother-agent";
const POLL_MS = 3000;
const PRUNE_NOTIFIED_MS = 86400000; // drop delivered records after a day
const CONFIRM_MS = 5000; // absent must persist this long before a notice fires
const START_GRACE_MS = 120000; // never-active child ⇒ "did not start" after 2m
const PENDING_TTL_MS = 120000; // abandoned in-flight confirmation is retried
const SEAM_KEEP_MS = 3 * 86400000; // keep settled watches 3d so re-notify works
const CLAIM_KEEP_MS = 7 * 86400000; // prune cross-process delivery claims after a week
// A watched id can briefly vanish from the seam while the engine and this half
// both rewrite the file (read-modify-write races) or during an aged prune. Do
// NOT forget a child's delivery/dedupe state on the first miss: a transient gap
// that drops `notified`/`seenActive` would let the SAME finish be re-notified
// when the entry reappears (the observed "third notice after two runs" bug).
// Only forget after the id has been CONTINUOUSLY absent this long.
const SEAM_MISS_GRACE_MS = 5 * 60 * 1000;

// --- minimal structural types (mirrors server/ext/types.ts; self-contained
// so this file stays loadable from external extension dirs) ---

interface ExtKV {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): Promise<void>;
}

interface ExtCtx {
  extID: string;
  kv: ExtKV;
}

interface WatchEntry {
  parent: string;
  task?: string;
  launchedAt?: number;
  [key: string]: unknown;
}

type WatchMap = Record<string, WatchEntry>;

/** Per-child delivery record. `pending` = confirmation in flight. */
interface NotifiedRec {
  at: number;
  updatedAt?: number;
  pending?: boolean;
}

interface Endpoint {
  url: string;
  headers: Record<string, string>;
}

function stateDir(): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "opencode-webui");
}

function watchesFile(): string {
  return join(stateDir(), "brother-watches.json");
}

function isWatchEntry(v: unknown): v is WatchEntry {
  return typeof v === "object" && v !== null && typeof (v as WatchEntry).parent === "string";
}

function readWatches(): WatchMap {
  try {
    const raw = JSON.parse(readFileSync(watchesFile(), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return {};
    const out: WatchMap = {};
    for (const [k, v] of Object.entries(raw)) {
      if (isWatchEntry(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Aged prune of settled, inactive watch entries (keeps re-notify working for
 * SEAM_KEEP_MS, then bounds the file). Best-effort; the engine also prunes. */
function pruneSeam(childIds: string[]): void {
  if (childIds.length === 0) return;
  try {
    if (!existsSync(watchesFile())) return;
    const raw = JSON.parse(readFileSync(watchesFile(), "utf8")) as Record<string, unknown>;
    if (!raw || typeof raw !== "object") return;
    let changed = false;
    for (const id of childIds) {
      if (id in raw) {
        delete raw[id];
        changed = true;
      }
    }
    if (!changed) return;
    mkdirSync(dirname(watchesFile()), { recursive: true });
    writeFileSync(watchesFile() + ".tmp", JSON.stringify(raw, null, 2));
    renameSync(watchesFile() + ".tmp", watchesFile());
  } catch {
    /* seam write races resolve on the next engine write; KV stays authoritative */
  }
}

// ---------------------------------------------------------------------------
// Cross-process delivery claims. The proxy KV is per-process (each proxy
// instance caches its own copy of ext-kv.json), and this extension can be
// loaded by more than one proxy (installed + dev) or restarted mid-delivery.
// An exclusive-create claim file makes "deliver this finish exactly once" hold
// across all of them. Key = childId + finish identity (the session's
// time.updated), so a NEW run gets a new claim and is notifiable again, while
// the SAME finish can never be delivered twice.
// ---------------------------------------------------------------------------

function claimsDir(): string {
  return join(stateDir(), "brother-notify-claims");
}

function claimKey(childId: string, finishKey: string): string {
  return `${childId}__${finishKey}`.replace(/[^A-Za-z0-9_.@-]/g, "_");
}

/** Claim a finish for delivery. true = this process may deliver it. */
function claimFinish(childId: string, finishKey: string): boolean {
  try {
    mkdirSync(claimsDir(), { recursive: true });
    const fd = openSync(join(claimsDir(), claimKey(childId, finishKey)), "wx");
    closeSync(fd);
    return true;
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === "EEXIST") return false;
    return true; // unexpected FS error — allow (KV still dedupes in-process)
  }
}

/** Release a claim so a failed delivery can be retried. */
function releaseClaim(childId: string, finishKey: string): void {
  try {
    unlinkSync(join(claimsDir(), claimKey(childId, finishKey)));
  } catch {
    /* already gone / not ours */
  }
}

/** Best-effort prune of old claim files. */
function pruneClaims(): void {
  try {
    const dir = claimsDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (now - statSync(p).mtimeMs > CLAIM_KEEP_MS) unlinkSync(p);
      } catch {
        /* racing prune */
      }
    }
  } catch {
    /* best effort */
  }
}

function serviceEndpoint(): Endpoint | null {  try {
    const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const info = JSON.parse(readFileSync(join(state, "opencode", "service.json"), "utf8")) as {
      url?: unknown;
      password?: unknown;
    };
    if (!info || typeof info.url !== "string") return null;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (typeof info.password === "string" && info.password !== "") {
      headers["authorization"] = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64");
    }
    return { url: info.url.replace(/\/+$/, ""), headers };
  } catch {
    return null;
  }
}

async function engineFetch(ep: Endpoint, method: string, p: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${ep.url}${p}`, {
    method,
    headers: ep.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`engine ${method} ${p} → ${res.status}`);
  return res.json();
}

interface SessionRow {
  id: string;
  title?: string;
  cost?: number;
  time?: { created?: number; updated?: number };
}

function ageMin(updatedAt: number | undefined): number {
  return Math.max(1, Math.round((Date.now() - (updatedAt ?? Date.now())) / 60000));
}

/** Deliver a STEER notice into a parent session. Returns true on success. */
async function steerNotice(ep: Endpoint, parentId: string, text: string): Promise<boolean> {
  try {
    await engineFetch(ep, "POST", `/api/session/${encodeURIComponent(parentId)}/prompt`, {
      text,
      delivery: "steer",
    });
    return true;
  } catch {
    return false; // parent gone or engine busy — retry next tick
  }
}

async function tick(ctx: ExtCtx): Promise<void> {
  const kv = ctx.kv;
  const seam = readWatches();
  const now = Date.now();

  // --- load + normalize durable state (migrates legacy number values) ---
  const notifiedRaw = (await kv.get<Record<string, unknown>>("notified")) ?? {};
  const notified: Record<string, NotifiedRec> = {};
  for (const [id, v] of Object.entries(notifiedRaw)) {
    if (typeof v === "number") notified[id] = { at: v };
    else if (v && typeof v === "object") notified[id] = v as NotifiedRec;
  }
  const seenRaw = (await kv.get<Record<string, number>>("seenActive")) ?? {};
  const seenActive: Record<string, number> = {};
  for (const [id, v] of Object.entries(seenRaw)) if (typeof v === "number") seenActive[id] = v;
  const missRaw = (await kv.get<Record<string, number>>("seamMiss")) ?? {};
  const seamMiss: Record<string, number> = {};
  for (const [id, v] of Object.entries(missRaw)) if (typeof v === "number") seamMiss[id] = v;

  if (Object.keys(seam).length === 0 && Object.keys(notified).length === 0 && Object.keys(seenActive).length === 0 && Object.keys(seamMiss).length === 0) {
    return;
  }

  const ep = serviceEndpoint();
  if (!ep) return; // engine undiscoverable — retry next tick

  let active: Record<string, unknown>;
  try {
    const res = (await engineFetch(ep, "GET", "/api/session/active")) as { data?: Record<string, unknown> };
    active = res.data ?? {};
  } catch {
    return; // engine momentarily unreachable — retry next tick
  }
  const rows = new Map<string, SessionRow>();
  try {
    const res = (await engineFetch(ep, "GET", "/api/session?limit=50&order=desc")) as { data?: SessionRow[] };
    for (const s of res.data ?? []) {
      if (s && typeof s.id === "string") rows.set(s.id, s);
    }
  } catch {
    /* list is best-effort (titles/cost); the active map is authoritative */
  }

  let stateDirty = false;

  // --- track seam presence so a TRANSIENT miss does not wipe dedupe state ---
  // Any id present this tick had no continuous absence: clear its miss clock.
  for (const id of Object.keys(seamMiss)) {
    if (id in seam) {
      delete seamMiss[id];
      stateDirty = true;
    }
  }
  const seamMissed = (id: string): boolean => {
    if (id in seamMiss) return now - (seamMiss[id] ?? now) > SEAM_MISS_GRACE_MS;
    seamMiss[id] = now;
    stateDirty = true;
    return false; // first miss — wait out the grace before forgetting
  };

  // --- reconcile delivered records against live truth ---
  for (const id of Object.keys(notified)) {
    const rec = notified[id];
    if (!rec) {
      delete notified[id];
      stateDirty = true;
      continue;
    }
    if (rec.pending) {
      if (now - rec.at > PENDING_TTL_MS) {
        delete notified[id]; // abandoned in-flight confirmation — allow retry
        stateDirty = true;
      }
      continue;
    }
    if (now - rec.at > PRUNE_NOTIFIED_MS) {
      delete notified[id];
      stateDirty = true;
      continue;
    }
    // Ran again after finishing ⇒ arm a fresh notice for its next finish.
    if (id in active) {
      delete notified[id];
      stateDirty = true;
      continue;
    }
    // No longer watched (engine prune / removal) ⇒ stale, but only after a
    // sustained absence so a transient seam gap can't re-arm the same finish.
    if (!(id in seam) && seamMissed(id)) {
      delete notified[id];
      stateDirty = true;
    }
  }
  // Forget activity/dedupe state only for watches absent beyond the grace.
  for (const id of Object.keys(seenActive)) {
    if (!(id in seam) && seamMissed(id)) {
      delete seenActive[id];
      stateDirty = true;
    }
  }

  // --- seed seenActive from the LIVE map so currently-running children count ---
  for (const id of Object.keys(seam)) {
    if (id in active && !(id in seenActive)) {
      seenActive[id] = now;
      stateDirty = true;
    }
  }

  // --- classify every un-notified watch ---
  // A `nostart` ("never started") notice requires POSITIVE non-start evidence:
  // the session is missing from the engine, or exists but is EMPTY (no title,
  // no activity after creation). A session with ANY history must NEVER be
  // reported "never started" — even with no seenActive record (e.g. the watch
  // was re-recorded after this process last tracked it). Such a session is
  // reported as a normal finish instead, so an already-finished watch gets a
  // defined outcome rather than a false "did not start" or an endless hang.
  const HISTORY_EPSILON_MS = 2000;
  const historyRow = async (id: string): Promise<SessionRow | null | undefined> => {
    const known = rows.get(id);
    if (known) return known;
    try {
      const res = (await engineFetch(ep, "GET", `/api/session/${encodeURIComponent(id)}`)) as { data?: SessionRow };
      if (res && res.data && typeof res.data.id === "string") return res.data;
      return undefined; // responded but no usable row
    } catch (e) {
      if (e && / 404\b/.test(String(e.message))) return null; // genuinely missing
      return undefined; // unreachable — defer, do not assert non-start
    }
  };
  const hasHistory = (row: SessionRow | null | undefined): boolean => {
    if (!row) return false; // missing ⇒ no history
    if (row.title && row.title.trim() !== "") return true;
    const created = row.time?.created;
    const updated = row.time?.updated;
    if (typeof created === "number" && typeof updated === "number" && updated - created > HISTORY_EPSILON_MS) return true;
    return false;
  };

  const candidates: Array<{ id: string; w: WatchEntry; kind: "finish" | "nostart" }> = [];
  for (const [id, w] of Object.entries(seam)) {
    if (!w.parent || id in notified) continue;
    if (id in active) continue; // provably running
    if (seenActive[id]) {
      candidates.push({ id, w, kind: "finish" });
      continue;
    }
    if (now - (w.launchedAt ?? 0) <= START_GRACE_MS) continue; // launched moments ago — wait
    // Past grace and never seen active: decide finish vs nostart from evidence.
    const row = await historyRow(id);
    if (row === null) candidates.push({ id, w, kind: "nostart" }); // missing ⇒ never started
    else if (row === undefined) continue; // unreachable ⇒ defer (retry next tick)
    else if (hasHistory(row)) candidates.push({ id, w, kind: "finish" }); // it ran before ⇒ finished
    else candidates.push({ id, w, kind: "nostart" }); // empty ⇒ never started
  }

  // Drop miss clocks whose owner state is gone — bounds the map.
  for (const id of Object.keys(seamMiss)) {
    if (id in seam) continue;
    if (id in notified || id in seenActive) continue;
    delete seamMiss[id];
    stateDirty = true;
  }

  if (stateDirty) {
    await kv.set("seenActive", seenActive);
    await kv.set("notified", notified);
    await kv.set("seamMiss", seamMiss);
  }

  if (candidates.length === 0) {
    // still let an aged prune happen occasionally
    maybePruneSeam(seam, notified, active);
    return;
  }

  // --- confirmation: mark pending, wait, then re-check the live map ---
  for (const c of candidates) {
    notified[c.id] = { at: Date.now(), pending: true };
  }
  await kv.set("notified", notified);

  await sleep(CONFIRM_MS);

  let active2: Record<string, unknown>;
  try {
    const res = (await engineFetch(ep, "GET", "/api/session/active")) as { data?: Record<string, unknown> };
    active2 = res.data ?? {};
  } catch {
    return; // can't confirm — leave pending; TTL retries
  }

  // --- deliver only confirmed-settled children, grouped by parent ---
  const byParent = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (c.id in active2) {
      delete notified[c.id]; // transient gap: it is still running — no notice
      continue;
    }
    const list = byParent.get(c.w.parent) ?? [];
    list.push(c);
    byParent.set(c.w.parent, list);
  }
  await kv.set("notified", notified);

  let deliveredChanged = false;
  // Already-delivered notices (this and prior ticks) — used for "last one".
  const deliveredSet = new Set<string>(
    Object.keys(notified).filter((id) => notified[id] && !notified[id]?.pending),
  );
  for (const [parentId, group] of byParent) {
    for (let i = 0; i < group.length; i++) {
      const c = group[i];
      if (!c) continue;
      let row = rows.get(c.id);
      if (!row && c.kind === "finish") {
        // The list is capped (limit=50); a just-finished child can fall outside
        // it, and the list call is best-effort. Without its own record the
        // finish key collapses to a sentinel ("0"), which a LATER run's finish
        // then collides with — silently blocking the re-notify. Fetch the one
        // record so the key is the real time.updated. Bounded: candidates only.
        try {
          const res = (await engineFetch(ep, "GET", `/api/session/${encodeURIComponent(c.id)}`)) as { data?: SessionRow };
          if (res && res.data && typeof res.data.id === "string") row = res.data;
        } catch {
          /* deleted/unreachable — sentinel key; KV dedupe still applies in-process */
        }
      }
      const updatedAt = row?.time?.updated;
      const finishKey = c.kind === "finish" ? String(updatedAt ?? "0") : "nostart";
      // Cross-process/restart guard: only ONE instance may deliver this finish.
      if (!claimFinish(c.id, finishKey)) {
        notified[c.id] = { at: Date.now(), updatedAt };
        deliveredSet.add(c.id);
        continue;
      }
      // Mark first so the "last one" test sees this notice as resolved.
      notified[c.id] = { at: Date.now(), updatedAt };
      deliveredSet.add(c.id);
      const outstanding = Object.keys(seam).filter(
        (id) => seam[id]?.parent === parentId && !deliveredSet.has(id),
      ).length;
      const last = outstanding === 0;

      let text: string;
      if (c.kind === "finish") {
        const title = row?.title ?? "";
        const cost = typeof row?.cost === "number" ? ` · $${row.cost.toFixed(4)}` : "";
        const head = `[brother-agent] Your brother agent ${c.id} finished${title ? ` — "${title}"` : ""}${cost} · ${ageMin(row?.time?.updated)}m ago`;
        text = last
          ? `${head} — that was the last one: no brother agents of yours are still running.`
          : `${head}. Read the transcript with brother_agent_read if you need details.`;
      } else {
        const head = `[brother-agent] Your brother agent ${c.id} was launched but never started running (its prompt may have failed). No finish notice will follow`;
        text = last ? `${head} — and no brother agents of yours are still running.` : `${head}; check brother_agent_status or relaunch it.`;
      }

      const ok = await steerNotice(ep, parentId, text);
      if (!ok) {
        // Release the claim and leave pending so a later tick retries.
        releaseClaim(c.id, finishKey);
        notified[c.id] = { at: Date.now(), pending: true };
      } else {
        deliveredChanged = true;
      }
    }
  }
  await kv.set("notified", notified);

  if (deliveredChanged) maybePruneSeam(seam, notified, active, true);
}

/** Best-effort aged prune of settled seam entries (bounds the file; the engine
 * also prunes >7d). Only entries that are delivered, inactive, and old. */
function maybePruneSeam(
  seam: WatchMap,
  notified: Record<string, NotifiedRec>,
  active: Record<string, unknown>,
  force = false,
): void {
  const now = Date.now();
  const stale: string[] = [];
  for (const [id, w] of Object.entries(seam)) {
    if (id in active) continue;
    const rec = notified[id];
    if (!rec || rec.pending) continue;
    if (now - (w.launchedAt ?? 0) > SEAM_KEEP_MS) stale.push(id);
  }
  if (stale.length > 0 || force) pruneSeam(stale);
  if (force) pruneClaims();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let busy = false;

async function guardedTick(ctx: ExtCtx): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    await tick(ctx);
  } catch (err) {
    console.error(`[webui] ext "${EXT_ID}" tick failed:`, err);
  } finally {
    busy = false;
  }
}

export default {
  routes: [
    {
      method: "GET",
      path: "brothers",
      handler: async (_req: Request, ctx: ExtCtx): Promise<Response> => {
        const seam = readWatches();
        const notified = (await ctx.kv.get<Record<string, number>>("notified")) ?? {};
        const seenActive = (await ctx.kv.get<Record<string, number>>("seenActive")) ?? {};
        return Response.json({
          brothers: Object.keys(seam),
          watches: seam,
          notified,
          seenActive,
        });
      },
    },
  ],
  onEvent: async (evt: { id: string; type: string; data: unknown }, ctx: ExtCtx): Promise<void> => {
    // Any session-scoped engine event hints activity changed — kick an
    // early tick. The active map re-verifies (with confirmation), so
    // spurious kicks are harmless. Delivery itself stays poller-owned.
    if (typeof evt?.type === "string" && evt.type.includes("session")) {
      await guardedTick(ctx);
    }
  },
  pollers: [
    {
      id: "watch",
      intervalMs: POLL_MS,
      run: async (ctx: ExtCtx): Promise<void> => {
        await guardedTick(ctx);
      },
    },
  ],
};
