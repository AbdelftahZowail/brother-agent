# brother-agent

**Parallel-session workers for [OpenCode](https://opencode.ai) v2.**

`brother-agent` gives the model a small toolkit for launching and driving
**fresh top-level agent sessions** — "brothers" — for large or independent
tasks. A brother is a full agent in its own context: it can plan, use tools, and
spawn its own subagents. The point is to move big work out of the current
context without losing the ability to supervise it.

It works on **plain OpenCode v2** (engine-only, no web runner), and optionally
lights up a richer UI when you also run the
[`opencode-webui`](https://github.com/AbdelftahZowail/opencode-webui) frontend.

This is the reference implementation of the *parallel-session worker* that the
[`super-vibe`](https://github.com/AbdelftahZowail/super-vibe) method refers to.

## Part of a small ecosystem

| Repo | What it is |
| --- | --- |
| **brother-agent** (this) | The parallel-worker plugin: engine tools + optional webui UI. |
| [**super-vibe**](https://github.com/AbdelftahZowail/super-vibe) | The *method* for big work (build + ship). Portable; references brother-agent as its parallel-worker. |
| [**opencode-webui**](https://github.com/AbdelftahZowail/opencode-webui) | The web frontend for the OpenCode v2 engine that renders these sessions live. |

They compose but stand alone: use brother-agent with just the TUI, use the webui
without brother-agent, or all three together.

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

## Layout

One extension, up to four strata (see the opencode-webui extension spec):

```
engine/         OpenCode v2 plugin payload — the tests+the tools. REQUIRED.
  index.js        stable shell: registers tool schemas via api.tool.transform
  definitions.cjs all tool logic (hot-swaps on edit)
server.ts       optional webui proxy half: delivery state + headless steering
index.tsx       optional webui browser half: sidebar rows / live UI
manifest.json   webui extension manifest
```

- **Standalone on OpenCode v2:** the `engine/` folder alone is enough. It uses
  only Node built-ins (`fs`/`os`/`path`) and the v2 plugin API, and reaches the
  engine through its own service-registration file (`$XDG_STATE_HOME/opencode/service.json`).
  No webui required.
- **With opencode-webui:** drop the whole folder into your webui-extensions
  directory; the proxy and browser halves add live UI for brothers.

## Install

**Engine only (plain OpenCode v2):** point OpenCode at the `engine/` folder from
`opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugin": ["/absolute/path/to/brother-agent/engine"]
}
```

**With the web runner:** copy the whole folder into your webui extensions dir
(user / project / shipped — highest precedence wins), e.g.
`~/.config/opencode/webui-extensions/brother-agent/`, and keep the `engine`
entry above pointing at its `engine/` subfolder.

Either way, restart once after installing. Afterwards, edits to
`engine/definitions.cjs` hot-swap on the next tool call — no restart needed.

## How it works

- **Engine discovery** reads OpenCode's own registration file
  (`$XDG_STATE_HOME/opencode/service.json` → `{url, password}`) and talks to the
  engine over REST — the same contract the webui proxy uses. Read-only: never
  spawns, never writes the registration.
- **Hot-swap:** `index.js` stat-polls `definitions.cjs` and re-requires it on
  change (CJS require-cache bust). Tool *schemas* are fixed at registration;
  only logic hot-swaps.
- **Watch seam:** watch/delivery state lives under
  `$XDG_STATE_HOME/opencode-webui/` (`brother-watches.json`,
  `brother-archive.log`). The plugin writes these itself; with no webui running
  nothing else reads them and the tools — including headless finish notices —
  work the same. The webui simply reads the same seam to render sessions.

## Safety

- `brother_agent_archive` is a hard delete (v2 has no archive endpoint). It
  **refuses** when the target is running or when running-state can't be
  confirmed, and logs every attempt (allowed and refused) to
  `$XDG_STATE_HOME/opencode-webui/brother-archive.log` with the calling session.
- Deletes go to the engine's REST API directly, so they are only as safe as the
  guard around them — which is why the guard exists.

## License

MIT — see [LICENSE](LICENSE).
