// Agent Flight Recorder — Client half (Web UI).
// Renders the host-computed `flightRecorder` projection in two places:
//   - `conversation.composer.dock`: a compact "Runtime Health" bar under the
//     composer that expands into the full panel (all video-spec metrics);
//   - `conversation.chat.turnTail`: a one-line health summary under every
//     completed turn.
// Styles use host theme tokens only (light and dark themes). Text goes
// through the locale service; this plugin adds a French language (falling
// back to English for the rest of the Harness UI).
window.__ModuleLoader__.load({
  id: 'dsh-agent-flight-recorder',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'flight-recorder';
    const KEY = 'flightRecorder';

    const en = {
      'title': 'Runtime Health',
      'status.healthy': 'Healthy', 'status.warning': 'Warning', 'status.critical': 'Critical', 'status.verify': 'To verify',
      'dock.label': 'Health: {status}',
      'dock.summary': '{calls} tool calls · {errors} {errorWord} · loop risk {risk} %',
      'word.error.one': 'error', 'word.error.many': 'errors',
      'dock.empty': 'No tool call yet',
      'dock.open': 'Show details', 'dock.close': 'Hide details',
      'f.totalCalls': 'Tool calls', 'f.errors': 'Errors (rate)', 'f.latency': 'Average tool time',
      'f.mostUsed': 'Most used tool', 'f.similar': 'Same tool in a row (now)', 'f.identical': 'Identical calls in a row',
      'f.shell': 'Shell commands in a row', 'f.repeatedError': 'Same error repeated', 'f.loopRisk': 'Loop risk',
      'f.reasons': 'Why', 'f.recommendation': 'Advice', 'f.window': 'Based on the last {size} tool calls (max {max})',
      'unavailable': 'not measurable',
      'reason.sameTool': '{tool} was called {count} times in a row',
      'reason.shellRepeat': 'The shell command tool {tool} ran {count} times in a row',
      'reason.sameError': 'The same {tool} error came back {count} times',
      'reason.errorRate': '{rate} % of the last {count} tool calls failed',
      'rec.none': 'Nothing to report.',
      'rec.shellRepeat': 'The AI may be going round in circles: it should read the last result and change approach.',
      'rec.sameTool': 'The AI keeps repeating {tool}: it should check the last result, then change approach or finish.',
      'rec.sameError': 'The same error keeps coming back: its cause must be fixed, or another method tried.',
      'rec.errorRate': 'Many tool calls fail: paths and arguments should be checked.',
      'turn.calls': 'Health check: {calls} tool calls, {errors} {errorWord}',
      'turn.noCalls': 'Health check: no tool used',
      'turn.run': '{tool} ×{count} in a row',
      'turn.risk': 'loop risk {risk} %',
      'report.open': 'Detailed report',
      'report.title': 'Conversation report',
      'report.close': 'Close',
      'report.scope': '{turns} turns analysed (the last 30 at most) · model(s): {models}',
      'report.tokens': 'Tokens: {input} sent to the model, {output} produced',
      'report.overview': '{calls} tool calls · {errors} {errorWord} · {suspicious} points to verify · {down} 👎',
      'report.toVerify': 'Points to verify',
      'report.none': 'Nothing suspicious detected by the simple rules.',
      'report.turn': 'Turn {turn}',
      'report.request': 'Your request',
      'report.tools': 'Tools used',
      'report.noTools': 'none',
      'report.duration': '{seconds} s',
      'report.feedback': 'Your feedback',
      'report.footer': 'The points to verify are clues found by simple rules, not certainties: always check them. The full technical report (in English) is available with the /observe command.',
      'turn.suspicious': '⚠️ {count} point(s) to verify',
      'sus.unexpectedPath': 'A file was written to an unexpected location: {path}',
      'sus.unverifiedSources': 'Sources were requested or cited, but the AI did not search anything: they may be invented',
      'sus.claimedFailureAfterSuccess': 'The AI says it could not write the file, yet a file was written',
      'sus.claimedSuccessWithoutWrite': 'The AI announces a file creation, but no file was written',
      'sus.fewerFilesThanAsked': '{asked} files were asked, only {done} written',
      'sus.failureClaimWithoutError': 'The AI talks about a failure although no tool failed',
      'hint.highContext': 'The conversation fills {pct} % of the model memory: start a new conversation soon',
      'hint.manySteps': '{steps} steps for one answer: the task may be too big, split it',
      'help': 'Loop risk is a simple estimate, not a scientific measure: it rises when the AI repeats the same tool or the same error, and drops as soon as it changes approach.',
    };
    const fr = {
      'title': "Santé de l'agent",
      'status.healthy': 'Tout va bien', 'status.warning': 'Attention', 'status.critical': 'Problème', 'status.verify': 'À vérifier',
      'dock.label': 'Santé : {status}',
      'dock.summary': "{calls} appels d'outils · {errors} {errorWord} · risque de boucle {risk} %",
      'word.error.one': 'erreur', 'word.error.many': 'erreurs',
      'dock.empty': "Aucun outil utilisé pour l'instant",
      'dock.open': 'Voir le détail', 'dock.close': 'Masquer le détail',
      'f.totalCalls': "Appels d'outils", 'f.errors': 'Erreurs (taux)', 'f.latency': "Durée moyenne d'un outil",
      'f.mostUsed': 'Outil le plus utilisé', 'f.similar': "Même outil d'affilée (en ce moment)", 'f.identical': "Appels identiques d'affilée",
      'f.shell': "Commandes shell d'affilée", 'f.repeatedError': 'Même erreur répétée', 'f.loopRisk': 'Risque de boucle',
      'f.reasons': 'Pourquoi', 'f.recommendation': 'Conseil', 'f.window': "Calculé sur les {size} derniers appels d'outils (max {max})",
      'unavailable': 'non mesurable',
      'reason.sameTool': "{tool} a été appelé {count} fois de suite",
      'reason.shellRepeat': "L'outil de commandes {tool} a été lancé {count} fois de suite",
      'reason.sameError': "La même erreur de {tool} est revenue {count} fois",
      'reason.errorRate': "{rate} % des {count} derniers appels d'outils ont échoué",
      'rec.none': 'Rien à signaler.',
      'rec.shellRepeat': "L'IA tourne peut-être en rond : elle devrait relire le dernier résultat et changer d'approche.",
      'rec.sameTool': "L'IA répète {tool} : elle devrait vérifier le dernier résultat, puis changer d'approche ou conclure.",
      'rec.sameError': "La même erreur revient : il faut en corriger la cause ou essayer une autre méthode.",
      'rec.errorRate': "Beaucoup d'outils échouent : il faut vérifier les chemins et les paramètres.",
      'turn.calls': "Bilan : {calls} appels d'outils, {errors} {errorWord}",
      'turn.noCalls': 'Bilan : aucun outil utilisé',
      'turn.run': "{tool} ×{count} d'affilée",
      'turn.risk': 'risque de boucle {risk} %',
      'report.open': 'Rapport détaillé',
      'report.title': 'Rapport de la conversation',
      'report.close': 'Fermer',
      'report.scope': '{turns} tours analysés (les 30 derniers au maximum) · modèle(s) : {models}',
      'report.tokens': "Tokens : {input} envoyés au modèle, {output} produits",
      'report.overview': "{calls} appels d'outils · {errors} {errorWord} · {suspicious} points à vérifier · {down} 👎",
      'report.toVerify': 'Points à vérifier',
      'report.none': "Rien de suspect repéré par les règles simples.",
      'report.turn': 'Tour {turn}',
      'report.request': 'Ta demande',
      'report.tools': 'Outils utilisés',
      'report.noTools': 'aucun',
      'report.duration': '{seconds} s',
      'report.feedback': 'Ton avis',
      'report.footer': "Les points à vérifier sont des indices trouvés par des règles simples, pas des certitudes : vérifie-les toujours. Le rapport technique complet (en anglais) s'obtient avec la commande /observe.",
      'turn.suspicious': '⚠️ {count} point(s) à vérifier',
      'sus.unexpectedPath': 'Un fichier a été écrit à un endroit inattendu : {path}',
      'sus.unverifiedSources': "Des sources ont été demandées ou citées, mais l'IA n'a fait aucune recherche : elles sont peut-être inventées",
      'sus.claimedFailureAfterSuccess': "L'IA dit ne pas avoir pu écrire, alors qu'un fichier a bien été écrit",
      'sus.claimedSuccessWithoutWrite': "L'IA annonce avoir créé un fichier, mais aucun fichier n'a été écrit",
      'sus.fewerFilesThanAsked': '{asked} fichiers demandés, mais seulement {done} écrit(s)',
      'sus.failureClaimWithoutError': "L'IA parle d'un échec alors qu'aucun outil n'a échoué",
      'hint.highContext': "La conversation remplit {pct} % de la mémoire du modèle : ouvre bientôt une nouvelle conversation",
      'hint.manySteps': '{steps} étapes pour une seule réponse : la tâche est peut-être trop grosse, découpe-la',
      'help': "Le risque de boucle est une estimation simple, pas une mesure scientifique : il monte quand l'IA répète le même outil ou la même erreur, et redescend dès qu'elle change d'approche.",
    };

    const COLORS = {
      healthy: 'var(--dsw-alias-state-success-primary)',
      warning: 'var(--dsw-alias-state-warn-primary)',
      critical: 'var(--dsw-alias-state-error-primary)',
      verify: 'var(--dsw-alias-state-warn-primary)',
    };
    const pct = x => Math.round((x ?? 0) * 100);
    // French: singular for 0 and 1; English: singular for 1 only.
    const errorWord = (t, n) => t(n === 1 || (n === 0 && t('word.error.one') === 'erreur') ? 'word.error.one' : 'word.error.many');

    function Dot({ status }) {
      return h('span', {
        'aria-hidden': true,
        style: { display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: COLORS[status] ?? COLORS.healthy, flex: 'none' },
      });
    }

    function reasonLine(t, r) {
      return t(`reason.${r.code}`, { tool: r.tool ?? '', count: r.count ?? '', rate: pct(r.rate) });
    }
    function recLine(t, rec) {
      return t(`rec.${rec?.code ?? 'none'}`, { tool: rec?.tool ?? '' });
    }

    function Row({ label, value }) {
      return h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums', textAlign: 'right' } }, value));
    }

    function Panel({ v, t }) {
      const na = t('unavailable');
      return h('div', {
        role: 'region', 'aria-label': t('title'),
        style: { marginTop: 6, padding: '8px 12px 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', fontSize: 12, lineHeight: 1.5 },
      },
      h(Row, { label: t('f.totalCalls'), value: String(v.totalCalls) }),
      h(Row, { label: t('f.errors'), value: v.errorRate === null ? '0' : `${v.errorCount} (${pct(v.errorRate)} %)` }),
      h(Row, { label: t('f.latency'), value: v.averageLatencyMs === null ? na : `${v.averageLatencyMs} ms` }),
      h(Row, { label: t('f.mostUsed'), value: v.mostUsedTool ? `${v.mostUsedTool.name} (${v.mostUsedTool.calls})` : na }),
      h(Row, { label: t('f.similar'), value: v.consecutiveSimilarCalls ? `${v.consecutiveSimilarCalls.tool} ×${v.consecutiveSimilarCalls.count}` : '0' }),
      h(Row, { label: t('f.identical'), value: String(v.consecutiveIdenticalCalls) }),
      h(Row, { label: t('f.shell'), value: String(v.consecutiveShellCalls) }),
      h(Row, { label: t('f.repeatedError'), value: String(v.repeatedErrorCount) }),
      h(Row, { label: t('f.loopRisk'), value: `${pct(v.loopRisk)} %` }),
      v.reasons.length > 0 && h('div', { style: { marginTop: 6 } },
        h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('f.reasons')),
        h('ul', { style: { margin: '2px 0 0', paddingLeft: 0, listStyle: 'none', color: 'var(--dsw-alias-label-primary)' } },
          v.reasons.map((r, i) => h('li', { key: i }, h('span', { style: { color: COLORS[r.level] } }, '● '), reasonLine(t, r))))),
      h('div', { style: { marginTop: 6 } },
        h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${t('f.recommendation')} : `),
        h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, recLine(t, v.recommendation))),
      h('div', { style: { marginTop: 6, color: 'var(--dsw-alias-label-tertiary)' } },
        t('f.window', { size: v.window.size, max: v.window.max }), ' · ', t('help')));
    }


    /** What the user sees for a turn: the tool health, or "to verify" when clues exist and tools look fine. */
    const shownStatus = x => (x.status === 'healthy' && (x.suspicious ?? []).length ? 'verify' : x.status);

    function susLine(t, c) {
      return t(`sus.${c.code}`, { path: c.path ?? '', asked: c.asked ?? '', done: c.done ?? '' });
    }
    function hintLine(t, c) {
      return t(`hint.${c.code}`, { pct: c.window ? Math.round((c.used / c.window) * 100) : '', steps: c.steps ?? '' });
    }
    const toolsLine = (t, tools) => {
      const entries = Object.entries(tools ?? {});
      return entries.length ? entries.map(([n, c]) => `${n} ×${c}`).join(', ') : t('report.noTools');
    };

    function ReportModal({ v, t, onClose }) {
      React.useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
      }, [onClose]);
      const turns = [...(v.turns ?? [])].reverse();
      const models = [...new Set(turns.map(x => x.model).filter(Boolean))].join(', ') || '—';
      const sum = (k) => turns.reduce((a, x) => a + (x[k] ?? 0), 0);
      const allSus = turns.flatMap(x => (x.suspicious ?? []).map(c => ({ turn: x.turn, c })));
      const down = turns.filter(x => x.feedback?.rating === 'negative').length;
      const headStatus = v.status === 'healthy' && allSus.length ? 'verify' : v.status;
      const label = { color: 'var(--dsw-alias-label-secondary)' };
      return h('div', {
        role: 'dialog', 'aria-modal': true, 'aria-label': t('report.title'),
        onMouseDown: e => { if (e.target === e.currentTarget) onClose(); },
        style: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, whiteSpace: 'normal' },
      },
      h('div', { style: { width: 760, maxWidth: '100%', maxHeight: '85vh', overflow: 'auto', borderRadius: 12, padding: '16px 20px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: 13, lineHeight: 1.55, overflowWrap: 'anywhere', boxShadow: '0 12px 40px rgba(0,0,0,0.3)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(Dot, { status: headStatus }),
          h('strong', { style: { fontSize: 15 } }, `${t('report.title')} · ${t(`status.${headStatus}`)}`),
          h('button', { type: 'button', onClick: onClose, 'aria-label': t('report.close'), style: { marginLeft: 'auto', border: 'none', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 16 } }, '✕')),
        h('div', { style: label }, t('report.scope', { turns: turns.length, models })),
        h('div', { style: label }, t('report.tokens', { input: sum('inputTokens'), output: sum('outputTokens') })),
        h('div', { style: { marginTop: 4 } }, t('report.overview', { calls: v.totalCalls, errors: v.errorCount, errorWord: errorWord(t, v.errorCount), suspicious: allSus.length, down })),
        h('h3', { style: { fontSize: 14, margin: '14px 0 4px' } }, `⚠️ ${t('report.toVerify')}`),
        allSus.length
          ? h('ul', { style: { margin: 0, paddingLeft: 18 } }, allSus.map((x, i) => h('li', { key: i }, `${t('report.turn', { turn: x.turn })} — ${susLine(t, x.c)}`)))
          : h('div', { style: label }, t('report.none')),
        turns.map(x => h('div', { key: x.turn, style: { marginTop: 12, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h(Dot, { status: shownStatus(x) }),
            h('strong', null, t('report.turn', { turn: x.turn })),
            h('span', { style: label }, [x.startedAt ? new Date(x.startedAt).toLocaleTimeString() : null, t('report.duration', { seconds: Math.round((x.durationMs ?? 0) / 1000) }), x.model, `${x.inputTokens ?? 0} / ${x.outputTokens ?? 0} tokens`].filter(Boolean).join(' · '))),
          x.preview && h('div', null, h('span', { style: label }, `${t('report.request')} : `), `« ${x.preview} »`),
          h('div', null, h('span', { style: label }, `${t('report.tools')} : `), `${toolsLine(t, x.tools)} · ${x.errors} ${errorWord(t, x.errors)}`, x.longestRun && x.longestRun.count > 1 ? ` · ${t('turn.run', { tool: x.longestRun.tool, count: x.longestRun.count })}` : '', ` · ${t('turn.risk', { risk: pct(x.loopRisk) })}`),
          x.status !== 'healthy' && h('div', null, x.reasons.map(r => reasonLine(t, r)).join(' ; '), ' — ', recLine(t, x.recommendation)),
          (x.suspicious ?? []).map((c, i) => h('div', { key: `s${i}`, style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `⚠️ ${susLine(t, c)}`)),
          (x.hints ?? []).map((c, i) => h('div', { key: `h${i}`, style: label }, `💡 ${hintLine(t, c)}`)),
          x.feedback && h('div', null, h('span', { style: label }, `${t('report.feedback')} : `), x.feedback.rating === 'negative' ? '👎' : '👍', x.feedback.note ? ` « ${x.feedback.note} »` : ''))),
        h('p', { style: { ...label, marginTop: 14, fontSize: 12 } }, t('report.footer'))));
    }

    function HealthDock({ useProjection, t }) {
      const [open, setOpen] = React.useState(false);
      const [report, setReport] = React.useState(false);
      const wrap = React.useRef(null);
      const closeReport = React.useCallback(() => setReport(false), []);
      React.useEffect(() => {
        if (!open) return undefined;
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        const onDown = e => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
        document.addEventListener('keydown', onKey);
        document.addEventListener('mousedown', onDown);
        return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown); };
      }, [open]);
      const v = typeof useProjection === 'function' ? useProjection(KEY) : undefined;
      if (!v) return null;
      const clues = (v.turns ?? []).reduce((a, x) => a + (x.suspicious ?? []).length, 0);
      const summary = v.totalCalls === 0 ? t('dock.empty') : t('dock.summary', { calls: v.totalCalls, errors: v.errorCount, errorWord: errorWord(t, v.errorCount), risk: pct(v.loopRisk) });
      return h('span', { ref: wrap, 'data-flight-recorder': 'dock', style: { position: 'relative', display: 'inline-flex', alignItems: 'center', fontSize: 12, whiteSpace: 'nowrap' } },
        h('button', {
          type: 'button', onClick: () => setOpen(o => !o), 'aria-expanded': open, 'aria-haspopup': 'dialog',
          title: `${t('title')} — ${summary}`,
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 6px', border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', font: 'inherit' },
        },
        h(Dot, { status: v.status === 'healthy' && clues > 0 ? 'verify' : v.status }),
        h('span', null, t('dock.label', { status: t(`status.${v.status === 'healthy' && clues > 0 ? 'verify' : v.status}`) })),
        clues > 0 && h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `⚠️ ${clues}`)),
        open && h('div', {
          role: 'dialog', 'aria-label': t('title'),
          style: { position: 'absolute', bottom: 'calc(100% + 6px)', right: 0, zIndex: 20, width: 340, maxWidth: '90vw', whiteSpace: 'normal', boxShadow: '0 6px 24px rgba(0,0,0,0.18)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)' },
        },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px 0', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' } },
          h(Dot, { status: v.status }), `${t('title')} · ${t(`status.${v.status}`)}`),
        h('div', { style: { padding: '2px 12px 0', color: 'var(--dsw-alias-label-secondary)' } }, summary),
        h(Panel, { v, t }),
        h('div', { style: { padding: '0 12px 12px' } },
          h('button', { type: 'button', onClick: () => { setOpen(false); setReport(true); },
            style: { marginTop: 8, width: '100%', padding: '6px 10px', borderRadius: 8, border: '1px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit' } }, `📋 ${t('report.open')}`))),
        report && h(ReportModal, { v, t, onClose: closeReport }));
    }

    function TurnHealth({ turn, useProjection, t }) {
      const v = typeof useProjection === 'function' ? useProjection(KEY) : undefined;
      const number = turn?.turn;
      const s = v?.turns?.find(x => x.turn === number);
      if (!s) return null;
      const shown = shownStatus(s);
      const parts = [s.calls ? t('turn.calls', { calls: s.calls, errors: s.errors, errorWord: errorWord(t, s.errors) }) : t('turn.noCalls')];
      if (s.longestRun && s.longestRun.count > 1) parts.push(t('turn.run', { tool: s.longestRun.tool, count: s.longestRun.count }));
      parts.push(t('turn.risk', { risk: pct(s.loopRisk) }));
      const sus = s.suspicious ?? [];
      return h('div', { 'data-flight-recorder': 'turn', style: { margin: '4px 0', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' } },
          h(Dot, { status: shown }),
          h('span', { style: { color: 'var(--dsw-alias-label-primary)', whiteSpace: 'nowrap' } }, t(`status.${shown}`)),
          h('span', null, `· ${parts.join(' · ')}`)),
        s.status !== 'healthy' && h('div', { style: { paddingLeft: 14 } },
          s.reasons.map(r => reasonLine(t, r)).join(' ; '), ' — ', recLine(t, s.recommendation)),
        sus.length > 0 && h('div', { style: { paddingLeft: 14, color: 'var(--dsw-alias-state-warn-primary)' } },
          h('div', null, t('turn.suspicious', { count: sus.length })),
          h('ul', { style: { margin: '2px 0 0', paddingLeft: 16 } }, sus.map((c, i) => h('li', { key: i }, susLine(t, c))))));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // French is not shipped by the Harness: add it (other plugins fall back to English).
        ctx.effect(() => {
          try { return ctx.locale.addLanguage({ id: 'fr', label: 'Français', fallback: 'en' }); } catch { return () => {}; }
        }, 'flight-recorder: french language');
        ctx.effect(() => ctx.locale.register(NS, { zh: en, en }), 'flight-recorder: dictionaries');
        ctx.effect(() => {
          try { return ctx.locale.register(NS, 'fr', fr); } catch { return () => {}; }
        }, 'flight-recorder: french dictionary');
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'dsh-agent-flight-recorder', order: 20, locale: NS,
        }, HealthDock));
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail', id: 'dsh-agent-flight-recorder', locale: NS,
        }, TurnHealth));
      },
    };
  },
});
