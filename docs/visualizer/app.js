// Replays the frames recorded by cdcl.js.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_VARS = 80;
  const MAX_CLAUSES = 400;

  const state = { formula: null, trace: null, i: 0, timer: null, numInput: 0, shown: -1 };

  // ------------------------------------------------------------------ text helpers

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const varName = (v) => esc(state.formula.names[v] || `x${v}`);
  // Examples with a `say` function (like the party) read better as "no Bob" than "¬Bob".
  const litText = (l) => (l < 0 ? (state.formula.say ? 'no ' : '¬') : '') + varName(Math.abs(l));

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
  // "x3 = false" (or "Alice comes" when the example says how), coloured by the value.
  const setTo = (v, b) => `<span class="lit ${b ? 't' : 'f'}">${
    state.formula.say ? esc(state.formula.say(v, b)) : `${varName(v)} = ${b}`}</span>`;
  const ruleText = (k) => (state.formula.rules && k < state.numInput ? state.formula.rules[k] : null);
  const quote = (k) => (ruleText(k) ? `<p class="rule">${tag(k)} “${esc(ruleText(k))}”</p>` : '');

  function clauseHtml(lits, vals) {
    if (!lits.length) return '<span class="empty-clause">the empty clause</span>';
    return `<span class="paren">(</span>${lits.map((l) => lit(l, vals)).join('<span class="or">∨</span>')}<span class="paren">)</span>`;
  }

  function andList(items) {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  }

  const label = (k) => (k < state.numInput ? `C${k + 1}` : `L${k - state.numInput + 1}`);
  const tag = (k) => `<span class="ctag ${k >= state.numInput ? 'learned' : ''}">${label(k)}</span>`;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function levelOf(f, l) {
    const t = f.trail.find((x) => Math.abs(x.lit) === Math.abs(l));
    return t ? t.level : -1;
  }

  // ------------------------------------------------------------------ what's happening

  function describe(f, vals) {
    const C = state.trace.clauses;
    const now = (l) => setTo(Math.abs(l), vals.get(Math.abs(l)));
    const symbols = (k) => `<p class="aside">In symbols, ${tag(k)} is ${clauseHtml(C[k].lits, vals)}.</p>`;
    switch (f.type) {
      case 'start':
        return `<h3>Before anything happens</h3>
          <p>Nothing is decided yet. There are ${count(state.formula.numVars, 'variable', 'variables')} and
          ${count(state.numInput, 'rule', 'rules')}. Every rule is a list of options, and at least one option
          in each rule has to end up true.</p>
          <p class="aside">Press <b>Step →</b> (or the → key) to watch the solver work, or <b>Play</b> to let it run.</p>`;

      case 'decide': {
        const v = Math.abs(f.lit);
        const why = f.stats.conflicts === 0
          ? 'With nothing else to go on, it takes the first undecided variable and tries false.'
          : 'It picks a variable that keeps showing up in recent trouble, and tries the value it had last time.';
        return `<h3>Guess: ${setTo(v, f.lit > 0)}</h3>
          <p>No rule is forcing anything right now, so the solver has to guess. If the guess turns out badly,
          it can take it back later.</p>
          <p class="aside">The solver is now ${count(f.level, 'guess', 'guesses')} deep, which it calls level ${f.level}.
          This guess and everything it forces go in that row of the graph. ${why}</p>`;
      }

      case 'propagate': {
        const k = f.clauseIndex;
        const c = C[k].lits;
        const known = c.filter((l) => l !== f.lit).map(now);
        const because = known.length
          ? `We already know ${andList(known)}, so the only way left to follow this rule is ${setTo(Math.abs(f.lit), f.lit > 0)}.`
          : 'This rule has only one option, so that option has to be true.';
        if (f.asserting) {
          return `<h3>The new rule kicks in: ${setTo(Math.abs(f.lit), f.lit > 0)}</h3>
            <p>${because}</p>
            <p class="aside">This is why the solver learns rules: it can't walk back into the same dead end.</p>`;
        }
        return `<h3>Forced: ${setTo(Math.abs(f.lit), f.lit > 0)}</h3>
          ${quote(k)}
          <p>${because} No guessing needed.</p>
          ${ruleText(k) ? '' : symbols(k)}`;
      }

      case 'conflict': {
        const k = f.conflict;
        return `<h3 class="bad">A rule is broken</h3>
          ${quote(k)}
          <p>Right now ${andList(C[k].lits.map(now))}, so ${ruleText(k) ? 'this rule' : `rule ${tag(k)}`} can't be
          followed: every option in it has been ruled out.</p>
          <p class="aside">${f.level === 0
            ? 'This happened without any guesses, so there is nothing to take back.'
            : 'At least one guess was wrong. Instead of just undoing the last one, the solver first works out which guesses are really to blame.'}</p>
          ${ruleText(k) ? '' : symbols(k)}`;
      }

      case 'analyze': {
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        return `<h3>Working out what went wrong</h3>
          <p>The solver traces the problem backwards. For each fact involved, it asks "why was this set?" and
          replaces it with the reasons behind it. It stops when the blame points at a single fact from the latest guess.</p>
          <p class="aside">It starts from the broken rule, ${clauseHtml(f.clause, vals)}. ${k} of those facts come from the
          latest guess (level ${f.level}).</p>`;
      }

      case 'resolve': {
        const s = f.steps[f.steps.length - 1];
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        const rt = ruleText(s.with);
        return `<h3>Tracing back: ${setTo(s.on, vals.get(s.on))}</h3>
          <p>That only happened because of rule ${tag(s.with)}${rt ? ` (“${esc(rt)}”)` : ''}. So instead of blaming it,
          blame the things that forced it.</p>
          <p class="aside">Combining the two rules and dropping ${varName(s.on)} gives ${clauseHtml(s.result, vals)}.
          This step is called <i>resolution</i>. ${k === 1
            ? 'Now only one fact from the latest guess is left, so the search for the cause stops here.'
            : `Still ${k} facts from the latest guess, so keep going.`}</p>`;
      }

      case 'learn': {
        const parts = f.clause.map((l) => setTo(Math.abs(l), l < 0));
        const sentence = parts.length === 1 ? `${parts[0]} is impossible`
          : parts.length === 2 ? `${parts[0]} and ${parts[1]} can't both happen`
          : `${andList(parts)} can't all happen at once`;
        const n = f.dropped.length;
        const dropped = n
          ? ` ${andList(f.dropped.map((l) => lit(l, vals)))} ${n === 1 ? 'was' : 'were'} left out because ${n === 1 ? 'it was' : 'they were'} settled before any guess.`
          : '';
        return `<h3 class="good">Learned a new rule</h3>
          <p>It all comes down to this: <b>${sentence}</b>. That follows from the original rules, so the solver writes it
          down as ${tag(f.learnedIndex)} and will never try that combination again.</p>
          <p class="aside">In symbols, ${clauseHtml(f.clause, vals)}. The one fact left from the latest guess,
          ${lit(f.uip, vals)}, is called the <i>first UIP</i>.${dropped}</p>`;
      }

      case 'backjump': {
        const skipped = [];
        for (let L = f.to + 1; L < f.from; L++) skipped.push(String(L));
        if (!skipped.length) {
          return `<h3>Take back the last guess</h3>
            <p>Undo the latest guess (level ${f.from}) and everything that followed from it. The new rule will now push the solver a different way.</p>`;
        }
        return `<h3>Jump back to level ${f.to}</h3>
          <p>The new rule doesn't involve anything from level${skipped.length === 1 ? '' : 's'}
          ${andList(skipped)}, so ${skipped.length === 1 ? 'that guess wasn\'t' : 'those guesses weren\'t'} to blame. The solver
          undoes everything back to level ${f.to} in one go, where the new rule takes effect.</p>
          <p class="aside">A simpler solver (DPLL) would only undo the latest guess, and could waste a long time
          exploring around guesses that had nothing to do with the problem.</p>`;
      }

      case 'sat': {
        const vars = Object.keys(f.model).map(Number);
        const list = state.formula.say
          ? andList(vars.map((v) => setTo(v, f.model[v])))
          : (vars.filter((v) => f.model[v]).map((v) => `<span class="lit t">${varName(v)}</span>`).join(', ') || 'none of them');
        return `<h3 class="good">Solved!</h3>
          <p>Every rule is followed. ${state.formula.say ? `The answer: ${list}.` : `The variables that are true: ${list}.`}</p>`;
      }

      case 'unsat':
        if (f.emptyInput) return `<h3 class="bad">No solution</h3><p>The formula contains an empty rule, which can never be followed.</p>`;
        return `<h3 class="bad">No solution</h3>
          <p>A rule broke with no guesses left to take back. ${f.stats.learned === 0
            ? 'It came straight from the rules themselves, with no guessing at all.'
            : `Every learned rule follows from the original ones, so this proves there is no way to follow all of them at once. The ${f.stats.learned} learned rules are the proof.`}</p>`;

      case 'limit':
        return `<h3>Stopped</h3><p>This one goes on too long to replay. Try the command-line solver.</p>`;
      default:
        return '';
    }
  }

  // ------------------------------------------------------------------ implication graph

  const NODE_W = 84, NODE_H = 28, COL = 104, ROW = 74, LEFT = 82, TOP = 22;

  function layout(f) {
    const nodes = new Map();
    const perLevel = [];
    for (const t of f.trail) {
      const k = (perLevel[t.level] = (perLevel[t.level] || 0) + 1) - 1;
      nodes.set(Math.abs(t.lit), { ...t, x: LEFT + k * COL + NODE_W / 2, y: TOP + t.level * ROW + NODE_H / 2 });
    }
    return { nodes, perLevel };
  }

  // `prev` is the frame shown just before this one (stepping forward), or null.
  // New nodes pop in and their arrows draw themselves; nodes undone by a backjump fade out.
  function renderGraph(f, prev) {
    const svg = $('graph');
    const C = state.trace.clauses;
    const { nodes, perLevel } = layout(f);
    const before = prev ? layout(prev).nodes : null;
    const entering = new Set(before ? [...nodes.keys()].filter((v) => !before.has(v)) : []);
    const leaving = before ? [...before.values()].filter((nd) => !nodes.has(Math.abs(nd.lit))) : [];

    const showConflict = ['conflict', 'analyze', 'resolve', 'learn', 'unsat'].includes(f.type) && f.conflict !== undefined;
    const kappa = showConflict
      ? { x: LEFT + (perLevel[f.level] || 0) * COL + NODE_W / 2, y: TOP + f.level * ROW + NODE_H / 2 }
      : null;

    const analyzing = ['analyze', 'resolve', 'learn'].includes(f.type);
    const cut = new Set(analyzing ? f.clause.map(Math.abs) : []);
    const resolved = new Set(analyzing && f.steps ? f.steps.map((s) => s.on) : []);
    const uip = f.type === 'learn' ? Math.abs(f.uip) : 0;

    const levels = Math.max(f.level, ...leaving.map((nd) => nd.level)) + 1;
    const cols = Math.max(1, ...perLevel.map((x) => x || 0), ...(before ? layout(prev).perLevel.map((x) => x || 0) : []));
    const width = LEFT + (cols + (kappa ? 1 : 0)) * COL + 20;
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
      parts.push(`<line class="lane" x1="${LEFT - 8}" x2="${width - 10}" y1="${y}" y2="${y}"/>`);
      parts.push(`<text class="lane-label" x="10" y="${y + 4}">level ${L}</text>`);
    }

    const edge = (a, b, cls, title) => {
      const right = b.x > a.x + 1;
      const sx = a.x + (right ? NODE_W / 2 : 0);
      const sy = a.y + (right ? 0 : NODE_H / 2);
      const tx = b.x - NODE_W / 2 - 2, ty = b.y;
      const dx = Math.max(30, (tx - sx) / 2);
      return `<path class="edge ${cls}" pathLength="1" d="M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}"
        marker-end="url(#${cls.includes('bad') ? 'arrow-bad' : 'arrow'})"><title>${title}</title></path>`;
    };

    const node = (nd, cls, label, title) => `<g class="${cls}" transform="translate(${nd.x - NODE_W / 2},${nd.y - NODE_H / 2})">
        <title>${title}</title><g class="pop">
        <rect width="${NODE_W}" height="${NODE_H}" rx="4"/>
        <text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}">${label}</text></g></g>`;

    for (const nd of leaving) parts.push(node(nd, 'node leave', litText(nd.lit), 'undone'));

    for (const [v, nd] of nodes) {
      if (nd.reason < 0) continue;
      for (const l of C[nd.reason].lits) {
        const src = nodes.get(Math.abs(l));
        if (Math.abs(l) !== v && src) parts.push(edge(src, nd, entering.has(v) ? 'draw' : '', label(nd.reason)));
      }
    }
    if (kappa) {
      for (const l of C[f.conflict].lits) {
        const src = nodes.get(Math.abs(l));
        if (src) parts.push(edge(src, kappa, f.type === 'conflict' ? 'bad draw' : 'bad', `${label(f.conflict)} is broken`));
      }
    }

    for (const [v, nd] of nodes) {
      const cls = ['node', nd.reason < 0 ? 'decision' : 'implied', nd.lit > 0 ? 'pos' : 'neg'];
      if (cut.has(v)) cls.push('cut');
      if (resolved.has(v) && !cut.has(v)) cls.push('resolved');
      if (v === uip) cls.push('uip');
      if (entering.has(v)) cls.push('enter');
      const why = nd.reason < 0 ? `a guess (level ${nd.level})` : `forced by ${label(nd.reason)}${ruleText(nd.reason) ? `: “${ruleText(nd.reason)}”` : ''}`;
      parts.push(node(nd, cls.join(' '), litText(nd.lit), esc(`${litText(nd.lit)}: ${why}`)));
    }
    if (kappa) {
      parts.push(node(kappa, `node kappa${f.type === 'conflict' ? ' enter shake' : ''}`, `✗ ${label(f.conflict)}`, `${label(f.conflict)} is broken`));
    }
    if (!f.trail.length && !kappa) {
      parts.push(`<text class="lane-label" x="${LEFT}" y="${TOP + NODE_H / 2 + 4}">nothing decided yet</text>`);
    }
    svg.innerHTML = parts.join('');

    const fresh = ['decide', 'propagate'].includes(f.type) ? nodes.get(Math.abs(f.lit)) : null;
    const target = kappa || fresh;
    const box = svg.parentElement;
    if (target && (target.x < box.scrollLeft || target.x > box.scrollLeft + box.clientWidth - 60)) {
      box.scrollLeft = Math.max(0, target.x - box.clientWidth / 2);
    }
  }

  // ------------------------------------------------------------------ conflict working

  function renderAnalysis(i) {
    // Keep showing the latest conflict until the next one comes along.
    const frames = state.trace.frames;
    const kinds = ['conflict', 'analyze', 'resolve', 'learn', 'unsat'];
    let j = i;
    while (j >= 0 && !kinds.includes(frames[j].type)) j--;
    const f = j >= 0 ? frames[j] : null;
    const box = $('analysis');
    if (!f || f.conflict === undefined) {
      box.innerHTML = '<p class="empty">Nothing yet. When a rule breaks, the steps the solver takes to figure out why will show up here.</p>';
      return;
    }
    const C = state.trace.clauses;
    const rows = [`<li><span class="what">the broken rule</span>${tag(f.conflict)} ${clauseHtml(C[f.conflict].lits)}</li>`];
    for (const s of f.steps || []) {
      rows.push(`<li><span class="what">why ${litText(s.on * (C[s.with].lits.includes(s.on) ? 1 : -1))}? because of ${label(s.with)}</span>${tag(s.with)} ${clauseHtml(C[s.with].lits)}
        <span class="then">→ ${clauseHtml(s.result)}</span></li>`);
    }
    if (f.type === 'learn') {
      rows.push(`<li class="learned-row"><span class="what">new rule learned</span>${tag(f.learnedIndex)} ${clauseHtml(f.clause)}
        <span class="then caption">then jump back to level ${f.bt}</span></li>`);
    }
    box.innerHTML = `<ol class="derivation">${rows.join('')}</ol>`;
  }

  // ------------------------------------------------------------------ clause list

  function clauseStatus(lits, vals) {
    let free = 0;
    for (const l of lits) {
      const c = litClass(l, vals);
      if (c === 't') return 'sat';
      if (c === 'u') free++;
    }
    return free === 0 ? 'conflict' : free === 1 ? 'unit' : 'open';
  }

  function renderClauses(f, vals, prev) {
    const prevVals = prev ? valueMap(prev) : null;
    const C = state.trace.clauses;
    const hideSat = $('hide-sat').checked;
    const focus = new Set([f.clauseIndex, f.conflict, f.with, f.learnedIndex].filter((x) => x !== undefined));
    const order = [];
    for (let k = f.numClauses - 1; k >= state.numInput; k--) order.push(k);
    for (let k = 0; k < Math.min(state.numInput, f.numClauses); k++) order.push(k);

    const out = [];
    for (const k of order) {
      const lits = C[k].lits;
      const status = clauseStatus(lits, vals);
      if (hideSat && status === 'sat' && !focus.has(k)) continue;
      const changed = prev && (k >= prev.numClauses || clauseStatus(lits, prevVals) !== status);
      const title = (ruleText(k) ? `“${ruleText(k)}” ` : '')
        + { sat: '(already followed)', unit: '(one option left, so it will be forced)', conflict: '(broken: every option is ruled out)', open: '' }[status];
      out.push(`<span class="cl ${status} ${focus.has(k) ? 'focus' : ''} ${k >= state.numInput ? 'is-learned' : ''} ${changed ? 'flash' : ''}" title="${esc(title)}">
        ${tag(k)}${lits.map((l) => lit(l, vals)).join('<span class="or">∨</span>')}</span>`);
    }
    $('clauses').innerHTML = out.join('') || '<p class="caption">Every clause is satisfied.</p>';
  }

  // ------------------------------------------------------------------ main render

  function render() {
    const { frames } = state.trace;
    const f = frames[state.i];
    const vals = valueMap(f);
    const s = f.stats;
    $('where').textContent = [
      `step ${state.i + 1} of ${frames.length}`,
      `level ${f.level}`,
      `${f.trail.length} of ${state.formula.numVars} variables set`,
      count(s.decisions, 'guess', 'guesses'),
      count(s.conflicts, 'conflict', 'conflicts'),
      `${s.learned} learned`,
    ].join(' · ');
    const prev = state.shown === state.i - 1 ? frames[state.i - 1] : null;
    const text = $('narrative');
    text.innerHTML = describe(f, vals);
    if (state.shown !== state.i) {
      text.classList.remove('fade');
      void text.offsetWidth;  // restart the CSS animation
      text.classList.add('fade');
    }
    $('scrub').max = frames.length - 1;
    $('scrub').value = state.i;
    renderGraph(f, prev);
    renderAnalysis(state.i);
    renderClauses(f, vals, prev);
    state.shown = state.i;
    $('play').textContent = state.timer ? 'Pause' : 'Play';
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
    for (let j = state.i + 1; j < fr.length; j++) if (fr[j].type === 'conflict') return go(j);
    go(fr.length - 1);
  }

  // ------------------------------------------------------------------ loading formulas

  function showError(msg) {
    $('error').textContent = msg;
    $('error').hidden = !msg;
  }

  function load(formula, source) {
    if (formula.numVars > MAX_VARS || formula.clauses.length > MAX_CLAUSES) {
      showError(`That's ${formula.numVars} variables and ${formula.clauses.length} clauses, which is too big to draw. `
        + `This page handles up to ${MAX_VARS} variables and ${MAX_CLAUSES} clauses; use the command-line solver for anything larger.`);
      return;
    }
    showError('');
    stop();
    state.formula = formula;
    state.numInput = formula.clauses.length;
    state.trace = CDCL.solveTrace(formula);
    state.i = 0;
    state.shown = -1;
    if (source !== undefined) $('dimacs').value = source;
    render();
  }

  function setEditor(open) {
    $('editor').hidden = !open;
    $('edit-toggle').setAttribute('aria-expanded', String(open));
    $('edit-toggle').textContent = open ? 'hide the formula' : 'edit / paste your own';
  }

  function loadExample(id) {
    const ex = CDCL.EXAMPLES.find((e) => e.id === id);
    $('blurb').textContent = ex.blurb;
    $('random-controls').hidden = id !== 'random';
    if (id === 'custom') {
      setEditor(true);
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
    $('edit-toggle').addEventListener('click', () => setEditor($('editor').hidden));
    $('rand-go').addEventListener('click', () => {
      const f = randomFormula();
      load(f, CDCL.toDimacs(f, `random 3-SAT, seed ${$('rand-seed').value}`));
    });
    $('solve').addEventListener('click', () => {
      try {
        load(CDCL.parseDimacs($('dimacs').value));
      } catch (e) {
        showError(`Couldn't read that formula: ${e.message}`);
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

    // Links to a specific step: #example=php&step=40
    const params = new URLSearchParams(location.hash.slice(1));
    const wanted = CDCL.EXAMPLES.find((e) => e.id === params.get('example') && e.make);
    sel.value = wanted ? wanted.id : CDCL.EXAMPLES[0].id;
    loadExample(sel.value);
    if (params.has('step')) go(Number(params.get('step')) - 1);
  }

  init();
})();
