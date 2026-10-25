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

Restart the profile afterwards. Requires Node `^22.19.0 || >=24` and DSH `>=0.2.0-rc.2 <0.3.0` (see [Compatibility](#compatibility)).

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

## Compatibility

| Component | Supported |
|---|---|
| Node.js | `^22.19.0 \|\| >=24.0.0` (`engines.node`) |
| DSH | `>=0.2.0-rc.2 <0.3.0`; declared as optional `peerDependencies` on `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery` (`>=3.18.0 <4.0.0`) and `zod` (`>=4.0.0 <5.0.0`), the packages the plugin loads from the DSH installation |
| Platform | Linux (tested); pure JavaScript, no native addon |

Tested with DSH `0.2.0-rc.2` on Node 22.23 (see [Verification](#verification)).

## Permissions and external services

| Capability | Used? | Detail |
|---|---|---|
| Files | no | nothing is read from or written to disk by the plugin itself; its state lives in the DSH session log |
| Network | no | no request of any kind |
| Commands | no | no process is started |
| Dynamic module loading | yes | `index.js` (`importFromDsh`) loads `zod`, `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` from the DSH installation that runs the plugin (a synchronous `require` of an ES module fails on Node 22). Nothing is downloaded and no code is evaluated from text (`eval` / `new Function` are not used). The plugin fails to load if DSH does not provide them |

It adds one read-only tool (`runtime_health`) and, when `liveAlerts` is on, appends short alerts to
tool results. It never blocks or modifies a tool call.

## Verification

Checked on a disposable profile (`DSH_HOME` pointing at a temporary folder, profile cloned with
`dsh <name> --from-default-profile web`, so the real profile is never touched):

```sh
npm pack
dsh plugin --profile t add file:$PWD/dsh-agent-flight-recorder-0.1.0.tgz   # install
dsh --profile t --no-open --port 3095                                       # start: plugin loads, no error
dsh plugin --profile t remove dsh-agent-flight-recorder                      # uninstall
```

`npm test` runs standalone tests with no DSH installation needed, except the load test, which
skips when DSH is absent.

## Develop

```sh
npm test
```

## License

MIT
