// The beginner story at the top of the page: the party puzzle, one picture per step.
// The pictures come from the solver's real run (CDCL.solveTrace), and the words are written
// for that run. tests/visualizer_test.js checks the run still has the shape this text assumes.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const formula = CDCL.party();
  const trace = CDCL.solveTrace(formula);
  const N = formula.numVars;

  // frame: which step of the solver's run to picture (0-based). rule: which rule card to light up (0-based).
  const STORY = [
    { frame: 0, title: 'Six friends, seven rules',
      text: 'You\'re throwing a party, but your friends come with conditions (the cards below). Is there a guest list that follows every rule? Let\'s watch how a computer would figure it out.' },
    { frame: 1, title: 'Make a guess: Alice stays home',
      text: 'None of the rules tells us anything yet, so we have to guess. Guesses get a pencil tag, because they can be taken back later.' },
    { frame: 2, rule: 0, title: 'So Bob has to come',
      text: 'Rule 1 says Alice or Bob has to come. Alice is staying home, so Bob must come. No guessing here: the rule forces it.' },
    { frame: 3, rule: 1, title: 'So Dave comes too',
      text: 'Rule 2: if Bob comes, Dave comes. Bob is coming, so Dave is too.' },
    { frame: 4, title: 'Another guess: Carol stays home',
      text: 'Nothing else is forced, so we guess again.' },
    { frame: 5, rule: 2, title: 'So Frank has to come',
      text: 'Rule 3: Carol or Frank has to bring the cake. Carol is out, so Frank comes.' },
    { frame: 6, rule: 3, title: 'So Eve comes too',
      text: 'Rule 4: if Frank comes, Eve comes.' },
    { frame: 7, rule: 4, broken: true, title: 'Uh oh, a rule is broken',
      text: 'Rule 5 says Frank, Dave and Eve can\'t all come, and now all three are coming. So one of our guesses must have been wrong. But which one?' },
    { frame: 10, title: 'Work out what really went wrong',
      text: 'Trace it back. Eve is only coming because of Frank (rule 4). So the real problem is simpler: Frank and Dave can\'t both come. We write that down as a new rule, so we never walk into this again.' },
    { frame: 11, title: 'Take back the bad guess',
      text: 'Frank is only coming because of the second guess (Carol stays home), so we take that guess back, along with everything it caused. The first guess about Alice stays: it wasn\'t the problem.' },
    { frame: 12, rule: 'learned', title: 'The new rule kicks in: Frank stays home',
      text: 'Our new rule says Frank and Dave can\'t both come. Dave is coming, so Frank stays home. Learning that rule just saved us from trying the same thing twice.' },
    { frame: 13, rule: 2, title: 'So Carol comes',
      text: 'Rule 3 again: Carol or Frank brings the cake. Frank is out now, so Carol comes. (Rule 6, "Alice and Carol can\'t both come", is fine, because Alice is staying home.)' },
    { frame: 14, title: 'One last guess: Eve comes',
      text: 'Nothing forces Eve either way, so we guess that Eve comes.' },
    { frame: 15, done: true, title: 'Every rule is followed!',
      text: 'The guest list: Bob, Carol, Dave and Eve. Alice and Frank stay home. That\'s how a SAT solver works: guess, follow the rules, and when something breaks, learn a new rule and back up. The full replay below shows the same run in more detail.' },
  ];

  // ---------------------------------------------------------------- drawing

  // Wide screens: one row of six friends. Phones: two rows of three, so names stay readable.
  const narrowQuery = window.matchMedia('(max-width: 560px)');
  const layout = () => narrowQuery.matches
    ? { box: '0 0 360 300', x: (v) => 60 + ((v - 1) % 3) * 120, dy: (v) => Math.floor((v - 1) / 3) * 150 }
    : { box: '0 0 660 150', x: (v) => 60 + (v - 1) * 108, dy: () => 0 };

  function friends(frame, prevFrame, step) {
    const now = new Map(frame.trail.map((t) => [Math.abs(t.lit), t]));
    const before = prevFrame ? new Map(prevFrame.trail.map((t) => [Math.abs(t.lit), t])) : new Map();
    const learned = trace.clauses[formula.clauses.length];
    const blamed = step.frame === 10 && learned ? new Set(learned.lits.map(Math.abs)) : new Set();
    const broken = step.broken ? new Set(trace.clauses[frame.conflict].lits.map(Math.abs)) : new Set();
    const parts = [];
    const { x: X, dy } = layout();
    for (let v = 1; v <= N; v++) {
      const t = now.get(v);
      const y = dy(v);
      const state = !t ? 'unknown' : t.lit > 0 ? 'in' : 'out';
      const changed = before.get(v)?.lit !== t?.lit;
      const cls = ['friend', state];
      if (changed && t) cls.push('arrive');
      if (changed && !t && before.has(v)) cls.push('reset');
      if (broken.has(v)) cls.push('clash');
      if (blamed.has(v)) cls.push('blamed');
      if (step.done) cls.push('party');
      const mark = state === 'in' ? '✓' : state === 'out' ? '✗' : '?';
      const tag = t ? (t.reason < 0 ? 'guess' : 'forced') : '';
      parts.push(`<g class="${cls.join(' ')}" style="--i:${v}">
        <g class="body">
          <circle cx="${X(v)}" cy="${74 + y}" r="25"/>
          <text class="mark" x="${X(v)}" y="${81 + y}">${mark}</text>
        </g>
        <text class="name" x="${X(v)}" y="${122 + y}">${esc(formula.names[v])}</text>
        <text class="status" x="${X(v)}" y="${140 + y}">${state === 'in' ? 'coming' : state === 'out' ? 'staying home' : ''}</text>
        ${tag ? `<g class="tag ${tag}"><rect x="${X(v) - 26}" y="${22 + y}" width="52" height="18" rx="9"/><text x="${X(v)}" y="${35 + y}">${tag === 'guess' ? '✎ guess' : 'forced'}</text></g>` : ''}
      </g>`);
    }
    return parts.join('');
  }

  function cards(frame, step) {
    const out = formula.rules.map((r, k) => {
      const cls = ['card'];
      if (step.rule === k) cls.push(step.broken ? 'broken' : 'used');
      return `<li class="${cls.join(' ')}"><span class="num">Rule ${k + 1}</span> ${esc(r)}</li>`;
    });
    if (frame.numClauses > formula.clauses.length) {
      const cls = ['card', 'learned'];
      if (step.frame === 10) cls.push('new');
      if (step.rule === 'learned') cls.push('used');
      out.push(`<li class="${cls.join(' ')}"><span class="num">Learned</span> Frank and Dave can't both come.</li>`);
    }
    return out.join('');
  }

  // ---------------------------------------------------------------- stepping

  // Count a one-off event in GoatCounter, once per visit. Ad blockers often stop GoatCounter
  // from loading, so this quietly does nothing if it isn't there.
  const counted = new Set();
  function track(name) {
    if (counted.has(name) || !window.goatcounter || !window.goatcounter.count) return;
    counted.add(name);
    window.goatcounter.count({ path: name, title: name, event: true });
  }


  let i = 0;
  let shown = -1;

  function render() {
    const step = STORY[i];
    const frame = trace.frames[step.frame];
    const prev = shown === i - 1 && i > 0 ? trace.frames[STORY[i - 1].frame] : null;
    $('story-scene').setAttribute('viewBox', layout().box);
    $('story-friends').innerHTML = friends(frame, prev, step);
    $('story-cards').innerHTML = cards(frame, step);
    $('story-count').textContent = `${i + 1} of ${STORY.length}`;
    const text = $('story-text');
    text.innerHTML = `<h3 class="${step.broken ? 'bad' : step.done ? 'good' : ''}">${esc(step.title)}</h3><p>${esc(step.text)}</p>`;
    text.classList.remove('fade');
    void text.offsetWidth;
    text.classList.add('fade');
    $('story-prev').disabled = i === 0;
    $('story-next').textContent = i === STORY.length - 1 ? 'Start over' : 'Next →';
    shown = i;
    if (step.done) track('event: finished the party story');
  }

  $('story-next').addEventListener('click', () => { i = (i + 1) % STORY.length; render(); });
  narrowQuery.addEventListener('change', () => { shown = -1; render(); });  // rotate phone / resize window
  $('story-prev').addEventListener('click', () => { if (i > 0) { i--; render(); } });
  render();

  // Exposed for the tests.
  if (typeof window !== 'undefined') window.PARTY_STORY = STORY;
})();
