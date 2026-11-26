#!/usr/bin/env python3
"""Test suite for logic-lab.

1. Example files with known answers.
2. Differential fuzzing: random formulas are solved by CDCL, DPLL and brute force; all
   three must agree, every SAT model is checked against the formula, and every UNSAT
   answer must come with a DRAT proof that the independent checker accepts.
3. Every solver configuration (restarts, minimization, ... switched off) on the same.
4. End-to-end checks of the problem encoders.

usage: run_tests.py [--solver PATH] [--fuzz N] [--seed S]
"""

from __future__ import annotations

import argparse
import random
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import coloring  # noqa: E402
import drat_check  # noqa: E402
import nqueens  # noqa: E402
import pigeonhole  # noqa: E402
import satlib  # noqa: E402
import sudoku  # noqa: E402

failures: list[str] = []


def check(cond: bool, msg: str) -> None:
    if not cond:
        failures.append(msg)
        print(f"  FAIL: {msg}")


def run(cnf: str, args: list[str], solver: Path) -> satlib.SolveResult:
    return satlib.solve(cnf, args, solver=solver, timeout=120)


def solve_with_proof(cnf: str, args: list[str], solver: Path) -> tuple[satlib.SolveResult, str]:
    with tempfile.NamedTemporaryFile("r", suffix=".drat") as proof:
        res = run(cnf, [*args, f"--proof={proof.name}"], solver)
        return res, proof.read()


def test_examples(solver: Path) -> None:
    print("examples")
    for path in sorted((ROOT / "examples").glob("*.cnf")):
        text = path.read_text()
        expected = "UNSAT" if "expect: UNSAT" in text else "SAT" if "expect: SAT" in text else None
        _, clauses = satlib.parse_dimacs(text)
        res, proof = solve_with_proof(text, [], solver)
        check(expected is None or res.status == expected, f"{path.name}: expected {expected}, got {res.status}")
        if res.status == "SAT":
            check(satlib.check_model(clauses, res.model), f"{path.name}: bad model")
        elif res.status == "UNSAT" and len(proof) < 2_000_000:
            ok, msg = drat_check.check(clauses, proof)
            check(ok, f"{path.name}: proof rejected: {msg}")
        print(f"  {path.name:<28} {res.status}")


def test_edge_cases(solver: Path) -> None:
    print("edge cases")
    cases = [
        ("empty formula", "p cnf 0 0\n", "SAT"),
        ("no clauses", "p cnf 3 0\n", "SAT"),
        ("empty clause", "p cnf 1 1\n0\n", "UNSAT"),
        ("contradictory units", "p cnf 1 2\n1 0\n-1 0\n", "UNSAT"),
        ("tautology only", "p cnf 1 1\n1 -1 0\n", "SAT"),
        ("duplicate literals", "p cnf 2 2\n1 1 2 0\n-1 -1 0\n", "SAT"),
        ("missing header", "1 2 0\n-1 0\n-2 0\n", "UNSAT"),
        ("multi-line clause", "p cnf 3 1\n1\n2\n3 0\n", "SAT"),
        ("no trailing zero", "p cnf 2 2\n1 0\n-1 2", "SAT"),
        ("satlib terminator", "p cnf 2 1\n1 2 0\n%\n0\n", "SAT"),
    ]
    for name, cnf, expected in cases:
        res, proof = solve_with_proof(cnf, [], solver)
        check(res.status == expected, f"{name}: expected {expected}, got {res.status}")
        if res.status == "UNSAT":
            ok, msg = drat_check.check(satlib.parse_dimacs(cnf)[1], proof)
            check(ok, f"{name}: proof rejected: {msg}")
    bad = subprocess.run([str(solver), "-"], input="p cnf 2 1\n1 x 0\n", capture_output=True, text=True)
    check(bad.returncode == 1 and "parse error" in bad.stderr, "malformed input should be rejected")
    print(f"  {len(cases) + 1} cases")


CONFIGS = [[], ["--reduce-interval=3"], ["--no-restarts"], ["--no-minimize"], ["--no-phase-saving"], ["--no-reduce"],
           ["--no-restarts", "--no-minimize", "--no-phase-saving", "--no-reduce"]]


def test_fuzz(solver: Path, count: int, seed: int) -> None:
    print(f"differential fuzzing ({count} formulas, seed {seed})")
    rng = random.Random(seed)
    tally = {"SAT": 0, "UNSAT": 0}
    for i in range(count):
        n = rng.randint(1, 16)
        k = rng.choice([1, 2, 3, 3, 3, 4])
        k = min(k, n)
        m = rng.randint(1, int(n * rng.uniform(1, 7)) + 1)
        clauses = satlib.random_ksat(n, m, k, rng)
        if rng.random() < 0.2:  # sprinkle in some unit and duplicate-literal clauses
            clauses.append([rng.choice([-1, 1]) * rng.randint(1, n)])
        cnf = satlib.to_dimacs(n, clauses)
        tag = f"#{i} (n={n}, m={len(clauses)}, k={k})"

        brute = run(cnf, ["--algo=brute"], solver)
        dpll = run(cnf, ["--algo=dpll"], solver)
        check(brute.status == dpll.status, f"{tag}: brute {brute.status} vs dpll {dpll.status}")
        tally[brute.status] += 1

        for config in (CONFIGS if i % 10 == 0 else CONFIGS[:2]):
            res, proof = solve_with_proof(cnf, config, solver)
            name = " ".join(config) or "default"
            check(res.status == brute.status, f"{tag} [{name}]: cdcl {res.status}, brute force {brute.status}\n{cnf}")
            if res.status == "SAT":
                check(satlib.check_model(clauses, res.model), f"{tag} [{name}]: model does not satisfy formula")
            elif res.status == "UNSAT":
                ok, msg = drat_check.check(clauses, proof)
                check(ok, f"{tag} [{name}]: proof rejected: {msg}")
        if failures:
            break
    print(f"  {tally['SAT']} SAT, {tally['UNSAT']} UNSAT, all solvers agree" if not failures else "  stopped")


def test_larger_random(solver: Path, seed: int) -> None:
    print("larger random 3-SAT near the phase transition (vs DPLL, proofs checked)")
    rng = random.Random(seed + 1)
    for i in range(12):
        n = rng.choice([30, 40, 50])
        clauses = satlib.random_ksat(n, round(4.26 * n), 3, rng)
        cnf = satlib.to_dimacs(n, clauses)
        dpll = run(cnf, ["--algo=dpll"], solver)
        res, proof = solve_with_proof(cnf, ["--reduce-interval=20"] if i % 2 else [], solver)
        check(res.status == dpll.status, f"random #{i}: cdcl {res.status} vs dpll {dpll.status}")
        if res.status == "SAT":
            check(satlib.check_model(clauses, res.model), f"random #{i}: bad model")
        else:
            ok, msg = drat_check.check(clauses, proof)
            check(ok, f"random #{i}: proof rejected: {msg}")
    print("  12 instances")


def test_encoders(solver: Path) -> None:
    print("encoders")
    f = sudoku.encode(sudoku.DEFAULT)
    res = run(f.dimacs(), [], solver)
    check(res.status == "SAT" and sudoku.is_valid(sudoku.decode(f, res.model), sudoku.DEFAULT), "sudoku")

    for n, expected in [(1, "SAT"), (2, "UNSAT"), (3, "UNSAT"), (4, "SAT"), (8, "SAT"), (30, "SAT")]:
        f = nqueens.encode(n)
        res = run(f.dimacs(), [], solver)
        check(res.status == expected, f"{n}-queens: expected {expected}, got {res.status}")
        if res.status == "SAT":
            check(nqueens.is_valid(nqueens.decode(f, res.model, n), n), f"{n}-queens: invalid placement")

    for holes in range(1, 7):
        f = pigeonhole.encode(holes)
        res, proof = solve_with_proof(f.dimacs(), [], solver)
        check(res.status == "UNSAT", f"pigeonhole {holes}")
        if holes <= 5:
            check(drat_check.check(f.clauses, proof)[0], f"pigeonhole {holes}: proof rejected")

    for name, g, chi in [("petersen", coloring.petersen(), 3), ("grotzsch", coloring.mycielski_k(4), 4),
                         ("queens5", coloring.queens_graph(5), 5)]:
        for k, expected in [(chi - 1, "UNSAT"), (chi, "SAT")]:
            res = run(coloring.encode(g, k).dimacs(), [], solver)
            check(res.status == expected, f"{name} {k}-coloring: expected {expected}, got {res.status}")
    print("  sudoku, n-queens, pigeonhole, graph coloring")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--solver", type=Path, default=satlib.DEFAULT_SOLVER)
    ap.add_argument("--fuzz", type=int, default=600)
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()
    solver = args.solver.resolve()
    if not solver.exists():
        print(f"solver not found at {solver}; run `make` first", file=sys.stderr)
        return 2

    test_examples(solver)
    test_edge_cases(solver)
    test_fuzz(solver, args.fuzz, args.seed)
    test_larger_random(solver, args.seed)
    test_encoders(solver)

    print()
    if failures:
        print(f"{len(failures)} FAILURE(S)")
        return 1
    print("all tests passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
