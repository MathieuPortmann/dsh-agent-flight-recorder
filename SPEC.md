# Agent Flight Recorder — specification

Live runtime health for DeepSeek Harness agents. It is designed to
**complement** `@beibeihk/dsh-agent-observability` (optional), which stays the
durable recorder (per-session files, failure cases, `/observe` report). Nothing
here duplicates it.

## Why it is a persistent bundle, not a dynamic in-memory package
DSH 0.2.0 removed the model tools that created dynamic in-memory packages
(`cordis_define` / `cordis_run` / `cordis_stop`); persistent bundles are the
supported route. The design constraint is therefore: *no state outside the session log*.
All state is a session projection derived from the durable log, so it is
bounded, replayable, survives page reloads, and disappears with the plugin.
"Stop" is uninstalling or disabling the bundle.

## Architecture
| Part | File | Mechanism |
|---|---|---|
| Pure computations | `lib/health.js` | fold, rules, loopRisk, texts; no I/O, deterministic |
| Session projection `flightRecorder` | `index.js` | `ctx.sessionProjections.register` with `wire.view` (Host → Web UI) |
| Tool `runtime_health` | `index.js` | `ctx.tools.register(defineTool(...))` at profile root: global, inherited by every preset |
| Per-turn summary for the model | `index.js` | `agent/status` → `idle`: `agent.inject()` one labeled notice (`source.kind = agent-flight-recorder`) |
| Live alerts | `index.js` | `tools/post-execute`: `additionalContexts` notice at warning/critical thresholds |
| Runtime Health panel | `client.js` | `conversation.composer.dock` entry, expandable |
| Per-turn summary on screen | `client.js` | `conversation.chat.turnTail` entry under every completed turn |
| Language | `client.js` | adds a `fr` language (fallback `en`) and FR/EN dictionaries; model-facing text stays English |

Dependencies are only the libraries shipped with dsh (`zod`, `@deepseek-ai/dsh-tools`,
`@deepseek-ai/schemastery`), imported asynchronously from the dsh installation
(a synchronous `require()` of an ES module dsh is still loading fails with
`ERR_INTERNAL_ASSERTION` on Node 22).

## Data model (projection state, plain JSON, bounded)
- totals: `total`, `ok`, `err`, `latencySum`, `latencyCount`, `byTool{name:{calls,errors}}`;
- `pending{callId}`: open calls, cleared at `turn/end`;
- `window`: last `windowSize` (100) settled calls `{n tool, a args hash, s ok|err, e error key, ms, t turn}`;
- `turns`: last 30 per-turn summaries `{turn, calls, errors, longestRun, status, loopRisk, reasons, recommendation, ended}`.

## Detection rules (over the bounded window)
| Rule | warning | critical |
|---|---|---|
| Same tool consecutive (arguments may differ) | ≥ 4 | ≥ 6 |
| Same error (tool + normalized message) | ≥ 2 | ≥ 3 |
| Error rate, after ≥ 10 calls | > 20 % | > 30 % |
Shell tools (`bash`, `pwsh`) get a `shellRepeat` reason and a shell-specific recommendation, but only when the repeated commands are identical (varying shell commands are normal work).
"Same tool regardless of arguments" is deliberate: models vary the `description`
argument of bash on every call, so identical-argument detectors (native
`repeat-tool-reminder`, observability F03) miss these loops (observed with all four models tried).

## loopRisk (0..1) — deterministic heuristic, not a scientific measure
```
loopRisk    = 0.5 * runScore + 0.3 * repeatScore + 0.2 * rateScore
runScore    = clamp01((current same-tool run - 1) / (sameToolCritical - 1))
repeatScore = clamp01((most repeated error in window - 1) / (sameErrorCritical - 1))
rateScore   = window has >= errorRateMinCalls calls ? clamp01(errorRate / errorRateCritical) : 0
```
It uses the *current* run, so it drops as soon as the agent changes approach;
`status` keeps the worst pattern still inside the window.

## Configuration (`cordis.patch.yml` row `agent-flight-recorder`)
`windowSize`, `sameToolWarning`, `sameToolCritical`, `sameErrorWarning`,
`sameErrorCritical`, `errorRateWarning`, `errorRateCritical`, `errorRateMinCalls`,
`shellTools`, `turnSummaryToModel` (default true), `liveAlerts` (default true).

## Token cost
Live alerts: about 40 tokens, only when a threshold is crossed. Turn summary:
about 20 tokens when healthy, 60-80 when not, once per turn.

## Tests
Run `npm test` (Node >= 22.6). `tests/health.test.mjs` replays synthetic session events through the
pure fold and checks counts, rules, `loopRisk`, texts and determinism. `tests/load.test.mjs` loads the
Host half with a fake context (skipped when the `dsh` CLI is not on `PATH`).
