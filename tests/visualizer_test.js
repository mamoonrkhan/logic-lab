#!/usr/bin/env node
// Differential tests for the visualizer's JavaScript CDCL engine.
//
// For random formulas: the JS engine must agree with the C++ solver, SAT models must
// satisfy the formula, every learned clause must be implied by the clauses before it
// (checked by reverse unit propagation), and every recorded frame must be internally
// consistent (each propagated literal is really forced by its reason clause).
//
// usage: node tests/visualizer_test.js [count] [path/to/logiclab]

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const CDCL = require('../docs/visualizer/cdcl.js');

const count = Number(process.argv[2] || 400);
const solver = process.argv[3] || path.join(__dirname, '..', 'build', 'logiclab');
let failures = 0;

function fail(msg) {
  failures++;
  console.log(`  FAIL: ${msg}`);
}

function cppResult(formula) {
  const r = spawnSync(solver, ['--no-model', '-'], { input: CDCL.toDimacs(formula) });
  if (r.error) throw r.error;
  return { 10: 'SAT', 20: 'UNSAT' }[r.status] || `exit ${r.status}`;
}

function isRup(clauses, lemma) {
  const t = new Set(lemma.map((l) => -l));
  for (let changed = true; changed;) {
    changed = false;
    for (const c of clauses) {
      let free = 0, last = 0, sat = false;
      for (const l of c) {
        if (t.has(l)) { sat = true; break; }
        if (!t.has(-l)) { free++; last = l; }
      }
      if (sat) continue;
      if (free === 0) return true;
      if (free === 1) { t.add(last); changed = true; }
    }
  }
  return false;
}

function checkFrames(trace, tag) {
  for (const [i, f] of trace.frames.entries()) {
    const val = new Map(f.trail.map((t) => [Math.abs(t.lit), t.lit > 0]));
    const isFalse = (l) => val.has(Math.abs(l)) && val.get(Math.abs(l)) !== (l > 0);
    for (const t of f.trail) {
      if (t.reason < 0) continue;
      const c = trace.clauses[t.reason].lits;
      if (!c.includes(t.lit) || !c.every((l) => l === t.lit || isFalse(l))) {
        return fail(`${tag}: frame ${i} (${f.type}): ${t.lit} not forced by clause ${t.reason}`);
      }
    }
    if (f.type === 'conflict' && !trace.clauses[f.conflict].lits.every(isFalse)) {
      return fail(`${tag}: frame ${i}: conflict clause not falsified`);
    }
  }
}

let rngState = 12345;
const rnd = () => ((rngState = (rngState * 1103515245 + 12345) % 2147483648) / 2147483648);

const tally = { SAT: 0, UNSAT: 0 };
for (let i = 0; i < count && !failures; i++) {
  const n = 1 + Math.floor(rnd() * 14);
  const m = 1 + Math.floor(rnd() * n * 6);
  const formula = CDCL.random3Sat(n, m, 1 + Math.floor(rnd() * 1e9));
  const tag = `#${i} n=${n} m=${m}`;
  const trace = CDCL.solveTrace(formula);
  const expected = cppResult(formula);
  if (trace.result !== expected) { fail(`${tag}: js ${trace.result}, c++ ${expected}`); break; }
  tally[expected]++;
  if (trace.result === 'SAT') {
    const ok = formula.clauses.every((c) => c.some((l) => trace.model[Math.abs(l)] === (l > 0)));
    if (!ok) fail(`${tag}: model does not satisfy the formula`);
  }
  trace.clauses.forEach((c, k) => {
    if (c.learned && !isRup(trace.clauses.slice(0, k).map((x) => x.lits), c.lits)) {
      fail(`${tag}: learned clause ${k} is not implied`);
    }
  });
  checkFrames(trace, tag);
}
console.log(`visualizer engine: ${count} formulas, ${tally.SAT} SAT, ${tally.UNSAT} UNSAT`);

for (const ex of CDCL.EXAMPLES.filter((e) => e.make)) {
  const f = ex.make();
  const trace = CDCL.solveTrace(f);
  if (trace.result !== cppResult(f)) fail(`example ${ex.id}: ${trace.result}`);
  checkFrames(trace, `example ${ex.id}`);
}
console.log(failures ? `${failures} FAILURE(S)` : 'all visualizer tests passed');
process.exit(failures ? 1 : 0);
