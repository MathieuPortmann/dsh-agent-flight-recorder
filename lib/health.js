// Pure runtime-health computations for the Agent Flight Recorder.
// No I/O, no clocks, no randomness: every function is deterministic, so the
// session projection can replay the durable event log and always reach the same
// state. Shared by the host plugin (projection, runtime_health tool, model
// summaries) and by the unit tests.
//
// The detection rules are cheap heuristics, not verdicts: they flag patterns
// (repeated calls, repeated errors, high error rate, suspicious claims) so the
// agent and the user can double-check, nothing more.

/**
 * Default thresholds. Warning/critical pairs: the same tool called N times in a
 * row, the same error N times in the window, and the share of failed calls once
 * the window holds at least `errorRateMinCalls` calls.
 */
export const DEFAULTS = Object.freeze({
  windowSize: 100,
  sameToolWarning: 4,
  sameToolCritical: 6,
  sameErrorWarning: 2,
  sameErrorCritical: 3,
  errorRateWarning: 0.2,
  errorRateCritical: 0.3,
  errorRateMinCalls: 10,
  shellTools: ['bash', 'pwsh'],
  maxTurns: 30,
  maxErrorKeys: 50,
  writeTools: ['write', 'edit', 'str_replace_editor'],
  // Tools that retrieve sources (a reply citing sources needs at least one of them).
  webTools: ['web_search', 'web_fetch', 'web_read', 'wos_search', 'doi_verify'],
  sourceToolPrefixes: ['openalex_', 'zotero_', 'logseq_', 'mcp__notes__'],
  highContextRatio: 0.7,
  manySteps: 15,
});

export const STATE_VERSION = 3;
const LEVELS = ['healthy', 'warning', 'critical'];

// ---------------------------------------------------------------------------
// Small helpers

/** A tool that retrieves sources: web, bibliography databases, Zotero, Logseq. */
export const isSourceTool = (name, config = DEFAULTS) =>
  (config.webTools ?? []).includes(name) || (config.sourceToolPrefixes ?? []).some(p => String(name).startsWith(p));

/** Key-order independent JSON, so `{a,b}` and `{b,a}` compare equal. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 32-bit FNV-1a hash as hex: deterministic, dependency-free, good enough to compare arguments. */
export function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n');
}

/** "Same error" key: tool + error text with numbers and whitespace normalized. */
export function errorKey(tool, text) {
  const norm = String(text).slice(0, 160).replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
  return `${tool}::${hash(norm)}`;
}

function argsHash(rawArguments) {
  let parsed = rawArguments;
  if (typeof rawArguments === 'string') {
    try { parsed = JSON.parse(rawArguments); } catch { /* compare the literal text */ }
  }
  return hash(canonical(parsed));
}

const clamp01 = x => Math.max(0, Math.min(1, x));
const round2 = x => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------
// Projection fold (state is plain JSON, bounded)

const TEXT_CAP = 8000;
const keepTail = (text, cap = TEXT_CAP) => (text.length > cap ? text.slice(text.length - cap) : text);

function parseArgs(raw) {
  if (typeof raw !== 'string') return raw && typeof raw === 'object' ? raw : {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

/** Fresh per-turn scratch data; dropped at turn/end once the summary is computed. */
function newWork(event, turn) {
  return {
    turn, startedAt: event.time, steps: 0, preview: null, userText: '', assistantText: '',
    model: null, inTok: 0, outTok: 0, maxReqIn: 0, tools: {}, toolErrors: 0, exitFails: 0,
    writesOk: 0, creates: 0, webCalls: 0, paths: [], assistantIds: [],
  };
}

export function initState(header) {
  return {
    version: STATE_VERSION,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    total: 0, ok: 0, err: 0,
    latencySum: 0, latencyCount: 0,
    byTool: {},          // name -> { calls, errors }
    pending: {},         // callId -> { n, t, at, a, p (write path) }
    window: [],          // last N settled calls: { n, a, s: 'ok'|'err', e, ms, t }
    turn: null,          // current turn number
    turnStart: null,     // { total, err } snapshot at turn/start
    work: null,          // per-turn scratch (see newWork)
    contextWindow: null, // latest request/context window
    turns: [],           // last maxTurns per-turn summaries (report rows)
  };
}

/**
 * Pure transition: previous state + one committed session event -> next state.
 * Returns the same reference for events it does not care about.
 */
export function applyEvent(state, event, config = DEFAULTS) {
  const d = event.data ?? {};
  const w = state.work;
  switch (event.type) {
    case 'turn/start':
      return { ...state, turn: d.turn ?? null, turnStart: { total: state.total, err: state.err }, work: newWork(event, d.turn ?? null) };
    case 'step/start':
      return w ? { ...state, work: { ...w, steps: w.steps + 1 } } : state;
    case 'request/context':
      return typeof d.contextWindow === 'number' && d.contextWindow !== state.contextWindow ? { ...state, contextWindow: d.contextWindow } : state;
    case 'user/message': {
      // A search run by the host itself (automatic web search toggle) counts as a web search.
      if (w && d.source?.kind === 'web-toggle' && String(d.source?.summary ?? '').startsWith('automatic web search')) {
        return { ...state, work: { ...w, webCalls: w.webCalls + 1 } };
      }
      if (!w || d.source?.kind !== 'user') return state;
      const text = textOf(d.content);
      return { ...state, work: { ...w, preview: w.preview ?? text.slice(0, 160), userText: keepTail(`${w.userText}\n${text}`, 2000) } };
    }
    case 'assistant/message': {
      if (!w) return state;
      const m = d.message ?? {};
      const text = textOf((m.content ?? []).filter(c => c?.type === 'text'));
      const u = d.usage ?? {};
      const model = m.source?.model ? `${m.source.provider ?? '?'}/${m.source.model}` : w.model;
      const ids = m.id ? [...w.assistantIds, m.id].slice(-20) : w.assistantIds;
      return { ...state, work: { ...w, model, assistantIds: ids,
        assistantText: text ? keepTail(`${w.assistantText}\n${text}`) : w.assistantText,
        inTok: w.inTok + (u.inputTokens ?? 0), outTok: w.outTok + (u.outputTokens ?? 0),
        maxReqIn: Math.max(w.maxReqIn, u.inputTokens ?? 0) } };
    }
    case 'tool/call': {
      if (!d.callId) return state;
      const name = String(d.name ?? 'unknown');
      const args = parseArgs(d.arguments);
      const path = config.writeTools.includes(name) ? String(args.file_path ?? args.path ?? '') : null;
      const next = {
        ...state,
        pending: { ...state.pending, [d.callId]: { n: name, t: d.turn ?? state.turn, at: event.time, a: argsHash(d.arguments), p: path } },
      };
      if (w) {
        next.work = { ...w, tools: { ...w.tools, [name]: (w.tools[name] ?? 0) + 1 }, webCalls: w.webCalls + (isSourceTool(name, config) ? 1 : 0) };
      }
      return next;
    }
    case 'tool/result': {
      const m = d.message ?? {};
      const callId = m.toolCallId ?? m.source?.callId;
      const call = callId ? state.pending[callId] : undefined;
      if (!call) return state;
      const pending = { ...state.pending };
      delete pending[callId];
      const isError = m.isError === true;
      const ms = Math.max(0, event.time - call.at);
      const resultText = textOf(m.content);
      const entry = { n: call.n, a: call.a, s: isError ? 'err' : 'ok', e: isError ? errorKey(call.n, resultText) : null, ms, t: call.t };
      const window = [...state.window, entry];
      if (window.length > config.windowSize) window.splice(0, window.length - config.windowSize);
      const tool = state.byTool[call.n] ?? { calls: 0, errors: 0 };
      const next = {
        ...state,
        total: state.total + 1,
        ok: state.ok + (isError ? 0 : 1),
        err: state.err + (isError ? 1 : 0),
        latencySum: state.latencySum + ms,
        latencyCount: state.latencyCount + 1,
        byTool: { ...state.byTool, [call.n]: { calls: tool.calls + 1, errors: tool.errors + (isError ? 1 : 0) } },
        pending,
        window,
      };
      if (w) {
        // A failed shell command is not flagged isError by the host: its output just ends
        // with "[exit code: N]". Any N other than 0 therefore counts as a failure here.
        const exitFail = !isError && /\[exit code: (?!0\])-?\d+\]/.test(resultText);
        const work = { ...w, toolErrors: w.toolErrors + (isError ? 1 : 0), exitFails: (w.exitFails ?? 0) + (exitFail ? 1 : 0) };
        if (call.p !== null && !isError) {
          const written = /<path>([^<]+)<\/path>/.exec(resultText)?.[1] ?? call.p;
          work.writesOk = w.writesOk + 1;
          work.creates = w.creates + (d.meta?.operation === 'create' ? 1 : 0);
          work.paths = [...w.paths, { asked: call.p, written }].slice(-20);
        }
        next.work = work;
      }
      return next;
    }
    case 'turn/end': {
      const turn = d.turn ?? state.turn;
      const start = state.turnStart ?? { total: 0, err: 0 };
      const health = evaluate(state, config);
      const turnCalls = state.window.filter(x => x.t === turn);
      const work = w ?? newWork(event, turn);
      const summary = {
        turn,
        calls: state.total - start.total,
        errors: state.err - start.err,
        longestRun: longestRun(turnCalls),
        status: health.status,
        loopRisk: health.loopRisk,
        reasons: health.reasons,
        recommendation: health.recommendation,
        ended: d.reason?.kind ?? 'unknown',
        // Report fields (step 3): what happened in this turn, for a non-expert.
        preview: work.preview,
        startedAt: work.startedAt,
        durationMs: Math.max(0, event.time - work.startedAt),
        steps: work.steps,
        model: work.model,
        inputTokens: work.inTok,
        outputTokens: work.outTok,
        maxRequestInput: work.maxReqIn,
        contextWindow: state.contextWindow,
        tools: work.tools,
        suspicious: suspiciousClaims(work, state.cwd),
        hints: optimizationHints(work, state.contextWindow, config),
        assistantIds: work.assistantIds,
        feedback: null,
      };
      const turns = [...state.turns.filter(s => s.turn !== turn), summary];
      if (turns.length > config.maxTurns) turns.splice(0, turns.length - config.maxTurns);
      // Calls left without a result at turn end will never settle: drop them.
      return { ...state, turns, turnStart: null, pending: {}, work: null };
    }
    case 'feedback/message-put':
    case 'feedback/message-delete': {
      const messageId = event.type === 'feedback/message-put' ? d.item?.messageId : d.messageId;
      const idx = state.turns.findIndex(s => s.assistantIds.includes(messageId));
      if (idx < 0) return state;
      const feedback = event.type === 'feedback/message-put' ? { rating: d.item.rating ?? null, note: d.item.note ?? null, category: d.item.category ?? null } : null;
      const turns = state.turns.slice();
      turns[idx] = { ...turns[idx], feedback };
      return { ...state, turns };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Suspicious claims: cheap deterministic hints, NOT verdicts (no model judge).

// The patterns are bilingual (French and English) on purpose: they match what the
// assistant or the user actually wrote, whatever the UI language. Flags `iu` give
// Unicode-aware case folding and count astral characters as one in `{0,60}`.

/** The user asked for sources, references or citations. */
const SOURCES_ASKED = /\b(sources?|r[ée]f[ée]rences?|cite[rsz]?|citations?|bibliograph)/iu;
/** The assistant presented a "Sources" heading, label or list. */
const SOURCES_GIVEN = /(^|\n)[#*\s\p{Emoji}]*sources?\b|\bsources?\s+(historiques|utilis[ée]es|consult[ée]es)|\bsources?\s*:/iu;
/** "I could not create/write/save ...". */
const FAILURE_VERB = /(je n'ai pas pu|je n’ai pas pu|n'ai pas r[ée]ussi|impossible de|i could not|i couldn't|i was unable|unable to)[^.\n]{0,60}(cr[ée]|[ée]cri|modifi|creat|writ|sav|enregistr)/iu;
/** "I created ...", "... has been created". */
const SUCCESS_VERB = /(cr[ée]{2} avec succ[èe]s|a [ée]t[ée] cr[ée]{2}|ont [ée]t[ée] cr[ée]{2}s|j'ai cr[ée]{2}|created successfully|has been created|i (have )?created)/iu;
/** "create three files": a count (digits or spelled out) followed by a files noun. */
const FILES_ASKED = /\b([0-9]{1,2}|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|two|three|four|five|seven|eight|nine|ten)\s+(nouveaux?\s+|new\s+)?(fichiers?|files?|documents?)\b/iu;
/** "the previous command failed". */
const FAILED_CLAIM = /(le pr[ée]c[ée]dent a [ée]chou[ée]|a [ée]chou[ée]|previous (command|call|attempt) failed|that failed)/iu;

const NUMBER_WORDS = {
  deux: 2, two: 2, trois: 3, three: 3, quatre: 4, four: 4, cinq: 5, five: 5, six: 6,
  sept: 7, seven: 7, huit: 8, eight: 8, neuf: 9, nine: 9, dix: 10, ten: 10,
};

/** Non-overlapping occurrences of `needle` in `text`. */
function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) count++;
  return count;
}

/** Number value of a field, 0 when it is not a number. */
const num = v => (typeof v === 'number' ? v : 0);

/** String value of a field: '' for null/undefined, JSON text for objects. */
const str = v => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : (typeof v === 'object' ? JSON.stringify(v) : String(v));
};

/**
 * Suspicious claims of a turn, from its scratch data (`work`) and the session cwd.
 * Cheap deterministic hints that the model or the user should double-check, never
 * verdicts. Each entry is `{ code, ...details }`; codes map to `suspiciousText`.
 */
export function suspiciousClaims(work, cwd) {
  const out = [];
  const assistant = str(work.assistantText);
  const user = str(work.userText);
  for (const p of work.paths ?? []) {
    const asked = str(p.asked);
    const written = str(p.written);
    // A relative "home/..." path ends up under the cwd, and a cwd repeated twice in
    // the written path means the absolute path was joined to the cwd by mistake.
    const relativeHome = asked.startsWith('home/');
    const nested = !!cwd && (written.startsWith(`${cwd}/home/`) || countOccurrences(written, cwd) >= 2);
    if (relativeHome || nested) out.push({ code: 'unexpectedPath', path: written });
  }
  const writes = num(work.writesOk);
  if ((SOURCES_ASKED.test(user) || SOURCES_GIVEN.test(assistant)) && num(work.webCalls) === 0) {
    out.push({ code: 'unverifiedSources' });
  }
  if (writes > 0 && FAILURE_VERB.test(assistant)) out.push({ code: 'claimedFailureAfterSuccess' });
  if (writes === 0 && SUCCESS_VERB.test(assistant)) out.push({ code: 'claimedSuccessWithoutWrite' });
  const m = FILES_ASKED.exec(user);
  if (m) {
    const asked = /^[0-9]+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
    if (asked && writes < asked) out.push({ code: 'fewerFilesThanAsked', asked, done: writes });
  }
  const toolCalls = Object.values(work.tools ?? {}).reduce((sum, n) => sum + num(n), 0);
  // "That failed" is only suspicious when no tool reported an error or a non-zero exit code.
  if (toolCalls > 0 && num(work.toolErrors) === 0 && num(work.exitFails) === 0 && FAILED_CLAIM.test(assistant)) {
    out.push({ code: 'failureClaimWithoutError' });
  }
  return out;
}

/**
 * Optimization hints of a turn: the largest request used most of the context
 * window (`highContext`), or the turn took many steps (`manySteps`).
 */
export function optimizationHints(work, contextWindow, config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config };
  const out = [];
  if (contextWindow && num(work.maxReqIn) > c.highContextRatio * contextWindow) {
    out.push({ code: 'highContext', used: work.maxReqIn, window: contextWindow });
  }
  if (num(work.steps) >= c.manySteps) out.push({ code: 'manySteps', steps: work.steps });
  return out;
}

// ---------------------------------------------------------------------------
// Rules over the bounded window

function trailingRun(window, key) {
  if (!window.length) return { value: null, count: 0 };
  const last = key(window.at(-1));
  let count = 0;
  for (let i = window.length - 1; i >= 0 && key(window[i]) === last; i--) count++;
  return { value: last, count };
}

function maxRun(window, key) {
  let best = { value: null, count: 0 }, run = 0, prev;
  for (const w of window) {
    const k = key(w);
    run = k === prev ? run + 1 : 1;
    prev = k;
    if (run > best.count) best = { value: k, count: run };
  }
  return best;
}

function longestRun(calls) {
  const r = maxRun(calls, w => w.n);
  return r.count ? { tool: r.value, count: r.count } : null;
}

const SEPARATOR = '\u001f';

/**
 * Health of the recent window of settled calls.
 *
 * Rules (thresholds in `config`): the same tool in a row, the same error key
 * repeated in the window, and a high share of failed calls once the window holds
 * enough calls. Each triggered rule adds a reason with its own level; the status
 * is the highest level reached.
 *
 * `loopRisk` (0..1) is a deterministic heuristic, not a measurement:
 * 0.5 * runScore + 0.3 * repeatScore + 0.2 * rateScore, where each score is the
 * current value scaled linearly to 1 at the critical threshold (runs and repeats
 * start counting from the second occurrence, hence the "- 1"). The error-rate
 * score is 0 until the window is large enough to make a rate meaningful.
 */
export function evaluate(state, config = DEFAULTS) {
  const c = { ...DEFAULTS, ...config };
  const w = state.window ?? [];
  const reasons = [];
  let level = 0;
  const raise = (lvl, reason) => {
    level = Math.max(level, lvl);
    reasons.push({ ...reason, level: LEVELS[lvl] });
  };
  const isShell = name => c.shellTools.includes(name);
  // Shell calls only count as a repeat when the command itself repeats (same
  // arguments): several different read-only commands in a row are fact-gathering,
  // not a loop. Other tools repeat on the name alone.
  const runKey = x => (isShell(str(x.n)) ? `${str(x.n)}${SEPARATOR}${str(x.a)}` : str(x.n));
  const toolOf = key => (key === null ? null : key.split(SEPARATOR)[0]);

  const run = maxRun(w, runKey);
  if (run.count >= c.sameToolWarning) {
    const tool = toolOf(run.value);
    raise(run.count >= c.sameToolCritical ? 2 : 1, { code: isShell(tool) ? 'shellRepeat' : 'sameTool', tool, count: run.count });
  }

  // Most frequent error key; ties keep the first one seen.
  const errorCounts = new Map();
  for (const x of w) if (typeof x.e === 'string' && x.e) errorCounts.set(x.e, (errorCounts.get(x.e) ?? 0) + 1);
  let topError = null, repeated = 0;
  for (const [key, count] of errorCounts) {
    if (count > repeated) { topError = key; repeated = count; }
  }
  if (repeated >= c.sameErrorWarning) {
    raise(repeated >= c.sameErrorCritical ? 2 : 1, { code: 'sameError', tool: topError.split('::')[0], count: repeated });
  }

  const errors = w.filter(x => x.s === 'err').length;
  const rate = w.length ? errors / w.length : 0;
  if (w.length >= c.errorRateMinCalls && rate > c.errorRateWarning) {
    raise(rate > c.errorRateCritical ? 2 : 1, { code: 'errorRate', rate: round2(rate), count: w.length });
  }

  const current = trailingRun(w, runKey);
  const identical = trailingRun(w, x => `${str(x.n)}:${str(x.a)}`);
  const shell = trailingRun(w, x => (isShell(str(x.n)) ? 'shell' : `other:${str(x.n)}`));
  const runScore = clamp01((current.count - 1) / (c.sameToolCritical - 1));
  const repeatScore = clamp01((repeated - 1) / (c.sameErrorCritical - 1));
  const rateScore = w.length >= c.errorRateMinCalls ? clamp01(rate / c.errorRateCritical) : 0;

  return {
    status: LEVELS[level],
    loopRisk: round2(0.5 * runScore + 0.3 * repeatScore + 0.2 * rateScore),
    reasons,
    recommendation: recommend(reasons),
    consecutiveSimilarCalls: current.count > 0 ? { tool: toolOf(current.value), count: current.count } : null,
    consecutiveIdenticalCalls: identical.count,
    consecutiveShellCalls: shell.value === 'shell' ? shell.count : 0,
    repeatedErrorCount: repeated,
    windowErrorRate: w.length ? round2(rate) : null,
  };
}

/** Recommendation code for the most severe reason (the first one on ties). */
function recommend(reasons) {
  const rank = r => LEVELS.indexOf(r.level);
  const top = [...reasons].sort((a, b) => rank(b) - rank(a))[0];
  if (!top) return { code: 'none' };
  // Reasons without a tool (errorRate) give a recommendation without a "tool" key.
  return top.tool === undefined || top.tool === null ? { code: top.code } : { code: top.code, tool: top.tool };
}

// ---------------------------------------------------------------------------
// Views

/** Full health report: the `runtime_health` tool result and the client view. */
export function report(state, config = DEFAULTS) {
  const h = evaluate(state, config);
  const byTool = Object.entries(state.byTool).map(([name, v]) => ({ name, calls: v.calls, errors: v.errors })).sort((a, b) => b.calls - a.calls);
  return {
    status: h.status,
    totalCalls: state.total,
    successCount: state.ok,
    errorCount: state.err,
    errorRate: state.total ? round2(state.err / state.total) : null,
    averageLatencyMs: state.latencyCount ? Math.round(state.latencySum / state.latencyCount) : null,
    mostUsedTool: byTool[0] ? { name: byTool[0].name, calls: byTool[0].calls } : null,
    callsByTool: byTool.slice(0, 12),
    consecutiveSimilarCalls: h.consecutiveSimilarCalls,
    consecutiveIdenticalCalls: h.consecutiveIdenticalCalls,
    consecutiveShellCalls: h.consecutiveShellCalls,
    repeatedErrorCount: h.repeatedErrorCount,
    loopRisk: h.loopRisk,
    reasons: h.reasons,
    recommendation: h.recommendation,
    window: { size: state.window.length, max: config.windowSize, errorRate: h.windowErrorRate },
    unavailable: state.latencyCount ? [] : ['averageLatencyMs'],
    turns: state.turns,
  };
}

// ---------------------------------------------------------------------------
// English texts for the model (the UI translates the codes itself)

const TEXTS = Object.freeze({
  reason: {
    sameTool: '{tool} was called {count} consecutive times',
    shellRepeat: 'the shell tool {tool} was called {count} consecutive times',
    sameError: 'the same {tool} error occurred {count} times',
    errorRate: '{percent} % of the last {count} tool calls failed',
  },
  recommendation: {
    shellRepeat: 'Pause and reassess before another shell call: read the last result and change approach if it is not progressing.',
    sameTool: 'Stop repeating {tool}: check the last result, then change approach or finish the task.',
    sameError: 'The same error keeps coming back: read it, fix its cause or try another method instead of retrying.',
    errorRate: 'Many tool calls fail: verify paths and arguments before the next call.',
    none: 'No action needed.',
  },
  suspicious: {
    unexpectedPath: 'a file was written to an unexpected location ({path}); use an absolute path starting with /',
    unverifiedSources: 'sources were requested or cited but no source tool (web, OpenAlex, Zotero, Logseq) was used; never cite sources you did not retrieve',
    claimedFailureAfterSuccess: 'you said a file operation failed although a write tool succeeded; check the tool results',
    claimedSuccessWithoutWrite: 'you announced a file creation but no write tool succeeded',
    fewerFilesThanAsked: 'the user asked for {asked} files but only {done} written',
    failureClaimWithoutError: 'you said something failed although no tool returned an error',
  },
});

const template = (table, code) => (Object.hasOwn(table, code) ? table[code] : undefined);

/** Fill `{name}` placeholders, one variable after the other, every occurrence. */
const fill = (text, vars) => Object.entries(vars).reduce((acc, [k, v]) => acc.split(`{${k}}`).join(v), text);

export const reasonText = r => {
  const code = str(r?.code);
  const text = template(TEXTS.reason, code);
  if (text === undefined) return code;
  return fill(text, { tool: str(r.tool), count: str(r.count), percent: String(Math.round(num(r.rate) * 100)) });
};

export const recommendationText = rec => {
  const code = str(rec?.code);
  const text = template(TEXTS.recommendation, code) ?? TEXTS.recommendation.none;
  return fill(text, { tool: str(rec?.tool) });
};

export const suspiciousText = c => {
  const code = str(c?.code);
  const text = template(TEXTS.suspicious, code);
  if (text === undefined) return code;
  return fill(text, { path: str(c.path), asked: str(c.asked), done: str(c.done) });
};

/**
 * Two-decimal text of a number. Exact ties (0.125, 0.375, ...) round to the even
 * digit, so the text is stable across runtimes (`toFixed` rounds ties up).
 */
function fixed2(x) {
  const abs = Math.abs(x);
  const isTie = Number.isInteger(abs * 8) && (abs * 8) % 2 === 1;
  if (!isTie) return x.toFixed(2);
  const down = Math.floor(abs * 100);
  const even = down % 2 === 0 ? down : down + 1;
  return `${x < 0 ? '-' : ''}${(even / 100).toFixed(2)}`;
}

/** Compact per-turn line injected into the model context (about 20-50 tokens). */
export function turnSummaryText(summary) {
  if (!summary) return null;
  const calls = num(summary.calls);
  const parts = [`[Runtime health after turn ${str(summary.turn)}] status: ${str(summary.status)}`];
  parts.push(calls !== 0
    ? `tool calls this turn: ${str(summary.calls)} (${str(summary.errors)} ${num(summary.errors) === 1 ? 'error' : 'errors'})`
    : 'no tool calls this turn');
  if (summary.longestRun && num(summary.longestRun.count) > 1) {
    parts.push(`longest same-tool run: ${str(summary.longestRun.tool)} x${str(summary.longestRun.count)}`);
  }
  parts.push(`loop risk ${fixed2(num(summary.loopRisk))}`);
  let text = `${parts.join(' | ')}.`;
  if (summary.status !== 'healthy') {
    text += ` Reasons: ${(summary.reasons ?? []).map(reasonText).join('; ')}. ${recommendationText(summary.recommendation)}`;
  }
  const suspicious = summary.suspicious ?? [];
  if (suspicious.length) text += ` To verify: ${suspicious.map(suspiciousText).join('; ')}.`;
  return text;
}

/** Text of a live (mid-turn) alert for one reason. */
export const liveAlertText = (level, reason) =>
  `${level === 'critical' ? 'Runtime health CRITICAL' : 'Runtime health warning'}: ${reasonText(reason)}. ${recommendationText({ code: reason?.code, tool: reason?.tool })}`;
