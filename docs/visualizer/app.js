// Replays the frames recorded by cdcl.js.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const MAX_VARS = 80;
  const MAX_CLAUSES = 400;

  const state = { formula: null, trace: null, i: 0, timer: null, numInput: 0 };

  // ------------------------------------------------------------------ text helpers

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
  // "x3 = false", coloured by the value.
  const setTo = (v, b) => `<span class="lit ${b ? 't' : 'f'}">${varName(v)} = ${b}</span>`;

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
    switch (f.type) {
      case 'start':
        return `<h3>Before anything happens</h3>
          <p>Nothing is set yet. There are ${count(state.formula.numVars, 'variable', 'variables')} and
          ${count(state.numInput, 'clause', 'clauses')}. Press <kbd>→</kbd> to start.</p>`;

      case 'decide': {
        const v = Math.abs(f.lit);
        const why = f.stats.conflicts === 0
          ? 'Nothing has gone wrong yet, so it just takes the lowest-numbered variable that isn\'t set and tries false first.'
          : 'It goes for a variable that keeps showing up in recent conflicts, and gives it the value it had last time.';
        return `<h3>Guess: ${setTo(v, f.lit > 0)}</h3>
          <p>Nothing is forced right now, so the solver has to guess. That starts level ${f.level}.</p>
          <p class="aside">${why}</p>`;
      }

      case 'propagate': {
        const c = C[f.clauseIndex].lits;
        const v = Math.abs(f.lit);
        const others = c.filter((l) => l !== f.lit).map((l) => lit(l, vals));
        const reason = others.length
          ? `${andList(others)} ${others.length === 1 ? 'is' : 'are'} already false, so ${lit(f.lit, vals)} is the only way left to satisfy it.`
          : 'It only has one literal, so that literal has to be true.';
        if (f.asserting) {
          return `<h3>Forced by what it just learned: ${setTo(v, f.lit > 0)}</h3>
            <p>${tag(f.clauseIndex)} is ${clauseHtml(c, vals)}. ${reason}</p>
            <p class="aside">This is the learned clause doing its job. The solver can't walk back into the same conflict.</p>`;
        }
        return `<h3>Forced: ${setTo(v, f.lit > 0)}</h3>
          <p>${tag(f.clauseIndex)} is ${clauseHtml(c, vals)}. ${reason}</p>`;
      }

      case 'conflict':
        return `<h3 class="bad">Conflict</h3>
          <p>${tag(f.conflict)} is ${clauseHtml(C[f.conflict].lits, vals)}, and every literal in it is now false.
          ${f.level === 0
            ? 'And this happened before any guesses were made.'
            : 'At least one guess was bad. The next few steps work out which ones.'}</p>`;

      case 'analyze': {
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        return `<h3>Why did that happen?</h3>
          <p>Start from the broken clause ${clauseHtml(f.clause, vals)}. ${k} of its literals were set at level ${f.level},
          after the latest guess. Keep swapping those out for whatever forced them, until only one from level ${f.level} is left.</p>`;
      }

      case 'resolve': {
        const s = f.steps[f.steps.length - 1];
        const k = f.clause.filter((l) => levelOf(f, l) === f.level).length;
        return `<h3>Swap out ${varName(s.on)}</h3>
          <p>${setTo(s.on, vals.get(s.on))} was forced by ${tag(s.with)} ${clauseHtml(C[s.with].lits, vals)}.
          Merge that clause into the current one and drop ${varName(s.on)} (this step is called <i>resolution</i>):</p>
          <p>${clauseHtml(s.result, vals)}</p>
          <p class="aside">${k === 1 ? `Only one literal from level ${f.level} left, so this is where it stops.` : `Still ${k} from level ${f.level}.`}</p>`;
      }

      case 'learn': {
        const rule = andList(f.clause.map((l) => setTo(Math.abs(l), l < 0)));
        const n = f.dropped.length;
        const dropped = n
          ? ` (${andList(f.dropped.map((l) => lit(l, vals)))} ${n === 1 ? 'was' : 'were'} left out because ${n === 1 ? 'it was' : 'they were'} forced before any guess, so ${n === 1 ? 'it' : 'they'} can never change.)`
          : '';
        return `<h3 class="good">Learned ${tag(f.learnedIndex)}</h3>
          <p>${lit(f.uip, vals)} is the only one left from level ${f.level}. The new clause is ${clauseHtml(f.clause, vals)}.${dropped}</p>
          <p>Read it as a rule: ${f.clause.length === 1 ? `${rule} is impossible.` : `${rule} can't all happen at once.`}
          It follows from the original clauses, so adding it doesn't change the answer. It just stops the solver from making this mistake again.</p>`;
      }

      case 'backjump': {
        const skipped = [];
        for (let L = f.to + 1; L < f.from; L++) skipped.push(String(L));
        if (!skipped.length) {
          return `<h3>Back to level ${f.to}</h3><p>Undo everything from level ${f.from} and carry on with the new clause.</p>`;
        }
        return `<h3>Jump back to level ${f.to}</h3>
          <p>The new clause doesn't mention anything from level${skipped.length === 1 ? '' : 's'} ${andList(skipped)}, so ${skipped.length === 1 ? 'that guess' : 'those guesses'}
          had nothing to do with the conflict. ${skipped.length === 1 ? 'It gets' : 'They get'} thrown away too.</p>
          <p class="aside">Plain backtracking would only undo level ${f.from} and then probably redo the same work.
          Skipping levels like this is a big part of why CDCL is fast.</p>`;
      }

      case 'sat': {
        const trues = Object.entries(f.model).filter(([, b]) => b).map(([v]) => `<span class="lit t">${varName(Number(v))}</span>`);
        return `<h3 class="good">Solved</h3>
          <p>Every variable has a value and every clause has at least one true literal.
          The true ones are ${trues.length ? andList(trues) : '(none: everything is false)'}.</p>`;
      }

      case 'unsat':
        if (f.emptyInput) return `<h3 class="bad">No solution</h3><p>The formula contains an empty clause, which can never be true.</p>`;
        if (f.stats.learned === 0) {
          return `<h3 class="bad">No solution</h3>
            <p>Just following the forced values leads to a contradiction, with no guesses involved. So nothing can satisfy this formula.</p>`;
        }
        return `<h3 class="bad">No solution</h3>
          <p>This conflict happened with no guesses left to undo. Every learned clause followed from the original ones,
          so the formula really has no solution. The ${f.stats.learned} learned clauses are, together, a proof of that.</p>`;

      case 'limit':
        return `<h3>Stopped</h3><p>This one goes on too long to replay. Try the command-line solver.</p>`;
      default:
        return '';
    }
  }

  // ------------------------------------------------------------------ implication graph

  const NODE_W = 84, NODE_H = 28, COL = 104, ROW = 74, LEFT = 82, TOP = 22;

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
    const kappa = showConflict
      ? { x: LEFT + (perLevel[f.level] || 0) * COL + NODE_W / 2, y: TOP + f.level * ROW + NODE_H / 2 }
      : null;

    const analyzing = ['analyze', 'resolve', 'learn'].includes(f.type);
    const cut = new Set(analyzing ? f.clause.map(Math.abs) : []);
    const resolved = new Set(analyzing && f.steps ? f.steps.map((s) => s.on) : []);
    const uip = f.type === 'learn' ? Math.abs(f.uip) : 0;

    const levels = f.level + 1;
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
      parts.push(`<line class="lane" x1="${LEFT - 8}" x2="${width - 10}" y1="${y}" y2="${y}"/>`);
      parts.push(`<text class="lane-label" x="10" y="${y + 4}">level ${L}</text>`);
    }

    const edge = (a, b, bad, title) => {
      const right = b.x > a.x + 1;
      const sx = a.x + (right ? NODE_W / 2 : 0);
      const sy = a.y + (right ? 0 : NODE_H / 2);
      const tx = b.x - NODE_W / 2 - 2, ty = b.y;
      const dx = Math.max(30, (tx - sx) / 2);
      return `<path class="edge ${bad ? 'bad' : ''}" d="M${sx},${sy} C${sx + dx},${sy} ${tx - dx},${ty} ${tx},${ty}"
        marker-end="url(#${bad ? 'arrow-bad' : 'arrow'})"><title>${title}</title></path>`;
    };

    for (const [v, nd] of nodes) {
      if (nd.reason < 0) continue;
      for (const l of C[nd.reason].lits) {
        const src = nodes.get(Math.abs(l));
        if (Math.abs(l) !== v && src) parts.push(edge(src, nd, false, label(nd.reason)));
      }
    }
    if (kappa) {
      for (const l of C[f.conflict].lits) {
        const src = nodes.get(Math.abs(l));
        if (src) parts.push(edge(src, kappa, true, `${label(f.conflict)} is broken`));
      }
    }

    for (const [v, nd] of nodes) {
      const cls = ['node', nd.reason < 0 ? 'decision' : 'implied', nd.lit > 0 ? 'pos' : 'neg'];
      if (cut.has(v)) cls.push('cut');
      if (resolved.has(v) && !cut.has(v)) cls.push('resolved');
      if (v === uip) cls.push('uip');
      const why = nd.reason < 0 ? `guessed at level ${nd.level}` : `forced by ${label(nd.reason)}`;
      parts.push(`<g class="${cls.join(' ')}" transform="translate(${nd.x - NODE_W / 2},${nd.y - NODE_H / 2})">
        <title>${litText(nd.lit)}: ${why}</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="4"/>
        <text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}">${litText(nd.lit)}</text></g>`);
    }
    if (kappa) {
      parts.push(`<g class="node kappa" transform="translate(${kappa.x - NODE_W / 2},${kappa.y - NODE_H / 2})">
        <title>${label(f.conflict)} is broken</title>
        <rect width="${NODE_W}" height="${NODE_H}" rx="4"/><text x="${NODE_W / 2}" y="${NODE_H / 2 + 4}">✗ ${label(f.conflict)}</text></g>`);
    }
    if (!f.trail.length && !kappa) {
      parts.push(`<text class="lane-label" x="${LEFT}" y="${TOP + NODE_H / 2 + 4}">nothing set yet</text>`);
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
      box.innerHTML = '<p class="empty">Nothing yet. When a clause breaks, the steps for figuring out why will show up here.</p>';
      return;
    }
    const C = state.trace.clauses;
    const rows = [`<li><span class="what">broken clause</span>${tag(f.conflict)} ${clauseHtml(C[f.conflict].lits)}</li>`];
    for (const s of f.steps || []) {
      rows.push(`<li><span class="what">swap out ${varName(s.on)} using ${label(s.with)}</span>${tag(s.with)} ${clauseHtml(C[s.with].lits)}
        <span class="then">→ ${clauseHtml(s.result)}</span></li>`);
    }
    if (f.type === 'learn') {
      rows.push(`<li class="learned-row"><span class="what">learned</span>${tag(f.learnedIndex)} ${clauseHtml(f.clause)}
        <span class="then caption">then jump back to level ${f.bt}</span></li>`);
    }
    box.innerHTML = `<ol class="derivation">${rows.join('')}</ol>`;
  }

  // ------------------------------------------------------------------ clause list

  function renderClauses(f, vals) {
    const C = state.trace.clauses;
    const hideSat = $('hide-sat').checked;
    const focus = new Set([f.clauseIndex, f.conflict, f.with, f.learnedIndex].filter((x) => x !== undefined));
    const order = [];
    for (let k = f.numClauses - 1; k >= state.numInput; k--) order.push(k);
    for (let k = 0; k < Math.min(state.numInput, f.numClauses); k++) order.push(k);

    const out = [];
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
      const title = { sat: 'already satisfied', unit: 'one literal left, so it will be forced', conflict: 'broken: every literal is false', open: '' }[status];
      out.push(`<span class="cl ${status} ${focus.has(k) ? 'focus' : ''} ${k >= state.numInput ? 'is-learned' : ''}" title="${title}">
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
    $('narrative').innerHTML = describe(f, vals);
    $('scrub').max = frames.length - 1;
    $('scrub').value = state.i;
    renderGraph(f);
    renderAnalysis(state.i);
    renderClauses(f, vals);
    $('play').textContent = state.timer ? 'pause' : 'play';
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
