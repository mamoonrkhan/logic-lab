// An instrumented CDCL solver for the visualizer.
//
// It follows the same algorithm as src/cdcl.cpp (VSIDS-style branching with phase
// saving, first-UIP learning, non-chronological backjumping), but it is written for
// clarity rather than speed: unit propagation scans the clause list instead of using
// watched literals, and every step is recorded as a "frame" the UI can replay.
//
// Literals use DIMACS conventions: variable v is +v, its negation -v.

(function (root) {
  'use strict';

  // ------------------------------------------------------------------ parsing

  // Parses DIMACS CNF. Lines of the form "c var <index> <name>" give variables names.
  function parseDimacs(text) {
    let numVars = 0;
    const clauses = [];
    const names = {};
    let cur = [];
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line[0] === 'c') {
        const m = /^c\s+var\s+(\d+)\s+(\S+)/.exec(line);
        if (m) names[Number(m[1])] = m[2];
        continue;
      }
      if (line[0] === '%') break;
      if (line[0] === 'p') {
        const parts = line.split(/\s+/);
        if (parts[1] !== 'cnf' || !/^\d+$/.test(parts[2] || '')) {
          throw new Error(`line ${i + 1}: expected "p cnf <vars> <clauses>"`);
        }
        numVars = Math.max(numVars, Number(parts[2]));
        continue;
      }
      for (const tok of line.split(/\s+/)) {
        if (!/^-?\d+$/.test(tok)) throw new Error(`line ${i + 1}: unexpected token "${tok}"`);
        const v = Number(tok);
        if (v === 0) {
          clauses.push(cur);
          cur = [];
        } else {
          numVars = Math.max(numVars, Math.abs(v));
          cur.push(v);
        }
      }
    }
    if (cur.length) clauses.push(cur);
    return { numVars, clauses, names };
  }

  function toDimacs(formula, comment) {
    const out = [];
    if (comment) for (const l of comment.split('\n')) out.push(`c ${l}`);
    for (const [v, name] of Object.entries(formula.names || {})) out.push(`c var ${v} ${name}`);
    out.push(`p cnf ${formula.numVars} ${formula.clauses.length}`);
    for (const c of formula.clauses) out.push(`${c.join(' ')} 0`);
    return out.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ solver

  function solveTrace(formula, options) {
    const opts = Object.assign({ maxFrames: 5000, decay: 0.95 }, options);
    const n = formula.numVars;

    // Duplicate literals would hide unit clauses from the counting scan below.
    const clauses = formula.clauses.map((c) => ({ lits: [...new Set(c)], learned: false }));

    const value = new Int8Array(n + 1);        // 0 unassigned, 1 true, -1 false
    const level = new Int32Array(n + 1);
    const reason = new Int32Array(n + 1).fill(-1); // clause index, or -1 for a decision
    const pos = new Int32Array(n + 1);           // position on the trail
    const activity = new Float64Array(n + 1);
    const phase = new Int8Array(n + 1).fill(-1); // saved polarity, false by default
    const trail = [];
    const trailLim = [];
    let inc = 1;
    const stats = { decisions: 0, propagations: 0, conflicts: 0, learned: 0, maxJump: 0 };
    const frames = [];

    const litValue = (l) => (l > 0 ? value[l] : -value[-l]);
    const decisionLevel = () => trailLim.length;

    function assign(lit, why) {
      const v = Math.abs(lit);
      value[v] = lit > 0 ? 1 : -1;
      level[v] = decisionLevel();
      reason[v] = why;
      pos[v] = trail.length;
      trail.push(lit);
    }

    function snapshot(type, data) {
      frames.push(Object.assign({
        type,
        trail: trail.map((lit) => ({ lit, level: level[Math.abs(lit)], reason: reason[Math.abs(lit)] })),
        level: decisionLevel(),
        numClauses: clauses.length,
        stats: Object.assign({}, stats),
      }, data));
      return frames.length < opts.maxFrames;
    }

    function backtrack(to) {
      while (trailLim.length > to) {
        const stop = trailLim.pop();
        while (trail.length > stop) {
          const lit = trail.pop();
          const v = Math.abs(lit);
          phase[v] = value[v];
          value[v] = 0;
          reason[v] = -1;
        }
      }
    }

    // Returns {conflict: i} or {unit: i, lit} or null.
    function scan() {
      let unit = null;
      for (let i = 0; i < clauses.length; i++) {
        let free = 0, last = 0, sat = false;
        for (const l of clauses[i].lits) {
          const val = litValue(l);
          if (val === 1) { sat = true; break; }
          if (val === 0) { free++; last = l; }
        }
        if (sat) continue;
        if (free === 0) return { conflict: i };
        if (free === 1 && !unit) unit = { unit: i, lit: last };
      }
      return unit;
    }

    function bump(v) {
      activity[v] += inc;
      if (activity[v] > 1e100) {
        for (let u = 1; u <= n; u++) activity[u] *= 1e-100;
        inc *= 1e-100;
      }
    }

    function pickBranch() {
      let best = 0;
      for (let v = 1; v <= n; v++) {
        if (value[v] === 0 && (best === 0 || activity[v] > activity[best])) best = v;
      }
      return best === 0 ? 0 : (phase[best] === 1 ? best : -best);
    }

    // First-UIP analysis, recording each resolution step.
    function analyze(conflictIdx) {
      const d = decisionLevel();
      let cur = clauses[conflictIdx].lits.slice();
      const steps = [];
      const atCurrent = (c) => c.filter((l) => level[Math.abs(l)] === d);

      if (!snapshot('analyze', { conflict: conflictIdx, clause: cur.slice(), steps: steps.slice() })) return null;
      while (atCurrent(cur).length > 1) {
        // Resolve on the current-level literal that was assigned most recently.
        let pivot = 0;
        for (const l of atCurrent(cur)) if (!pivot || pos[Math.abs(l)] > pos[Math.abs(pivot)]) pivot = l;
        const v = Math.abs(pivot);
        const r = reason[v];
        const before = cur;
        const merged = new Set(cur.filter((l) => l !== pivot));
        for (const l of clauses[r].lits) if (l !== -pivot) merged.add(l);
        cur = [...merged];
        for (const l of cur) bump(Math.abs(l));
        bump(v);
        steps.push({ before, with: r, on: v, result: cur.slice() });
        if (!snapshot('resolve', { conflict: conflictIdx, clause: cur.slice(), steps: steps.slice(), pivot: v, with: r })) return null;
      }

      // Literals false at level 0 are false forever, so they can be dropped.
      const dropped = cur.filter((l) => level[Math.abs(l)] === 0);
      const learned = cur.filter((l) => level[Math.abs(l)] > 0);
      const uip = atCurrent(learned)[0];
      let bt = 0;
      for (const l of learned) if (l !== uip) bt = Math.max(bt, level[Math.abs(l)]);
      // Order: asserting literal first, then by decreasing level (reads naturally).
      learned.sort((a, b) => (a === uip ? -1 : b === uip ? 1 : level[Math.abs(b)] - level[Math.abs(a)]));
      return { learned, uip, bt, dropped, steps };
    }

    if (clauses.some((c) => c.lits.length === 0)) {
      snapshot('start', {});
      snapshot('unsat', { emptyInput: true });
      return { frames, clauses, result: 'UNSAT', stats };
    }
    if (!snapshot('start', {})) return { frames, clauses, result: 'LIMIT', stats };

    for (;;) {
      const s = scan();
      if (s && 'conflict' in s) {
        stats.conflicts++;
        if (!snapshot('conflict', { conflict: s.conflict })) break;
        if (decisionLevel() === 0) {
          snapshot('unsat', { conflict: s.conflict });
          return { frames, clauses, result: 'UNSAT', stats };
        }
        const a = analyze(s.conflict);
        if (!a) break;
        const idx = clauses.length;
        clauses.push({ lits: a.learned, learned: true });
        stats.learned++;
        if (!snapshot('learn', { conflict: s.conflict, clause: a.learned, learnedIndex: idx, uip: a.uip, bt: a.bt,
                                  dropped: a.dropped, steps: a.steps })) break;
        const from = decisionLevel();
        stats.maxJump = Math.max(stats.maxJump, from - a.bt);
        backtrack(a.bt);
        inc /= opts.decay;
        if (!snapshot('backjump', { from, to: a.bt, learnedIndex: idx })) break;
        // The learned clause is now unit: every literal but the UIP one is false.
        assign(a.uip, idx);
        stats.propagations++;
        if (!snapshot('propagate', { lit: a.uip, clauseIndex: idx, asserting: true })) break;
      } else if (s) {
        assign(s.lit, s.unit);
        stats.propagations++;
        if (!snapshot('propagate', { lit: s.lit, clauseIndex: s.unit })) break;
      } else {
        const lit = pickBranch();
        if (lit === 0) {
          const model = {};
          for (let v = 1; v <= n; v++) model[v] = value[v] === 1;
          snapshot('sat', { model });
          return { frames, clauses, result: 'SAT', stats, model };
        }
        stats.decisions++;
        trailLim.push(trail.length);
        assign(lit, -1);
        if (!snapshot('decide', { lit })) break;
      }
    }
    snapshot('limit', {});
    return { frames, clauses, result: 'LIMIT', stats };
  }

  // ------------------------------------------------------------------ example formulas

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function random3Sat(n, m, seed) {
    const rnd = mulberry32(seed);
    const clauses = [];
    for (let i = 0; i < m; i++) {
      const vars = new Set();
      while (vars.size < Math.min(3, n)) vars.add(1 + Math.floor(rnd() * n));
      clauses.push([...vars].map((v) => (rnd() < 0.5 ? v : -v)));
    }
    return { numVars: n, clauses, names: {} };
  }

  class Builder {
    constructor() { this.numVars = 0; this.clauses = []; this.names = {}; this.index = new Map(); }
    v(name) {
      if (!this.index.has(name)) { this.index.set(name, ++this.numVars); this.names[this.numVars] = name; }
      return this.index.get(name);
    }
    add(c) { this.clauses.push(c); }
    atMostOne(lits) {
      for (let i = 0; i < lits.length; i++) for (let j = i + 1; j < lits.length; j++) this.add([-lits[i], -lits[j]]);
    }
    done() { return { numVars: this.numVars, clauses: this.clauses, names: this.names }; }
  }

  function pigeonhole(holes) {
    const b = new Builder();
    for (let p = 1; p <= holes + 1; p++) for (let h = 1; h <= holes; h++) b.v(`P${p}H${h}`);
    for (let p = 1; p <= holes + 1; p++) b.add([...Array(holes)].map((_, h) => b.v(`P${p}H${h + 1}`)));
    for (let h = 1; h <= holes; h++) b.atMostOne([...Array(holes + 1)].map((_, p) => b.v(`P${p + 1}H${h}`)));
    return b.done();
  }

  function queens(n) {
    const b = new Builder();
    const q = (r, c) => b.v(`Q${r + 1}${String.fromCharCode(97 + c)}`);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) q(r, c);
    for (let r = 0; r < n; r++) {
      b.add([...Array(n)].map((_, c) => q(r, c)));
      b.atMostOne([...Array(n)].map((_, c) => q(r, c)));
    }
    for (let c = 0; c < n; c++) b.atMostOne([...Array(n)].map((_, r) => q(r, c)));
    for (let s = 0; s < 2 * n - 1; s++) {
      const d1 = [], d2 = [];
      for (let r = 0; r < n; r++) {
        if (s - r >= 0 && s - r < n) d1.push(q(r, s - r));
        const c = r - (s - (n - 1));
        if (c >= 0 && c < n) d2.push(q(r, c));
      }
      b.atMostOne(d1);
      b.atMostOne(d2);
    }
    return b.done();
  }

  function coloring(vertices, edges, colors) {
    const b = new Builder();
    const x = (v, c) => b.v(`${v}=${c}`);
    for (const v of vertices) for (const c of colors) x(v, c);
    for (const v of vertices) {
      b.add(colors.map((c) => x(v, c)));
      b.atMostOne(colors.map((c) => x(v, c)));
    }
    for (const [u, v] of edges) for (const c of colors) b.add([-x(u, c), -x(v, c)]);
    return b.done();
  }

  function syllogism() {
    // (p -> q), (q -> r), p, not r
    return { numVars: 3, clauses: [[-1, 2], [-2, 3], [1], [-3]], names: { 1: 'p', 2: 'q', 3: 'r' } };
  }

  const wheel = (k) => {
    const vs = ['hub', ...[...Array(k)].map((_, i) => `v${i + 1}`)];
    const edges = [];
    for (let i = 1; i <= k; i++) {
      edges.push(['hub', `v${i}`]);
      edges.push([`v${i}`, `v${(i % k) + 1}`]);
    }
    return [vs, edges];
  };

  const EXAMPLES = [
    { id: 'learn', title: 'Clause learning and backjumping (random 3-SAT, UNSAT)',
      blurb: 'Ten variables, 45 clauses. Watch conflicts produce learned clauses and multi-level backjumps.',
      make: () => random3Sat(10, 45, 54) },
    { id: 'syllogism', title: 'Hypothetical syllogism: p→q, q→r, p, ¬r',
      blurb: 'Unit propagation alone refutes it: no decisions needed.',
      make: syllogism },
    { id: 'queens', title: '4-Queens (SAT)',
      blurb: 'Variable Q2c means "a queen on row 2, column c".',
      make: () => queens(4) },
    { id: 'wheel', title: 'Is the wheel W5 3-colorable? (UNSAT)',
      blurb: 'A hub joined to a 5-cycle. The odd cycle needs 3 colors, so the hub has none left.',
      make: () => { const [v, e] = wheel(5); return coloring(v, e, ['R', 'G', 'B']); } },
    { id: 'php', title: 'Pigeonhole: 4 pigeons, 3 holes (UNSAT)',
      blurb: 'P2H3 means "pigeon 2 sits in hole 3". Small, but already needs many conflicts.',
      make: () => pigeonhole(3) },
    { id: 'random', title: 'Random 3-SAT…', blurb: 'Pick a size and a seed.', make: null },
    { id: 'custom', title: 'Custom DIMACS…', blurb: 'Edit the formula below and press Solve.', make: null },
  ];

  const api = { parseDimacs, toDimacs, solveTrace, random3Sat, pigeonhole, queens, coloring, EXAMPLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CDCL = api;
})(typeof self !== 'undefined' ? self : this);
