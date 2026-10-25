// Replays synthetic session events through the pure fold and checks counts,
// rules, loopRisk, texts and determinism. No dsh installation needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initState, applyEvent, report, evaluate, turnSummaryText, liveAlertText, DEFAULTS } from '../lib/health.js';

let seq = 0;
let clock = 1000;
const ev = (type, data = {}) => ({ seq: ++seq, type, time: (clock += 10), data });

/** One tool call and its result, as the durable session log records them. */
function call(name, args, { error = false, text = 'ok' } = {}) {
  const callId = `c${++seq}`;
  return [
    ev('tool/call', { callId, name, arguments: JSON.stringify(args), turn: 1 }),
    ev('tool/result', { message: { toolCallId: callId, isError: error, content: [{ type: 'text', text }] } }),
  ];
}
const replay = events => events.reduce((state, e) => applyEvent(state, e, DEFAULTS), initState());
const turn = calls => [ev('turn/start', { turn: 1 }), ...calls.flat(), ev('turn/end', { turn: 1, reason: { kind: 'done' } })];

test('empty session is healthy', () => {
  const r = report(initState(), DEFAULTS);
  assert.equal(r.status, 'healthy');
  assert.equal(r.totalCalls, 0);
  assert.equal(r.loopRisk, 0);
  assert.deepEqual(r.unavailable, ['averageLatencyMs']);
});

test('counts successes and errors', () => {
  const state = replay(turn([call('read', { p: 1 }), call('read', { p: 2 }, { error: true, text: 'no such file' })]));
  const r = report(state, DEFAULTS);
  assert.equal(r.totalCalls, 2);
  assert.equal(r.successCount, 1);
  assert.equal(r.errorCount, 1);
  assert.equal(state.turns.length, 1);
});

test('same tool with different arguments raises a warning at 4 and critical at 6', () => {
  const calls = n => Array.from({ length: n }, (_, i) => call('grep', { pattern: `p${i}` }));
  assert.equal(report(replay(turn(calls(3))), DEFAULTS).status, 'healthy');
  assert.equal(report(replay(turn(calls(4))), DEFAULTS).status, 'warning');
  assert.equal(report(replay(turn(calls(6))), DEFAULTS).status, 'critical');
});

test('the same error repeated is flagged even when numbers differ', () => {
  const calls = [call('bash', { c: 'a' }, { error: true, text: 'line 12 failed' }), call('bash', { c: 'b' }, { error: true, text: 'line 99 failed' })];
  const r = report(replay(turn(calls)), DEFAULTS);
  assert.notEqual(r.status, 'healthy');
  assert.ok(r.reasons.some(x => x.code === 'sameError'));
});

test('loopRisk stays within 0..1 and drops when the agent changes approach', () => {
  const loop = Array.from({ length: 6 }, (_, i) => call('grep', { i }));
  const high = report(replay(turn(loop)), DEFAULTS).loopRisk;
  const recovered = report(replay(turn([...loop, call('read', {})])), DEFAULTS).loopRisk;
  assert.ok(high > 0 && high <= 1);
  assert.ok(recovered < high);
});

test('replay is deterministic', () => {
  const events = turn([call('read', {}), call('read', {}, { error: true, text: 'boom' })]);
  assert.deepEqual(report(replay(events), DEFAULTS), report(replay(events), DEFAULTS));
});

test('texts for the model are English and compact', () => {
  assert.match(liveAlertText('warning', { code: 'sameTool', tool: 'grep', count: 4 }), /grep was called 4 consecutive times/);
  const state = replay(turn([call('read', {})]));
  assert.match(turnSummaryText(state.turns.at(-1)), /\S/);
});

test('a write that the assistant claims failed is reported as suspicious', () => {
  const events = [
    ev('turn/start', { turn: 1 }),
    ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'create notes.md' }] }),
    ...call('write', { file_path: '/tmp/notes.md' }),
    ev('assistant/message', { message: { content: [{ type: 'text', text: "I couldn't create the file." }] }, usage: {} }),
    ev('turn/end', { turn: 1, reason: { kind: 'done' } }),
  ];
  const codes = replay(events).turns[0].suspicious.map(c => c.code);
  assert.ok(codes.includes('claimedFailureAfterSuccess'), codes.join(','));
});

test('evaluate ignores unknown thresholds gracefully', () => {
  assert.equal(evaluate(initState(), DEFAULTS).status, 'healthy');
});
