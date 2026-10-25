// Loads the Host half with a fake Cordis context and checks what it registers.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
// index.js imports its libraries from the dsh installation: skip when dsh is not installed.
let dshBin;
try { dshBin = realpathSync(execFileSync('which', ['dsh']).toString().trim()); } catch { /* dsh not installed */ }
if (!dshBin) { console.log('skipped: dsh CLI not found on PATH'); process.exit(0); }
process.argv[1] = dshBin;
const mod = await import('../index.js');
const registered = { projections: [], tools: [], listeners: {} };
const ctx = {
  sessionProjections: { register: d => { registered.projections.push(d); return () => {}; }, stateOf: () => undefined },
  tools: { register: d => { registered.tools.push(d); return () => {}; } },
  on: (name, fn) => { (registered.listeners[name] ??= []).push(fn); return () => {}; },
};
const config = mod.Config({});
mod.apply(ctx, config);
assert.equal(mod.name, 'agent-flight-recorder');
assert.equal(registered.projections[0].key, 'flightRecorder');
assert.equal(registered.tools[0].name, 'runtime_health');
for (const ev of ['agent/created', 'agent/status', 'tools/post-execute', 'agent/pre-step']) assert.ok(registered.listeners[ev], ev);
// The view must keep its reference for an unchanged state (no useless UI publications).
const p = registered.projections[0];
const s0 = p.init();
assert.equal(p.wire.view(s0), p.wire.view(s0));
assert.ok(p.stateSchema.safeParse(s0).success, 'state schema accepts init state');
// Tool output with an empty session.
const out = await registered.tools[0].execute({}, { agent: { session: {} } });
const json = JSON.parse(out);
assert.equal(json.status, 'healthy');
assert.deepEqual(json.unavailable, ['averageLatencyMs']);
// Live alert: same tool 4 times with different arguments -> warning context.
const post = registered.listeners['tools/post-execute'][0];
const agent = {};
let last;
for (let i = 1; i <= 4; i++) last = await post({ agent, name: 'bash', arguments: { command: 'echo ping', description: `call ${i}` } }, { isError: false, content: [] }, async () => ({ kind: 'accept' }));
assert.equal(last.additionalContexts?.length, 1, 'warning at 4');
assert.match(last.additionalContexts[0].content[0].text, /warning: the shell tool bash was called 4 consecutive times/);
console.log('load test ok:', JSON.stringify(Object.keys(json)));
