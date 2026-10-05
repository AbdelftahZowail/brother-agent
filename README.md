# brother-agent

**Parallel-session workers for [OpenCode](https://opencode.ai) v2.**

`brother-agent` is an OpenCode plugin that gives the model a small toolkit for
launching and driving **fresh top-level agent sessions** — "brothers" — for
large or independent tasks. A brother is a full agent in its own context: it can
plan, use tools, and spawn its own subagents. The point is to move big work out
of the current context without losing the ability to supervise it.

This is the reference implementation of the *parallel-session worker* that the
[`super-vibe`](https://github.com/AbdelftahZowail/super-vibe) method refers to,
and it works on plain OpenCode v2 — **no web runner required**.

## What you get

Once installed, the model can call:

| Tool | What it does |
| --- | --- |
| `brother_agent` | Launch a fresh session with a self-contained task. Returns its id and running state; optionally block until the first turn finishes. |
| `brother_agent_status` | Is it still working, and for how long. |
| `brother_agent_read` | Read its transcript (final output, or with tools/thinking). |
| `brother_agent_message` | Send it a follow-up — **steers** by default (joins at its next step); `queue` to defer to its next turn end. |
| `brother_agent_steer` | Steer at the next step boundary; `interrupt: true` aborts the active turn first. |
| `brother_agent_stop` | Abort its current turn (sends nothing). |
| `brother_agent_archive` | Remove a session from the list. Refuses to touch a **running** session, and audits every attempt. |
| `brother_agent_list` | List sessions with origin tag, status, age, token usage. |
| `brother_agent_watch` | Get a notice when a session (launched elsewhere) finishes. |

Finish notices are **steered** into the watching session at its next step
boundary — no browser needed.

## Install

Point OpenCode at the `engine/` folder from your `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugin": ["/absolute/path/to/brother-agent/engine"]
}
```

The engine loads `engine/index.js` as the entrypoint. Restart once after
installing; after that, edits to `engine/definitions.cjs` (the tool logic) hot-swap
on the next tool call — no restart needed.

## How it works

- `engine/index.js` — the stable shell: registers the tool schemas exactly once
  via OpenCode v2's `tool.transform` API, and stat-polls `definitions.cjs`,
  re-requiring it on change (hot-swap of logic, fixed schemas).
- `engine/definitions.cjs` — all tool logic. Discovers the engine via its
  service registration file and talks to it over REST.
- Watch/delivery state lives under `$XDG_STATE_HOME/opencode-webui/`
  (`brother-watches.json`, `brother-archive.log`). **That path is shared with the
  OpenCode webui** if you run one, so a webui can render the same sessions and
  deliver the same notices. It is *optional*: the plugin writes those files
  itself, and with no webui running nothing else reads them — the tools,
  including headless finish notices, work the same. Only the browser UI for
  brothers (sidebar rows, live rows) is webui-only and simply absent.

## Safety

- `brother_agent_archive` is a hard delete (v2 has no archive endpoint). It
  **refuses** when the target is running or when running-state can't be
  confirmed, and logs every attempt (allowed and refused) to
  `$XDG_STATE_HOME/opencode-webui/brother-archive.log` with the calling session.
- Deletes go to the engine's REST API directly, so they are only as safe as the
  guard around them — which is why the guard exists.

## License

MIT — see [LICENSE](LICENSE).
