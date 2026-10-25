/**
 * Agent Flight Recorder — Host half.
 *
 * Complements @beibeihk/dsh-agent-observability (durable recorder and detailed
 * report) with the live parts it lacks:
 *   - `flightRecorder` session projection: bounded runtime-health state derived
 *     from the durable log (video spec rules, loopRisk), sent to the Web UI;
 *   - `runtime_health` model-facing tool returning that state as JSON;
 *   - a compact health summary injected into the model context after every
 *     turn (the model sees it at the start of the next turn);
 *   - live mid-turn alerts when the same tool or the same error repeats,
 *     including calls whose arguments differ slightly (a blind spot of the
 *     native repeat-tool-reminder, which needs identical arguments).
 *
 * Constraints kept from the video spec: no network, no shell, no database,
 * no file writes, no blocking interception (observe and annotate only), no
 * external dependency. Every registration is a Cordis effect, so unloading
 * the plugin removes the tool, the projection and the listeners.
 */
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  DEFAULTS, STATE_VERSION, initState, applyEvent, report,
  turnSummaryText, liveAlertText,
} from './lib/health.js';

// Libraries shipped with dsh resolve from the dsh installation itself.
// They are imported asynchronously: a synchronous require() of an ES module
// that dsh is still loading fails with ERR_INTERNAL_ASSERTION (Node 22).
const dshRequire = createRequire(realpathSync(process.argv[1]));
const importFromDsh = id => import(pathToFileURL(dshRequire.resolve(id)).href);
const { z } = await importFromDsh('zod');
const { defineTool } = await importFromDsh('@deepseek-ai/dsh-tools');
const SchemaModule = await importFromDsh('@deepseek-ai/schemastery');
const Schema = SchemaModule.default ?? SchemaModule;

export const name = 'agent-flight-recorder';
export const inject = ['sessionProjections', 'tools'];

export const Config = Schema.object({
  windowSize: Schema.number().min(10).max(1000).step(1).default(DEFAULTS.windowSize),
  sameToolWarning: Schema.number().min(2).step(1).default(DEFAULTS.sameToolWarning),
  sameToolCritical: Schema.number().min(3).step(1).default(DEFAULTS.sameToolCritical),
  sameErrorWarning: Schema.number().min(2).step(1).default(DEFAULTS.sameErrorWarning),
  sameErrorCritical: Schema.number().min(2).step(1).default(DEFAULTS.sameErrorCritical),
  errorRateWarning: Schema.number().min(0).max(1).default(DEFAULTS.errorRateWarning),
  errorRateCritical: Schema.number().min(0).max(1).default(DEFAULTS.errorRateCritical),
  errorRateMinCalls: Schema.number().min(1).step(1).default(DEFAULTS.errorRateMinCalls),
  shellTools: Schema.array(String).default([...DEFAULTS.shellTools]),
  turnSummaryToModel: Schema.boolean().default(true),
  liveAlerts: Schema.boolean().default(true),
});

const KEY = 'flightRecorder';
const SOURCE_KIND = 'agent-flight-recorder';

/** Same shape as dsh-llm createUserMessage: frozen, identified, labeled user-role context. */
function contextMessage(text, summary) {
  return Object.freeze({
    role: 'user',
    id: randomUUID(),
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: SOURCE_KIND, form: 'notice', summary }),
  });
}

function errorTextOf(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return String(result?.error?.message ?? '');
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...rawConfig };

  // --- 1. Session projection (state derived from the durable log) ---------
  const views = new WeakMap();
  const viewOf = state => {
    let view = views.get(state);
    if (!view) { view = report(state, config); views.set(state, view); }
    return view;
  };
  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: STATE_VERSION,
    stateSchema: z.object({ version: z.literal(STATE_VERSION) }).passthrough(),
    init: header => initState(header),
    apply: (state, event) => applyEvent(state, event, config),
    wire: { viewSchema: z.any(), view: viewOf },
  });
  const stateOf = session => ctx.sessionProjections.stateOf(session, KEY) ?? initState();

  // --- 2. Model-facing tool ------------------------------------------------
  ctx.tools.register(defineTool({
    name: 'runtime_health',
    description: 'Report the health of your own tool activity in this session: call and error counts, average latency, most used tool, consecutive similar calls, repeated errors, a status (healthy, warning, critical), a loop-risk estimate between 0 and 1, the reasons and a recommendation. Call it when you suspect you are repeating yourself or stuck; it never changes anything. Metrics that cannot be measured are listed in "unavailable".',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(_args, exec) {
      if (!exec.agent) throw new Error('runtime_health requires an owning agent session');
      const { turns, ...health } = report(stateOf(exec.agent.session), config);
      return Promise.resolve(JSON.stringify(health, null, 2));
    },
  }));

  // --- 3. Health summary to the model after every turn ---------------------
  // Injected when the agent goes idle; it waits in the inbox and enters the
  // next turn's first step, so it costs a few tokens once per turn.
  const lastInjected = new WeakMap();
  ctx.on('agent/created', ({ agent }) => {
    // A resumed session must not re-inject summaries of old turns.
    const last = stateOf(agent.session).turns.at(-1);
    if (last) lastInjected.set(agent, last.turn);
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (!config.turnSummaryToModel || status !== 'idle') return;
    const last = stateOf(agent.session).turns.at(-1);
    if (!last || lastInjected.get(agent) === last.turn) return;
    lastInjected.set(agent, last.turn);
    // "Points to verify" (suspicious claims) stay on screen only: a guard plugin may already
    // raise them to the model during the turn, so repeating them next turn would be a duplicate.
    const text = turnSummaryText({ ...last, suspicious: [] });
    if (text) agent.inject(contextMessage(text, `runtime health · ${last.status}`));
  });

  // --- 4. Live alerts while the agent works --------------------------------
  // Own per-agent chain (the projection only sees the call after this hook).
  const chains = new WeakMap();
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next();
    if (!config.liveAlerts || !exec.agent) return downstream;
    const chain = chains.get(exec.agent) ?? { tool: null, run: 0, errors: new Map() };
    chain.run = chain.tool === exec.name ? chain.run + 1 : 1;
    chain.tool = exec.name;
    let alert;
    const shell = config.shellTools.includes(exec.name);
    if (chain.run === config.sameToolWarning || chain.run === config.sameToolCritical) {
      const level = chain.run >= config.sameToolCritical ? 'critical' : 'warning';
      alert = { level, reason: { code: shell ? 'shellRepeat' : 'sameTool', tool: exec.name, count: chain.run } };
    }
    if (result?.isError) {
      const key = `${exec.name}::${errorTextOf(result).slice(0, 160).replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim()}`;
      const count = (chain.errors.get(key) ?? 0) + 1;
      chain.errors.set(key, count);
      if (chain.errors.size > config.maxErrorKeys) chain.errors.delete(chain.errors.keys().next().value);
      if (count === config.sameErrorWarning || count === config.sameErrorCritical) {
        const level = count >= config.sameErrorCritical ? 'critical' : 'warning';
        if (!alert || level === 'critical') alert = { level, reason: { code: 'sameError', tool: exec.name, count } };
      }
    }
    chains.set(exec.agent, chain);
    if (!alert) return downstream;
    const message = contextMessage(liveAlertText(alert.level, alert.reason), `${exec.name} × ${alert.reason.count} · ${alert.level}`);
    return { ...downstream, additionalContexts: [message, ...(downstream.additionalContexts ?? [])] };
  });
  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    // A new user message starts a fresh live chain (the projection keeps the history).
    if (messages.some(m => m.source?.kind === 'user')) chains.delete(agent);
    return next();
  });
}

