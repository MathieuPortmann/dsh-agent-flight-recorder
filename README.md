# dsh-agent-flight-recorder

Live runtime health for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) agents.
It watches tool calls as they happen and tells **you** (panel) and **the model** (short notices)
when the agent is going round in circles.

> **Maintenance:** best-effort. Issues may go unanswered; forks are welcome.

## What it does

- **Loop detection** over the last 100 tool calls: the same tool called many times in a row
  (even with slightly different arguments, which defeats identical-call detectors), the same
  error coming back, a high error rate.
- **`runtime_health` tool** the model can call when it suspects it is stuck: counts, error rate,
  average latency, most used tool, a status (`healthy` / `warning` / `critical`), a `loopRisk`
  estimate in 0..1, reasons and a recommendation.
- **Live alerts**: a ~40-token notice added to the tool result when a threshold is crossed.
- **Per-turn summary** sent to the model after each turn (about 20 tokens when healthy).
- **Web UI**: a *Runtime Health* chip under the composer that opens a panel, a one-line summary
  under every completed turn, and a detailed conversation report (tokens, tools, "points to verify"
  such as a file written to an unexpected path, or sources cited without any search).
- English and French UI.

It only observes and annotates: no network, no shell, no file writes, no blocking.
All state is derived from the durable session log, so it survives page reloads and disappears when
the plugin is removed. See [SPEC.md](SPEC.md) for the rules and the `loopRisk` formula.

## Install

```sh
dsh plugin --profile web add dsh-agent-flight-recorder
# or straight from GitHub:
dsh plugin --profile web add github:MathieuPortmann/dsh-agent-flight-recorder
```

Restart the profile afterwards. Requires Node >= 22.6 and DSH 0.2.x.

Optional companion: [`@beibeihk/dsh-agent-observability`](https://www.npmjs.com/package/@beibeihk/dsh-agent-observability)
(durable per-session recorder, `/observe` report). This plugin does not depend on it.

## Configuration

Row `agent-flight-recorder` in your profile's `cordis.patch.yml`; every key is optional.

| Key | Default | Meaning |
|---|---|---|
| `windowSize` | 100 | tool calls kept for the rules |
| `sameToolWarning` / `sameToolCritical` | 4 / 6 | consecutive calls of one tool |
| `sameErrorWarning` / `sameErrorCritical` | 2 / 3 | same normalized error repeated |
| `errorRateWarning` / `errorRateCritical` | 0.2 / 0.3 | error rate (after `errorRateMinCalls`, default 10) |
| `shellTools` | `[bash, pwsh]` | tools treated as shell commands |
| `turnSummaryToModel` | true | send the per-turn summary to the model |
| `liveAlerts` | true | add alerts to tool results |

## Permissions and external services

None. No network access, no files written, no dependency outside the libraries shipped with DSH.

## Develop

```sh
npm test
```

## License

MIT
