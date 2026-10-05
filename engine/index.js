// brother-agent — engine payload, stable shell.
//
// Registers the `brother_agent*` tools exactly once via the v2
// `tool.transform` API. All tool LOGIC lives in ./definitions.cjs, which
// this shell stat-polls and re-requires on change (CJS require-cache bust):
// editing definitions.cjs applies to the NEXT tool call with no engine
// restart. Tool schemas stay fixed at registration time — only logic
// hot-swaps.
//
// Install: point the engine at this folder, e.g. in opencode.json:
//   { "plugin": ["/path/to/webui-extensions/brother-agent/engine"] }
// (absolute folder path; the loader resolves index.js as the entrypoint).
// Engine rules apply: a restart picks up edits to THIS shell file.
//
// v2 plugin shape: default export { id, setup } — NOT the v1 { server } /
// named-export shape (the loader rejects those with "Plugin must export a
// default definition with an id and an effect or setup function").

const fs = require("node:fs");
const path = require("node:path");

const DEFINITIONS_FILE = path.join(__dirname, "definitions.cjs");

// Fixed tool schemas — the model-visible contract. Logic hot-swaps, these
// do not: edits here apply ONLY on the NEXT ENGINE BOOT (registration-time).
// In particular the `delivery` property added to brother_agent_message below
// is not visible to the model until then — until that boot, brother_agent_message
// still steers (the safe hot-swapped default); explicit queue needs this schema.
const TOOL_SCHEMAS = [
  {
    name: "brother_agent",
    description:
      "Launch a fresh, clean-context agent session (a 'brother agent') to work on a large task independently. " +
      "The new session is a full agent with the complete toolset — it plans and can spawn its own " +
      "sub-agents — so give it a self-contained task prompt. Returns the new session id and whether it " +
      "is running. With waitForFinish=true it blocks until the first turn finishes and returns the final result text. " +
      "Use brother_agent_status / brother_agent_read / brother_agent_message / brother_agent_steer / brother_agent_stop afterwards. " +
      "With returnLastOnly=true, a waitForFinish result returns just the final assistant output instead of the full transcript. " +
      "Optionally choose a specific model for the new session by passing `provider` and `model` together; when omitted, the " +
      "configured brother default applies, else the parent session's model is inherited, else the engine default is used.",
    input: {
      type: "object",
      properties: {
        task: { type: "string", description: "The complete, self-contained task prompt for the brother agent." },
        cwd: { type: "string", description: "Optional working directory for the new session (defaults to the launcher's own directory)." },
        provider: { type: "string", description: "Optional provider for the brother agent (with `model`)." },
        model: { type: "string", description: "Optional model id for the brother agent (with `provider`)." },
        variant: { type: "string", description: "Optional model variant (reasoning effort) for the selected model." },
        waitForFinish: { type: "boolean", description: "Block until the first turn finishes and return the final result (default false)." },
        timeoutMs: { type: "integer", description: "Max wait in milliseconds when waitForFinish is true (default 1800000 = 30 minutes)." },
        returnLastOnly: { type: "boolean", description: "With waitForFinish=true, return only the last assistant output instead of the full transcript (default false)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_status",
    description: "Check whether a brother-agent session is still working or finished, plus its title, age, and token/cost stats.",
    input: {
      type: "object",
      properties: { sessionId: { type: "string", description: "Session id returned by brother_agent." } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_read",
    description:
      "Read a brother-agent session's transcript as CLEAN plain text (user and assistant messages only). " +
      "Default shows final text only. Set includeThinking to include reasoning, includeTools to include tool calls and results, " +
      "or lastOnly to return just the last assistant output.",
    input: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        includeThinking: { type: "boolean", description: "Include reasoning/thinking blocks (default false)." },
        includeTools: { type: "boolean", description: "Include tool calls and results (default false)." },
        lastOnly: { type: "boolean", description: "Return only the last assistant output (default false)." },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_stop",
    description: "Stop a brother-agent session's active turn (aborts the running agent; sends nothing). Destructive — only when work must stop NOW. Queued work stays queued.",
    input: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_message",
    description:
      "Send a message to a brother-agent session. By default this STEERS — it joins at the brother's next " +
      "step boundary (seconds, non-destructive), which is what you want for a brother working one long turn. " +
      "Set delivery=\"queue\" for a deliberate non-urgent follow-up that should wait until the brother's current " +
      "turn ENDS (immediate if idle). For a destructive redirect that stops the brother's turn first, use " +
      "brother_agent_steer with interrupt=true; to just abort, use brother_agent_stop.",
    input: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        text: { type: "string", description: "The message to send to the brother agent." },
        delivery: {
          type: "string",
          enum: ["steer", "queue"],
          description:
            "steer (default) = deliver at the next step boundary in seconds; queue = deliver when the current turn ends (non-urgent).",
        },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_steer",
    description:
      "Steer a brother-agent session (delivered at the next step boundary; current work is not killed). " +
      "With interrupt=true it aborts the active turn first, then sends — destructive; only when work must stop NOW. " +
      "brother_agent_message already steers by default, so use this tool when you specifically need interrupt control.",
    input: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        text: { type: "string", description: "The steering message." },
        interrupt: { type: "boolean", description: "Abort the running turn before sending (default false; destructive)." },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_archive",
    description:
      "Remove a brother-agent session so it disappears from the session list. Idempotent for an already removed id.",
    input: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_list",
    description:
      "List sessions with their origin tag (brother-agent vs user), status (running / finished), " +
      "title, age, and token usage. Optional filters: origin, status, limit. Sessions not launched " +
      "as brothers are shown as user.",
    input: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Filter by origin tag, e.g. brother-agent, user." },
        status: { type: "string", description: "Filter by status: running, finished." },
        limit: { type: "integer", description: "Max rows (default 50, cap 200)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "brother_agent_watch",
    description:
      "Watch one or more sessions and have the caller notified when each finishes (and when all of them are done). " +
      "Used for sessions launched outside brother_agent (e.g. pre-existing ones) — brother_agent launches are watched automatically. " +
      "Each notice is STEERED into the notify session (default: the calling session) — delivered at its next step boundary " +
      "(immediate if idle), and headless (no browser needed). A child is only reported finished after it has actually run; " +
      "a launch that never starts is reported as 'did not start' after a grace window.",
    input: {
      type: "object",
      properties: {
        sessionIds: { type: "array", items: { type: "string" }, description: "Session ids to watch." },
        notifySessionId: { type: "string", description: "Session that receives the finish notices (default: the calling session)." },
      },
      required: ["sessionIds"],
      additionalProperties: false,
    },
  },
];

const OUTPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: true };

// Short system hint so the model knows brothers exist. Detail lives in the
// tool descriptions above.
const SYSTEM_HINT =
  "For a LARGE task that deserves its own clean context (planning + its own sub-agents), " +
  "delegate via the brother_agent tool with a self-contained prompt instead of doing it inline.";

let cached = null;
let cachedMtimeMs = 0;

function loadDefinitions() {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(DEFINITIONS_FILE).mtimeMs;
  } catch {
    throw new Error("brother-agent: definitions.cjs missing next to index.js");
  }
  if (!cached || mtimeMs !== cachedMtimeMs) {
    delete require.cache[require.resolve(DEFINITIONS_FILE)];
    cached = require(DEFINITIONS_FILE);
    cachedMtimeMs = mtimeMs;
  }
  return cached;
}

async function setup(api) {
  // System hint via the session context hook (same shape the builtin
  // prompt plugins splice in: { type: "text", text } — the engine validates
  // system parts strictly and fails the whole drain on a missing `type`).
  try {
    await api.session.hook("context", (m) => {
      try {
        if (m && Array.isArray(m.system)) m.system.push({ type: "text", text: SYSTEM_HINT });
      } catch {
        /* hint is best-effort */
      }
    });
  } catch {
    /* older engines without session.hook: tools still work */
  }

  await api.tool.transform((tools) => {
    for (const schema of TOOL_SCHEMAS) {
      tools.add({
        name: schema.name,
        description: schema.description,
        input: schema.input,
        output: OUTPUT_SCHEMA,
        execute: async (args, ctx) => {
          const defs = loadDefinitions();
          const fn = defs.executeTool;
          if (typeof fn !== "function") throw new Error("brother-agent: definitions.cjs does not export executeTool");
          return fn(api, schema.name, args || {}, ctx || {});
        },
      });
    }
  });

  return undefined;
}

module.exports = { id: "brother-agent", setup };
