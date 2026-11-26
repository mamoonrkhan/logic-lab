// UI for the CDCL visualizer: replays the frames recorded by cdcl.js.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_VARS = 80;
  const MAX_CLAUSES = 400;

  const state = { formula: null, trace: null, i: 0, timer: null, numInput: 0 };

  // ------------------------------------------------------------------ formatting

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const varName = (v) => esc(state.formula.names[v] || `x${v}`);
  const litText = (l) => (l < 0 ? '¬' : '') + varName(Math.abs(l));

  function valueMap(frame) {
    const m = new Map();
    for (const t of frame.trail) m.set(Math.abs(t.lit), t.lit > 0);
    return m;
  }

  function litClass(l, vals) {
    const v = Math.abs(l);
    if (!vals || !vals.has(v)) return 'u';
    return vals.get(v) === (l > 0) ? 't' : 'f';
  }

  const lit = (l, vals) => `<span class="lit ${litClass(l, vals)}">${litText(l)}</span>`;

  function clauseHtml(lits, vals) {
    if (!lits.length) return '<span class="empty-clause">□ (empty clause)</span>';
    return `<span class="clause">(${lits.map((l) => lit(l, vals)).join('<span class="or">∨</span>')})</span>`;
  }

  function label(k) {
    return k < state.numInput ? `C${k + 1}` : `L${k - state.numInput + 1}`;
  }

  const tag = (k) => `<span class="ctag ${k >= state.numInput ? 'learned' : ''}">${label(k)}</span>`;

  // ------------------------------------------------------------------ narrative

  function describe(f, vals) {
    const C = state.trace.clauses;
    switch (f.type) {
      case 'start':
        return `<h3>Start</h3><p>Nothing is assigned yet. ${state.formula.numVars} variables, ${state.numInput} clauses.
          The solver first propagates any unit clauses, then begins making decisions.</p>`;
      case 'decide':
        return `<h3>Decision at level ${f.level}</h3><p>No clause forces anything, so the solver guesses ${lit(f.lit, vals)}.
          The branching heuristic (VSIDS) picks the variable involved in the most recent conflicts;
          the value comes from the last time it was assigned (phase saving).</p>`;
      case 'propagate':
        if (f.asserting) {
          return `<h3>The learned clause fires</h3><p>After the backjump, every literal of ${tag(f.clauseIndex)}
            ${clauseHtml(C[f.clauseIndex].lits, vals)} except one is false, so it forces ${lit(f.lit, vals)} at level ${f.level}.
            This is the payoff of learning: the solver never makes the same mistake again.</p>`;
        }
        return `<h3>Unit propagation</h3><p>${tag(f.clauseIndex)} ${clauseHtml(C[f.clauseIndex].lits, vals)}
          has every literal false except one, so ${lit(f.lit, vals)} is forced.</p>`;
      case 'conflict':
        return `<h3 class="bad">Conflict at level ${f.level}</h3><p>Every literal of ${tag(f.conflict)}
          ${clauseHtml(C[f.conflict].lits, vals)} is false. ${f.level === 0
            ? 'This happened at level 0, where no guesses have been made.'
            : 'Some combination of decisions was wrong. Next, work out which.'}</p>`;
      case 'analyze': {
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        return `<h3>Conflict analysis</h3><p>Start from the falsified clause ${clauseHtml(f.clause, vals)}.
          It contains ${k} literals assigned at the current level ${f.level}. Resolve away the most recently assigned ones
          until exactly one is left.</p>`;
      }
      case 'resolve': {
        const s = f.steps[f.steps.length - 1];
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        return `<h3>Resolution on ${varName(s.on)}</h3><p>${varName(s.on)} was forced by ${tag(s.with)}.
          Resolving ${clauseHtml(s.before, vals)} with ${clauseHtml(C[s.with].lits, vals)} on ${varName(s.on)}
          gives ${clauseHtml(s.result, vals)}. ${k === 1 ? 'Only one current-level literal is left.' : `${k} current-level literals left.`}</p>`;
      }
      case 'learn': {
        const dropped = f.dropped.length
          ? ` ${f.dropped.map((l) => lit(l, vals)).join(', ')} ${f.dropped.length === 1 ? 'is' : 'are'} false at level 0 forever, so ${f.dropped.length === 1 ? 'it is' : 'they are'} dropped.`
          : '';
        return `<h3 class="good">Learn ${tag(f.learnedIndex)}</h3><p>${lit(f.uip, vals)} is the only literal from level ${f.level}:
          the <b>first unique implication point</b>. The solver learns ${clauseHtml(f.clause, vals)}, which the original
          formula implies because it was derived by resolution.${dropped} It will backjump to level ${f.bt}, the highest
          other level in the clause.</p>`;
      }
      case 'backjump': {
        const skipped = f.from - f.to - 1;
        return `<h3>Backjump from level ${f.from} to level ${f.to}</h3><p>${skipped > 0
          ? `This skips ${skipped} level${skipped > 1 ? 's' : ''} at once. Those decisions had nothing to do with the conflict, and plain DPLL backtracking would have explored them again.`
          : 'Undo the assignments made at the conflicting level.'}</p>`;
      }
      case 'sat': {
        const trues = Object.entries(f.model).filter(([, b]) => b).map(([v]) => `<span class="lit t">${varName(Number(v))}</span>`);
        return `<h3 class="good">Satisfiable</h3><p>Every variable is assigned and every clause has a true literal.
          True variables: ${trues.length ? trues.join(' ') : '(none)'}.</p>`;
      }
      case 'unsat':
        return `<h3 class="bad">Unsatisfiable</h3><p>${f.emptyInput ? 'The formula contains an empty clause.'
          : f.stats.learned === 0
            ? 'Unit propagation alone produced a contradiction, with no guesses involved, so no assignment can satisfy the formula.'
            : `The conflict happened at level 0, so there is no decision left to undo. The ${f.stats.learned} learned clauses were each derived by resolution, so together they form a proof that no assignment satisfies the formula.`}</p>`;
      case 'limit':
        return `<h3>Stopped</h3><p>The trace hit its step limit. Use the command-line solver for formulas this size.</p>`;
      default:
        return '';
    }
  }

  function levelOf(f, l) {
    const t = f.trail.find((x) => Math.abs(x.lit) === Math.abs(l));
    return t ? t.level : -1;
  }

  // ------------------------------------------------------------------ implication graph

  const NODE_W = 84, NODE_H = 30, COL = 104, ROW = 78, LEFT = 86, TOP = 26;

  function renderGraph(f) {
    const svg = $('graph');
    const C = state.trace.clauses;
    const nodes = new Map();
    const perLevel = [];
    for (const t of f.trail) {
      const k = (perLevel[t.level] = (perLevel[t.level] || 0) + 1) - 1;
      nodes.set(Math.abs(t.lit), { ...t, x: LEFT + k * COL + NODE_W / 2, y: TOP + t.level * ROW + NODE_H / 2 });
    }
    const showConflict = ['conflict', 'analyze', 'resolve', 'learn', 'unsat'].includes(f.type) && f.conflict !== undefined;
    let kappa = null;
    if (showConflict) {
      const k = perLevel[f.level] || 0;
      kappa = { x: LEFT + k * COL + NODE_W / 2, y: TOP + f.level * ROW + NODE_H / 2 };
    }

    const cut = new Set(f.clause && ['analyze', 'resolve', 'learn'].includes(f.type) ? f.clause.map(Math.abs) : []);
    const resolved = new Set(f.steps && ['resolve', 'learn'].includes(f.type) ? f.steps.map((s) => s.on) : []);
    const uip = f.type === 'learn' ? Math.abs(f.uip) : 0;
    const fresh = ['decide', 'propagate'].includes(f.type) ? Math.abs(f.lit) : 0;

    const levels = Math.max(f.level, 0) + 1;
    const maxCols = Math.max(1, ...perLevel.map((x) => x || 0)) + (kappa ? 1 : 0);
    const width = LEFT + maxCols * COL + 20;
    const height = TOP + levels * ROW;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);

    const parts = [`<defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead"/></marker>
      <marker id="arrow-bad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrowhead bad"/></marker>
    </defs>`];

    for (let L = 0; L < levels; L++) {
      const y = TOP + L * ROW + NODE_H / 2;
      parts.push(`<line class="lane" x1="${LEFT - 10}" x2="${width - 10}" y1="${y}" y2="${y}"/>`);
      parts.push(`<text class="lane-label" x="10" y="${y + 4}">level ${L}</text>`);
    }

    const edge = (a, b, cls, title) => {
      const sx = a.x + (b.x > a.x + 1 ? NODE_W / 2 : 0);
      const sy = a.y + (b.x > a.x + 1 ? 0 : NODE_H / 2);
      const tx = b.x - NODE_W / 2 - 2, ty = b.y;
      const dx = Math.max(30, (tx - sx) / 2);
      return `<path class="edge ${cls}" d="M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}"
        marker-end="url(#${cls === 'bad' ? 'arrow-bad' : 'arrow'})"><title>${title}</title></path>`;
    };

    for (const [v, nd] of nodes) {
      if (nd.reason < 0) continue;
      for (const l of C[nd.reason].lits) {
        const src = nodes.get(Math.abs(l));
        if (Math.abs(l) !== v && src) parts.push(edge(src, nd, '', `${label(nd.reason)}`));
      }
    }
    if (kappa) {
      for (const l of C[f.conflict].lits) {
        const src = nodes.get(Math.abs(l));
        if (src) parts.push(edge(src, kappa, 'bad', `${label(f.conflict)} is falsified`));
      }
    }

    for (const [v, nd] of nodes) {
      const cls = ['node', nd.reason < 0 ? 'decision' : 'implied', nd.lit > 0 ? 'pos' : 'neg'];
      if (cut.has(v)) cls.push('cut');
      if (resolved.has(v) && !cut.has(v)) cls.push('resolved');
      if (v === uip) cls.push('uip');
      if (v === fresh) cls.push('fresh');
      const why = nd.reason < 0 ? `decision at level ${nd.level}` : `forced by ${label(nd.reason)} at level ${nd.level}`;
      parts.push(`<g class="${cls.join(' ')}" transform="translate(${nd.x - NODE_W / 2},${nd.y - NODE_H / 2})">
        <title>${litText(nd.lit)}: ${why}</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="15"/>
        <text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}">${litText(nd.lit)}</text></g>`);
    }
    if (kappa) {
      parts.push(`<g class="node kappa" transform="translate(${kappa.x - NODE_W / 2},${kappa.y - NODE_H / 2})">
        <title>conflict: ${label(f.conflict)} is falsified</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="15"/><text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}">⊥ ${label(f.conflict)}</text></g>`);
    }
    if (!f.trail.length && !kappa) {
      parts.push(`<text class="lane-label" x="${LEFT}" y="${TOP + NODE_H / 2 + 4}">nothing assigned yet</text>`);
    }
    svg.innerHTML = parts.join('');
    if (fresh || kappa) {
      const target = kappa || nodes.get(fresh);
      const box = svg.parentElement;
      if (target && (target.x < box.scrollLeft || target.x > box.scrollLeft + box.clientWidth - 60)) {
        box.scrollLeft = Math.max(0, target.x - box.clientWidth / 2);
      }
    }
  }

  // ------------------------------------------------------------------ analysis panel

  function renderAnalysis(i) {
    // Show the derivation for the most recent conflict, until the next one replaces it.
    const frames = state.trace.frames;
    const ANALYSIS = ['conflict', 'analyze', 'resolve', 'learn', 'unsat'];
    let j = i;
    while (j >= 0 && !ANALYSIS.includes(frames[j].type)) j--;
    const f = j >= 0 ? frames[j] : null;
    const box = $('analysis');
    if (!f || f.conflict === undefined) {
      box.innerHTML = '<p class="muted">No conflict yet. When a clause is falsified, the resolution steps that build the learned clause appear here.</p>';
      return;
    }
    const C = state.trace.clauses;
    const rows = [];
    if (f.conflict !== undefined) rows.push(`<li><span class="step-k">conflict</span> ${tag(f.conflict)} ${clauseHtml(C[f.conflict].lits)}</li>`);
    for (const s of f.steps || []) {
      rows.push(`<li><span class="step-k">resolve on ${varName(s.on)}</span> with ${tag(s.with)} ${clauseHtml(C[s.with].lits)}
        <div class="arrow-row">⇒ ${clauseHtml(s.result)}</div></li>`);
    }
    if (f.type === 'learn') {
      rows.push(`<li class="learned-row"><span class="step-k">learned</span> ${tag(f.learnedIndex)} ${clauseHtml(f.clause)}
        <div class="muted small">first UIP: ${litText(f.uip)} · backjump to level ${f.bt}</div></li>`);
    }
    box.innerHTML = `<ol class="derivation">${rows.join('')}</ol>`;
  }

  // ------------------------------------------------------------------ clause list

  function renderClauses(f, vals) {
    const C = state.trace.clauses;
    const hideSat = $('hide-sat').checked;
    const focus = new Set([f.clauseIndex, f.conflict, f.with, f.learnedIndex].filter((x) => x !== undefined));
    const out = [];
    // Learned clauses first (newest first), then the input clauses.
    const order = [];
    for (let k = f.numClauses - 1; k >= state.numInput; k--) order.push(k);
    for (let k = 0; k < Math.min(state.numInput, f.numClauses); k++) order.push(k);
    for (const k of order) {
      const lits = C[k].lits;
      let free = 0, sat = false;
      for (const l of lits) {
        const c = litClass(l, vals);
        if (c === 't') sat = true;
        if (c === 'u') free++;
      }
      const status = sat ? 'sat' : free === 0 ? 'conflict' : free === 1 ? 'unit' : 'open';
      if (hideSat && sat && !focus.has(k)) continue;
      out.push(`<div class="cl ${status} ${focus.has(k) ? 'focus' : ''} ${k >= state.numInput ? 'is-learned' : ''}"
        title="${status === 'sat' ? 'satisfied' : status === 'unit' ? 'unit: forces its last literal' : status === 'conflict' ? 'falsified' : ''}">
        ${tag(k)}<span class="cl-lits">${lits.map((l) => lit(l, vals)).join('<span class="or">∨</span>')}</span></div>`);
    }
    $('clauses').innerHTML = out.join('') || '<p class="muted">All clauses satisfied.</p>';
  }

  // ------------------------------------------------------------------ main render

  function render() {
    const { frames } = state.trace;
    const f = frames[state.i];
    const vals = valueMap(f);
    $('narrative').innerHTML = describe(f, vals);
    $('narrative').className = `narrative card t-${f.type}`;
    $('counter').textContent = `step ${state.i + 1} / ${frames.length}`;
    $('scrub').max = frames.length - 1;
    $('scrub').value = state.i;
    const s = f.stats;
    $('stats').innerHTML = [
      ['level', f.level], ['assigned', `${f.trail.length} / ${state.formula.numVars}`], ['decisions', s.decisions],
      ['propagations', s.propagations], ['conflicts', s.conflicts], ['learned', s.learned],
    ].map(([k, v]) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`).join('');
    renderGraph(f);
    renderAnalysis(state.i);
    renderClauses(f, vals);
    $('play').textContent = state.timer ? '❚❚' : '▶';
    $('play').setAttribute('aria-label', state.timer ? 'Pause' : 'Play');
  }

  function go(i) {
    state.i = Math.max(0, Math.min(state.trace.frames.length - 1, i));
    if (state.i === state.trace.frames.length - 1) stop();
    render();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  function togglePlay() {
    if (state.timer) { stop(); render(); return; }
    if (state.i >= state.trace.frames.length - 1) state.i = 0;
    state.timer = setInterval(() => go(state.i + 1), 1000 / Number($('speed').value));
    render();
  }

  function nextConflict() {
    const fr = state.trace.frames;
    for (let j = state.i + 1; j < fr.length; j++) {
      if (fr[j].type === 'conflict') return go(j);
    }
    go(fr.length - 1);
  }

  // ------------------------------------------------------------------ loading formulas

  function showError(msg) {
    $('error').textContent = msg;
    $('error').hidden = !msg;
  }

  function load(formula, source) {
    if (formula.numVars > MAX_VARS || formula.clauses.length > MAX_CLAUSES) {
      showError(`This formula has ${formula.numVars} variables and ${formula.clauses.length} clauses. The visualizer is meant for small formulas (at most ${MAX_VARS} variables and ${MAX_CLAUSES} clauses). Use the command-line solver for bigger ones.`);
      return;
    }
    showError('');
    stop();
    state.formula = formula;
    state.numInput = formula.clauses.length;
    state.trace = CDCL.solveTrace(formula);
    state.i = 0;
    if (source !== undefined) $('dimacs').value = source;
    render();
  }

  function loadExample(id) {
    const ex = CDCL.EXAMPLES.find((e) => e.id === id);
    $('blurb').textContent = ex.blurb;
    $('random-controls').hidden = id !== 'random';
    if (id === 'custom') {
      $('dimacs-box').open = true;
      $('dimacs').focus();
      return;
    }
    const formula = id === 'random' ? randomFormula() : ex.make();
    load(formula, CDCL.toDimacs(formula, ex.title));
  }

  function randomFormula() {
    const n = Math.max(3, Math.min(40, Number($('rand-n').value) || 12));
    const m = Math.max(1, Math.min(300, Number($('rand-m').value) || 51));
    const seed = Math.max(1, Number($('rand-seed').value) || 1);
    return CDCL.random3Sat(n, m, seed);
  }

  // ------------------------------------------------------------------ wiring

  function init() {
    const sel = $('example');
    sel.innerHTML = CDCL.EXAMPLES.map((e) => `<option value="${e.id}">${esc(e.title)}</option>`).join('');
    sel.addEventListener('change', () => loadExample(sel.value));
    $('rand-go').addEventListener('click', () => {
      const f = randomFormula();
      load(f, CDCL.toDimacs(f, `random 3-SAT, seed ${$('rand-seed').value}`));
    });
    $('solve').addEventListener('click', () => {
      try {
        load(CDCL.parseDimacs($('dimacs').value));
      } catch (e) {
        showError(`Could not parse the formula: ${e.message}`);
      }
    });
    $('first').addEventListener('click', () => { stop(); go(0); });
    $('prev').addEventListener('click', () => { stop(); go(state.i - 1); });
    $('next').addEventListener('click', () => { stop(); go(state.i + 1); });
    $('last').addEventListener('click', () => { stop(); go(Infinity); });
    $('play').addEventListener('click', togglePlay);
    $('next-conflict').addEventListener('click', () => { stop(); nextConflict(); });
    $('scrub').addEventListener('input', (e) => { stop(); go(Number(e.target.value)); });
    $('speed').addEventListener('change', () => { if (state.timer) { stop(); togglePlay(); } });
    $('hide-sat').addEventListener('change', render);
    document.addEventListener('keydown', (e) => {
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      const keys = {
        ArrowRight: () => { stop(); go(state.i + 1); }, ArrowLeft: () => { stop(); go(state.i - 1); },
        Home: () => { stop(); go(0); }, End: () => { stop(); go(Infinity); },
        ' ': togglePlay, c: () => { stop(); nextConflict(); },
      };
      if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
    });
    // Deep links: #example=php&step=40
    const params = new URLSearchParams(location.hash.slice(1));
    const wanted = CDCL.EXAMPLES.find((e) => e.id === params.get('example') && e.make);
    sel.value = wanted ? wanted.id : CDCL.EXAMPLES[0].id;
    loadExample(sel.value);
    if (params.has('step')) go(Number(params.get('step')) - 1);
  }

  init();
})();
