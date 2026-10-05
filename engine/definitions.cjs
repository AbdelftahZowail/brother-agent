// brother-agent — all tool logic (hot-swappable; see index.js shell).
//
// v2 reshape notes (user-visible behavior preserved, internals adapted):
// - Transport is the engine's own setup API (session.create/get/prompt/
//   interrupt/wait/context) plus the documented REST surface (openapi.json)
//   via the service registration file for the three things setup omits:
//   session list, running-state (/session/active), full message history,
//   and session removal. No private engine knowledge.
// - Session-origin tagging is NATIVE session metadata
//   ({origin:"brother-agent"} at create) — queryable via GET session —
//   metadata lives and dies with its session.
// - Watch entries (child->parent) go to a durable seam file both strata
//   parse ($XDG_STATE_HOME/opencode-webui/brother-watches.json); the proxy
//   half (server.ts) owns delivery state + headless steering.
//
// DELIVERY CLASSIFICATION (engine side — every send this half makes):
//   * launch prompt to a new child ... STEER (brand-new idle session; both
//     start it immediately, steer is the system default and avoids the queue
//     trap if the child already has a turn). See launchBrother.
//   * brother_agent_message ....... STEER by default (the primary way to talk
//     to a working brother); delivery:"queue" is the deliberate exception.
//   * brother_agent_steer ......... STEER (optionally interrupt — destructive).
//   * brother_agent_stop .......... interrupt only (aborts; sends nothing).
//   * server.ts notices ........... STEER (see the proxy half).
//   queue = when the recipient's turn ENDS (immediate if idle); steer = next
//   LLM-call boundary (seconds, non-destructive); stop/interrupt = abort now.
// - Model choice is passed AT CREATE ({id, providerID}) — v2 supports it
//   natively, so the old selectModel-then-restore-default dance (and its
//   "could not restore" warning path) is gone: the user default is never
//   touched by construction.
// - CUT: `reasoningEffort` arg (v2 models take `variant` instead);
//   turn/step/llmMs/decodeTokens stats (v2 exposes tokens+cost only);
//   blank-session state (v2 has no blank flag); unarchive (v2 has no
//   archive endpoint — archive maps to removal, see brother_agent_archive).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ORIGIN = "brother-agent";
const DEFAULT_TIMEOUT_MS = 1800000;
const POLL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Local config: the "configured brother default" (resolution level 2).
// ~/.config/opencode/brother-agent.json, e.g. {"provider":"anthropic","model":"claude-opus-4-6"}
// ---------------------------------------------------------------------------

function brotherDefault() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".config", "opencode", "brother-agent.json"), "utf8");
    const cfg = JSON.parse(raw);
    if (cfg && typeof cfg.provider === "string" && typeof cfg.model === "string") {
      const out = { providerID: cfg.provider, id: cfg.model };
      if (typeof cfg.variant === "string") out.variant = cfg.variant;
      return out;
    }
  } catch {
    /* absent or invalid — fall through */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// REST discovery: the same registration-file contract the webui proxy uses
// ($XDG_STATE_HOME/opencode/service.json → {url, password}). Read-only:
// never spawns, never writes. Returns null when undiscoverable — callers
// fall back to setup-API-only behavior and say so.
// ---------------------------------------------------------------------------

function discoverService() {
  try {
    const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
    const info = JSON.parse(fs.readFileSync(path.join(state, "opencode", "service.json"), "utf8"));
    if (!info || typeof info.url !== "string") return null;
    const headers = { "content-type": "application/json" };
    if (info.password) {
      headers.authorization = "Basic " + Buffer.from(`opencode:${info.password}`).toString("base64");
    }
    return { url: info.url.replace(/\/+$/, ""), headers };
  } catch {
    return null;
  }
}

async function rest(svc, method, p, body) {
  const res = await fetch(`${svc.url}${p}`, {
    method,
    headers: svc.headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && (j.message || j.error)) msg += `: ${typeof j.message === "string" ? j.message : JSON.stringify(j.message ?? j.error)}`;
    } catch {
      /* non-JSON */
    }
    const err = new Error(`brother-agent: ${method} ${p} → ${msg}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Watch seam file — engine side is append/prune-only; delivery state lives
// in the proxy half. Atomic tmp+rename writes.
// ---------------------------------------------------------------------------

function stateDir() {
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-webui");
}

function watchesFile() {
  return path.join(stateDir(), "brother-watches.json");
}

function readWatches() {
  try {
    const v = JSON.parse(fs.readFileSync(watchesFile(), "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeWatches(map) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const tmp = watchesFile() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, watchesFile());
}

/** Record (or refresh) a child->parent watch entry; prunes entries >7d old. */
function recordWatch(childId, parentId, task) {
  if (!childId || !parentId) return;
  const now = Date.now();
  const map = readWatches();
  const prev = map[childId] || {};
  map[childId] = { parent: parentId, task: String(task ?? "").slice(0, 200), launchedAt: prev.launchedAt || now };
  for (const [id, w] of Object.entries(map)) {
    if (!w || typeof w !== "object" || !w.parent) { delete map[id]; continue; }
    if (now - (w.launchedAt || 0) > 7 * 86400000) delete map[id];
  }
  writeWatches(map);
}

/** Remove a watch entry. Used when a launch prompt is rejected so a failed
 * launch cannot leave a ghost watch that later reports "finished". */
function removeWatch(childId) {
  if (!childId) return;
  const map = readWatches();
  if (!(childId in map)) return;
  delete map[childId];
  writeWatches(map);
}

// ---------------------------------------------------------------------------
// Transcript rendering — tolerant of REST MessageInfo and context Info.
// ---------------------------------------------------------------------------

function partText(p) {
  if (!p || typeof p !== "object") return "";
  if (typeof p.text === "string") return p.text;
  return "";
}

function cleanText(parts) {
  return (parts || [])
    .filter((b) => b && (b.type === "text" || b.type === undefined))
    .map(partText)
    .join("\n")
    .trim();
}

function compactArgs(input) {
  try {
    const s = typeof input === "string" ? input : JSON.stringify(input);
    return s.length > 300 ? s.slice(0, 300) + "…" : s;
  } catch {
    return String(input ?? "").slice(0, 300);
  }
}

/** Render REST GET …/message items as clean plain text. */
function renderMessages(items, { thinking = false, tools = false, lastOnly = false } = {}) {
  const lines = [];
  let lastAssistantText = null;
  for (const m of items || []) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "user") {
      const t = (typeof m.text === "string" ? m.text : "").trim();
      if (t) lines.push(`[user] ${t}`);
    } else if (m.type === "assistant") {
      const content = Array.isArray(m.content) ? m.content : [];
      const t = cleanText(content.filter((p) => p && p.type === "text"));
      if (t) lastAssistantText = t;
      const parts = [];
      if (t) parts.push(`[assistant] ${t}`);
      if (thinking) {
        const th = content.filter((p) => p && p.type === "reasoning").map(partText).join("\n").trim();
        if (th) parts.push(`  [thinking] ${th}`);
      }
      if (tools) {
        for (const p of content.filter((p) => p && p.type === "tool")) {
          parts.push(`  [tool] ${p.name || "tool"}(${compactArgs(p.input ?? p.state?.input)})`);
          const st = p.state;
          if (st && st.status === "completed" && Array.isArray(st.content)) {
            const rt = cleanText(st.content.filter((c) => c && c.type === "text"));
            if (rt) parts.push(`  [tool result] ${rt.slice(0, 500)}`);
          } else if (st && st.status === "error") {
            parts.push(`  [tool result (error)] ${(st.error && st.error.message) || "error"}`.slice(0, 500));
          }
        }
      }
      if (parts.length) lines.push(parts.join("\n"));
    }
  }
  if (lastOnly && lastAssistantText != null) return `[assistant] ${lastAssistantText}`;
  return lines.join("\n") || "(no messages)";
}

/** Fallback renderer for session.context items (unknown projection shape). */
function renderContextFallback(items, { lastOnly = false } = {}) {
  const lines = [];
  let lastAssistantText = null;
  for (const m of items || []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role || m.type || "";
    const parts = m.parts || m.content || [];
    const text = typeof m.text === "string" ? m.text
      : Array.isArray(parts) ? cleanText(parts) : "";
    const t = text.trim();
    if (!t) continue;
    if (role === "user" || role === "User") lines.push(`[user] ${t}`);
    else if (role === "assistant" || role === "Assistant") { lastAssistantText = t; lines.push(`[assistant] ${t}`); }
    else lines.push(`[${role || "message"}] ${t}`);
  }
  if (lastOnly && lastAssistantText != null) return `[assistant] ${lastAssistantText}`;
  return lines.join("\n") || "(no messages)";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function originOf(info) {
  return (info && info.metadata && info.metadata.origin) || "user";
}

function ageStr(updatedAt) {
  const ageMs = Date.now() - (updatedAt || Date.now());
  if (ageMs < 60000) return `${Math.max(1, Math.round(ageMs / 1000))}s ago`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m ago`;
  return `${Math.round(ageMs / 3600000)}h ago`;
}

function statsStr(info) {
  const tk = (info && info.tokens) || {};
  const bits = [];
  if (tk.input != null || tk.output != null) bits.push(`tokens: in ${tk.input ?? 0} / out ${tk.output ?? 0}`);
  if (info && info.cost != null) bits.push(`cost: $${Number(info.cost).toFixed(4)}`);
  if (info && info.model) bits.push(`model: ${info.model.providerID || ""}/${info.model.id || ""}`);
  return bits.join(" | ");
}

function statusLine(info, running) {
  const state = running === true ? "running" : running === false ? "finished" : "unknown (engine REST unavailable)";
  let s = `session ${info.id} — ${state}`;
  if (info.title) s += `\ntitle: ${info.title}`;
  if (info.time && info.time.updated) s += `\nupdated: ${ageStr(info.time.updated)}`;
  const stats = statsStr(info);
  if (stats) s += `\n${stats}`;
  s += `\norigin: ${originOf(info)}`;
  return s;
}

async function activeMap() {
  const svc = discoverService();
  if (!svc) return null;
  const res = await rest(svc, "GET", "/api/session/active");
  return (res && res.data) || {};
}

async function waitForIdle(sessionId, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  const startedAt = Date.now();
  const START_SETTLE_MS = 15000;
  // A running session can briefly drop out of /api/session/active between
  // steps/tool calls. Require the session to be ABSENT on two consecutive
  // polls before declaring it idle, and don't trust absence until we have
  // either seen it run or passed the start-settle window (a very fast child
  // can finish before the first poll ever sees it).
  let absentStreak = 0;
  let sawActive = false;
  for (;;) {
    if (signal && signal.aborted) throw new Error("brother-agent: waitForFinish aborted by caller");
    let active;
    try {
      active = await activeMap();
    } catch {
      active = undefined; // transient engine failure — retry next tick
    }
    if (active) {
      if (sessionId in active) {
        sawActive = true;
        absentStreak = 0;
      } else {
        absentStreak++;
        if (absentStreak >= 2 && (sawActive || Date.now() - startedAt > START_SETTLE_MS)) return;
      }
    }
    if (Date.now() >= deadline) return;
    await sleep(Math.min(POLL_MS, Math.max(250, deadline - Date.now())));
  }
}

/** Resolve the model for a new brother: explicit > config file > parent inherit > engine default. */
async function resolveModel(api, args, parentId) {
  if (args.provider !== undefined || args.model !== undefined) {
    if (!args.provider || !args.model) {
      throw new Error("brother-agent: pass `provider` and `model` together, or neither.");
    }
    const out = { providerID: args.provider, id: args.model };
    if (args.variant !== undefined) out.variant = args.variant;
    return out;
  }
  const configured = brotherDefault();
  if (configured) return configured;
  if (parentId) {
    try {
      const parent = await api.session.get({ sessionID: parentId });
      if (parent && parent.model && parent.model.providerID && parent.model.id) {
        let def = null;
        try {
          def = await api.catalog.model.default();
        } catch {
          /* catalog unavailable — inherit unconditionally */
        }
        const d = def && (def.data || def);
        if (!d || d.providerID !== parent.model.providerID || (d.modelID || d.id) !== parent.model.id) {
          return { providerID: parent.model.providerID, id: parent.model.id };
        }
      }
    } catch {
      /* parent unreadable — engine default */
    }
  }
  return undefined;
}

async function readTranscript(api, sessionId, opts) {
  const svc = discoverService();
  if (svc) {
    try {
      const res = await rest(svc, "GET", `/api/session/${encodeURIComponent(sessionId)}/message?limit=200&order=asc`);
      const items = res && res.data ? res.data : [];
      return { text: renderMessages(items, opts), messageCount: items.length, full: true };
    } catch (e) {
      if (e && e.status === 404) throw new Error(`brother-agent: session ${sessionId} not found`);
      // fall through to context fallback
    }
  }
  const ctxItems = await api.session.context({ sessionID: sessionId }).catch((e) => {
    throw new Error(`brother-agent: cannot read session ${sessionId} (${(e && e.message) || e})`);
  });
  return { text: renderContextFallback(ctxItems, opts), messageCount: (ctxItems || []).length, full: false };
}

// ---------------------------------------------------------------------------
// Tool implementations — each returns a plain string (the model's text).
// ---------------------------------------------------------------------------

async function launchBrother(api, args, ctx) {
  const parentId = ctx && ctx.sessionID;
  let directory;
  if (args.cwd) {
    directory = args.cwd;
  } else if (ctx && typeof ctx.directory === "string") {
    directory = ctx.directory;
  } else if (parentId) {
    try {
      const parent = await api.session.get({ sessionID: parentId });
      if (parent && parent.location && parent.location.directory) directory = parent.location.directory;
    } catch {
      /* new session lands in the engine default location */
    }
  }
  const model = await resolveModel(api, args, parentId);
  // Create via REST when discoverable: only the REST create payload carries
  // `metadata` (origin tagging) end-to-end — the setup-bridge create drops
  // it. Setup create is the fallback (degraded: untagged origin).
  const svc = discoverService();
  let sessionId;
  if (svc) {
    const body = { metadata: { origin: ORIGIN } };
    if (directory) body.location = { directory };
    if (model) body.model = model;
    let res;
    try {
      res = await rest(svc, "POST", "/api/session", body);
    } catch (e) {
      throw new Error(`brother-agent: create failed (${(e && e.message) || e})`);
    }
    sessionId = res && res.data && res.data.id;
    if (!sessionId) throw new Error("brother-agent: session.create did not return a session id");
  } else {
    const createArg = { metadata: { origin: ORIGIN } };
    if (directory) createArg.location = { directory };
    if (model) createArg.model = model;
    const created = await api.session.create(createArg);
    sessionId = created && (created.id || (created.data && created.data.id));
    if (!sessionId) throw new Error("brother-agent: session.create did not return a session id");
  }
  // DELIVERY CLASSIFICATION — launch prompt to the new child: STEER.
  // The child is brand-new and idle; measured live (2026-10-05) both steer and
  // queue start it immediately (first-active: steer 0.05s, queue 0.09s), but
  // steer is the system default, matches the doctrine ("time-relevant signal
  // before the recipient's next decision"), and avoids the queue trap if the
  // child already has a turn in flight (a re-prompt). The watch is recorded
  // BEFORE the prompt so a very fast finish can't be missed — the proxy's
  // seenActive guard means a not-yet-active child can never be reported
  // finished. If the prompt is rejected, the watch is removed below: a failed
  // launch must not leave a ghost watch that later reports "finished".
  recordWatch(sessionId, parentId, args.task);
  try {
    await api.session.prompt({ sessionID: sessionId, text: args.task, delivery: "steer" });
  } catch (e) {
    removeWatch(sessionId);
    throw new Error(
      `brother-agent: launch prompt was rejected for ${sessionId} (${(e && e.message) || e}); watch removed — the child was not started`,
    );
  }

  let running = true;
  let text = `launched brother agent session ${sessionId} (running)`;
  if (model) text += `\nmodel: ${model.providerID}/${model.id}`;

  if (args.waitForFinish) {
    const signal = (ctx && (ctx.abort || ctx.signal)) || null;
    if (!discoverService()) {
      // No engine REST (no registration file): single blocking wait capped by timeoutMs.
      const ms = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1800000);
      await Promise.race([
        api.session.wait({ sessionID: sessionId }).catch(() => {}),
        sleep(ms),
      ]);
      if (signal && signal.aborted) throw new Error("brother-agent: waitForFinish aborted by caller");
    } else {
      await waitForIdle(sessionId, args.timeoutMs ?? DEFAULT_TIMEOUT_MS, signal);
    }
    const info = await api.session.get({ sessionID: sessionId }).catch(() => null);
    running = info ? await isRunning(sessionId) : running;
    const rd = await readTranscript(api, sessionId, { lastOnly: !!args.returnLastOnly });
    text += info && info.title ? `\ntitle: ${info.title}` : "";
    text += `\n\n${rd.text}`;
    if (!rd.full) text += "\n(Transcript covers active context only — engine REST unavailable.)";
  }
  return text;
}

async function isRunning(sessionId) {
  try {
    const active = await activeMap();
    if (active === null) return null;
    return sessionId in active;
  } catch {
    return null;
  }
}

async function toolStatus(api, args) {
  const info = await api.session.get({ sessionID: args.sessionId }).catch((e) => {
    throw new Error(`brother-agent: session ${args.sessionId} not found (${(e && e.message) || e})`);
  });
  const running = await isRunning(args.sessionId);
  return statusLine(info, running);
}

async function toolRead(api, args) {
  const rd = await readTranscript(api, args.sessionId, {
    thinking: !!args.includeThinking,
    tools: !!args.includeTools,
    lastOnly: !!args.lastOnly,
  });
  let text = rd.text;
  if (!rd.full) text += "\n(Transcript covers active context only — engine REST unavailable.)";
  return text;
}

// DELIVERY CLASSIFICATION — brother_agent_stop: interrupt only (sends nothing).
// Aborts the recipient's active turn. Destructive; only when work must stop NOW.
async function toolStop(api, args) {
  const res = await api.session.interrupt({ sessionID: args.sessionId });
  const interrupted = !!(res && (res.interrupted ?? res.data?.interrupted));
  return `stop requested for ${args.sessionId} (interrupted: ${interrupted}) — the active turn was aborted; use brother_agent_steer to redirect and keep working, or brother_agent_message for a non-urgent follow-up`;
}

// DELIVERY CLASSIFICATION — brother_agent_message: STEER by default.
// Flipped from the old queue default: a brother works one long turn, so a
// queued message lands when that turn ends — usually after the work it was
// about is done. Steer lands at the next LLM boundary in seconds and is
// non-destructive. `delivery:"queue"` is the deliberate exception (non-urgent,
// "after your current turn", batch). NOTE: the `delivery` arg is exposed by the
// engine tool SCHEMA, which is registration-time — until the next engine boot
// it is not passed in, so message still steers (the safe default); after the
// boot explicit queue works. The logic itself hot-swaps now.
async function toolMessage(api, args) {
  const delivery = args && args.delivery === "queue" ? "queue" : "steer";
  await api.session.prompt({ sessionID: args.sessionId, text: args.text, delivery });
  return delivery === "queue"
    ? `queued to ${args.sessionId} (delivered when its current turn ENDS — non-urgent follow-up)`
    : `steered to ${args.sessionId} (delivered at its next step boundary, in seconds — non-destructive; pass delivery:"queue" to wait for its turn to end instead)`;
}

// DELIVERY CLASSIFICATION — brother_agent_steer: STEER (optionally interrupt).
// Non-destructive by default: joins at the recipient's next LLM-call boundary.
// interrupt:true aborts the active turn first — DESTRUCTIVE, only to stop work
// NOW before sending the correction.
async function toolSteer(api, args) {
  let interrupted = false;
  if (args.interrupt === true) {
    const res = await api.session.interrupt({ sessionID: args.sessionId }).catch(() => null);
    interrupted = !!(res && (res.interrupted ?? res.data?.interrupted));
    // Let cancellation settle so the steer starts the next turn cleanly.
    for (let i = 0; i < 20; i++) {
      const r = await isRunning(args.sessionId);
      if (r !== true) break;
      await sleep(500);
    }
  }
  await api.session.prompt({ sessionID: args.sessionId, text: args.text, delivery: "steer" });
  return `steer sent to ${args.sessionId} (${interrupted ? "turn stopped first — destructive redirect" : "no interrupt — joins at the next step boundary in seconds"})`;
}

/**
 * Archive = hard removal (v2 has no archive endpoint). Two safety layers,
 * added 2026-10-05 after two live brother sessions were hard-deleted with no
 * trace (the engine logs no actor on session deletion):
 *   1. REFUSE while the target is RUNNING — deleting active work destroys its
 *      transcript and cannot be undone; stop it first if that is intended.
 *   2. AUDIT every attempt (caller, target, running state, result) to
 *      <state>/brother-archive.log.
 */
async function toolArchive(api, args, ctx) {
  const svc = discoverService();
  if (!svc) {
    throw new Error("brother-agent: archive needs engine REST (no service registration file found) — nothing was removed.");
  }
  const caller = (ctx && ctx.sessionID) || "unknown";
  const running = await isRunning(args.sessionId).catch(() => null);
  const audit = (result) => {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.appendFileSync(
        path.join(stateDir(), "brother-archive.log"),
        `${new Date().toISOString()} caller=${caller} target=${args.sessionId} running=${running} result=${result}\n`,
      );
    } catch {
      /* the audit trail must never block or break the tool */
    }
  };
  // Fail CLOSED: refuse unless we positively know the session is NOT running.
  // isRunning returns true/false, or null when /api/session/active is
  // unreachable. `null` is NOT proof the target is idle — deleting on an
  // unknown running state is exactly the destructive case this guard exists
  // for (removal is irreversible). A transient REST failure therefore refuses
  // (audit-logged) and the caller can retry; that is the safe direction.
  if (running !== false) {
    audit(running === true ? "refused-running" : "refused-unknown");
    throw new Error(
      `brother-agent: refusing to archive ${args.sessionId} — the session is ${running === true ? "RUNNING" : "in an UNKNOWN running state (engine /session/active unreachable)"}. ` +
        `Stop it first with brother_agent_stop if that is truly intended; archiving active work destroys its transcript. ` +
        `(attempt logged to ${path.join(stateDir(), "brother-archive.log")})`,
    );
  }
  try {
    await rest(svc, "DELETE", `/api/session/${encodeURIComponent(args.sessionId)}`);
  } catch (e) {
    if (e && e.status === 404) {
      audit("already-gone");
      return `archived ${args.sessionId} (already gone)`;
    }
    audit(`error:${(e && e.message) || e}`);
    throw e;
  }
  audit("removed");
  return `archived ${args.sessionId} (removed from the session list; audit-logged)`;
}

async function toolList(api, args) {
  // Origin-filter decision (DOCUMENT, don't filter):
  // subagent grandchildren inherit metadata.origin="brother-agent" (the engine
  // copies parent metadata onto delegated descendants), so `list` includes
  // delegated descendants alongside directly-launched brothers. This is
  // intentional: the origin tag answers "which tree spawned this session",
  // not "which tool call created it directly". Strictly filtering to direct
  // children would hide delegated work the user still owns; callers who need
  // only direct brothers can join against the watch seam file
  // (brother-watches.json), which records only explicit launch/watch links.
  // List behavior below is unchanged — this comment documents the inheritance.
  const svc = discoverService();
  if (!svc) {
    throw new Error("brother-agent: list needs engine REST (no service registration file found).");
  }
  const limit = Math.min(args.limit ?? 50, 200);
  const res = await rest(svc, "GET", `/api/session?limit=${limit}&order=desc`);
  const items = (res && res.data ? res.data : []).slice(0, limit);
  const active = await activeMap().catch(() => ({}));
  // Origin: native metadata first; seam membership backs up sessions whose
  // create path dropped metadata (setup-bridge creates).
  let seam = {};
  try {
    seam = readWatches();
  } catch {
    /* origin falls back to metadata only */
  }
  let rows = items.map((s) => ({
    sessionId: s.id,
    origin: originOf(s) !== "user" ? originOf(s) : (seam[s.id] ? ORIGIN : "user"),
    running: !!(active && s.id in active),
    updatedAt: (s.time && s.time.updated) || 0,
    title: s.title || "",
    tokens: s.tokens || {},
  }));
  if (args.origin) rows = rows.filter((r) => r.origin === args.origin);
  if (args.status === "running") rows = rows.filter((r) => r.running);
  else if (args.status === "finished") rows = rows.filter((r) => !r.running);
  rows.sort((a, b) => (b.running - a.running) || (b.updatedAt - a.updatedAt));
  const lines = rows.map((r) => {
    const state = r.running ? "RUNNING" : "finished";
    const tok = r.tokens.input != null ? ` in ${r.tokens.input}/out ${r.tokens.output ?? 0}` : "";
    return `${r.sessionId} [${r.origin}] ${state} "${r.title}"${tok} ${ageStr(r.updatedAt)}`;
  });
  const text = lines.join("\n") || "(no sessions match)";
  return `${text}\nfilter: origin=${args.origin ?? "*"} status=${args.status ?? "*"}`;
}

const IMPLS = {
  brother_agent: launchBrother,
  brother_agent_status: toolStatus,
  brother_agent_read: toolRead,
  brother_agent_stop: toolStop,
  brother_agent_message: toolMessage,
  brother_agent_steer: toolSteer,
  brother_agent_archive: toolArchive,
  brother_agent_list: toolList,
};

/** Shell entry: run one tool, resolving to a result object ({output} —
 * the engine requires an object; a bare string fails result validation). */
async function executeTool(api, toolName, args, ctx) {
  if (toolName === "brother_agent_watch") {
    const parent = (args && args.notifySessionId) || (ctx && ctx.sessionID);
    if (!parent) {
      throw new Error("brother_agent_watch: cannot determine the notifying session (no notifySessionId and no calling session)");
    }
    for (const id of args.sessionIds || []) recordWatch(id, parent, "(manual watch)");
    return { output: `watching ${(args.sessionIds || []).length} session(s); ${parent} will be steered a notice when each finishes` };
  }
  const fn = IMPLS[toolName];
  if (typeof fn !== "function") throw new Error(`brother-agent: unknown tool ${toolName}`);
  const out = await fn(api, args || {}, ctx || {});
  return { output: typeof out === "string" ? out : JSON.stringify(out) };
}

module.exports = {
  executeTool,
  // exported for tests / shell introspection
  renderMessages,
  renderContextFallback,
  originOf,
  recordWatch,
  removeWatch,
  readWatches,
  brotherDefault,
  discoverService,
};
