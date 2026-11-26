# logic-lab

A SAT solver I wrote from scratch in C++, a page that lets you watch it work, and a few
experiments I ran with it.

I got into CS through a discrete math class. SAT is where a lot of that class turns into
running code: propositional logic, proofs by resolution, the pigeonhole principle, graph
coloring. This project is me following that thread.

**[Watch the solver step by step →](https://mamoonrkhan.github.io/logic-lab/)**

[![The visualizer, partway through working out a conflict](docs/visualizer.png)](https://mamoonrkhan.github.io/logic-lab/)

## What SAT is

You get a formula made of variables that can be true or false, written as a list of
clauses. Each clause is a few things joined by "or", for example `x1 or not x2 or x3`.
The question is whether some true/false assignment makes every clause true at once.

That sounds like a toy problem, but a huge number of other problems can be translated
into it: Sudoku, scheduling, graph coloring, checking that a circuit is correct, and
working out which package versions are compatible. So a fast SAT solver ends up being a
general-purpose problem solver. It's also the first problem ever proven NP-complete, so
nobody knows a way to solve it quickly in every case. Real solvers still handle
formulas with millions of variables, and figuring out how was the fun part.

## What's in here

- **`src/`**: the solver. It uses CDCL (conflict-driven clause learning), the same basic
  design as MiniSat. When it can't find a solution, it can write out a proof that
  there isn't one.
- **`docs/`**: the visualizer above, plus charts. It runs a small JavaScript copy of
  the solver.
- **`tools/`**: scripts that turn puzzles into SAT and decode the answer:
  Sudoku, N-queens, the pigeonhole principle, and graph coloring. There's also a
  standalone proof checker.
- **`tests/`**: tests that throw thousands of random formulas at the solver and
  compare its answers against a brute-force solver and a simpler DPLL solver.
- **`bench/`**: the experiments below.

## Running it

You need a C++17 compiler and Python 3. Node.js is only needed for the visualizer tests.

```sh
make
./build/logiclab examples/textbook.cnf

python3 tools/sudoku.py               # solves a famously hard Sudoku
python3 tools/nqueens.py 12
python3 tools/coloring.py petersen    # finds the chromatic number, with proof

make test       # the main test suite
make test-viz   # checks the visualizer's solver against the C++ one
make bench      # reruns the experiments (takes 30-60 minutes)
```

The solver reads the standard DIMACS file format, so it also works on files from the
[SAT Competition](https://satcompetition.github.io/). Run `./build/logiclab --help` to
see the options.

## How the solver works

It keeps repeating four things:

1. **Guess.** Pick a variable that isn't set and give it a value.
2. **Follow the consequences.** If a clause has every literal false except one, that
   last one has to be true. Setting it can force others, and so on.
3. **When something breaks, figure out why.** Eventually some clause can't be
   satisfied anymore. The solver traces back through the chain of "this forced that"
   to the guesses that caused it, and turns that into a new clause. That new clause
   rules out the bad combination for good.
4. **Jump back.** Undo the guesses that caused the problem, *and* any guesses that
   had nothing to do with it. Older algorithms only back up one guess at a time.

Step 3 is resolution, the proof rule from logic class. Every clause the solver learns
is a resolution step, so when it says "no solution", it has really built a proof. With
`--proof=FILE` it writes that proof out, and `tools/drat_check.py` checks it without
trusting the solver at all.

The visualizer shows all of this happening on small examples. It's probably easier to
understand there than from this description.

## What I found

These experiments are in [bench/](bench/). Full numbers are in
[bench/RESULTS.md](bench/RESULTS.md).

**Learning makes a huge difference.** I ran the full solver and a plain backtracking
solver (DPLL) on the same random formulas. At 150 variables, DPLL takes about 7 seconds
per formula and the full solver takes 15 ms. DPLL stops finishing at all around 175
variables. The full solver gets to 250.

![DPLL vs CDCL](docs/scaling.svg)

**Random formulas have a "phase transition".** Make random 3-SAT formulas with
different numbers of clauses per variable. With few clauses per variable they almost
always have a solution, and with many they almost never do. The switch happens around
4.26, and it gets sharper as the formulas get bigger. The hardest formulas sit right at the switch point: there are nearly 400×
more conflicts there than at 3 clauses per variable. Nobody has proven exactly where
the threshold is. It's still an open problem.

![phase transition](docs/phase-transition.svg)
![hardness](docs/hardness.svg)

**The pigeonhole principle is a wall.** "You can't fit n+1 pigeons into n holes" is
something you can prove by hand in one line. Written as a SAT formula, though, Haken
proved in 1985 that any resolution proof of it needs exponentially many steps. Since
this solver's proofs are resolution proofs, that's a hard limit on how fast it can be,
and the measurements show it. Every extra hole multiplies the work by about 4 to 10.
11 pigeons in 10 holes takes 70 seconds, and 12 in 11 didn't finish in 10 minutes.

![pigeonhole](docs/pigeonhole.svg)

**Not every trick helps.** I turned each feature off one at a time:

| | random formulas (n=200) | pigeonhole (10 into 9) | Mycielski graph, 5 colors |
|---|---:|---:|---:|
| everything on | 2.4 s | 3.9 s | 7.9 s |
| no restarts | 2.3 s | 0.65 s | 1.9 s |
| no clause shrinking | 2.0 s | 7.2 s | 18.1 s |
| no remembered phases | 2.9 s | 7.0 s | 15.5 s |
| never forget learned clauses | 3.0 s | 18.3 s | 16.2 s |

Most of the features matter on the structured problems. Restarts made two of them 4
to 6 times *slower*, which surprised me. The likely reason is that restarting throws
away a proof that was almost done. Newer solvers decide when to restart based on how
the search is going (Glucose-style restarts), and that's probably what I'll add next.

## How I know the answers are right

- Every "has a solution" answer is checked by plugging the solution back into the
  formula.
- Every "no solution" answer in the tests comes with a proof, and a separate
  100-line checker verifies it.
- The tests compare the solver against brute force and DPLL on thousands of random
  formulas, with each feature turned on and off.
- CI runs everything on Linux and macOS, and again with AddressSanitizer and UBSan
  turned on to catch memory bugs.

## Things I read

- Marques-Silva and Sakallah, *GRASP* (1999): where clause learning comes from
- Moskewicz et al., *Chaff* (2001): watched literals and VSIDS
- Eén and Sörensson, *An Extensible SAT-solver* (2003): MiniSat
- Audemard and Simon, *Glucose* (2009): judging which learned clauses to keep
- Haken, *The Intractability of Resolution* (1985): the pigeonhole result
- Mitchell, Selman and Levesque, *Hard and Easy Distributions of SAT Problems* (1992)
- Biere, Heule, van Maaren and Walsh (eds.), *Handbook of Satisfiability* (2021)

MIT license.
