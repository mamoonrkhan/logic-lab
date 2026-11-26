#!/usr/bin/env python3
"""An independent, deliberately simple checker for DRAT proofs of unsatisfiability.

A solver saying "UNSAT" is just a claim. A proof makes it checkable: it lists every
clause the solver learned, in order. Each one must be RUP ("reverse unit propagation"):
assuming every literal of the new clause is false and running unit propagation on the
clauses known so far must reach a contradiction. If the sequence ends in the empty
clause, the original formula is unsatisfiable, and you only had to trust this short
file, not the solver.

(Full DRAT also allows RAT lemmas. This solver only emits RUP lemmas, so this checker
only accepts those. For big proofs, use drat-trim: https://github.com/marijnheule/drat-trim)

usage: drat_check.py formula.cnf proof.drat
"""

from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from satlib import parse_dimacs  # noqa: E402


def _key(clause: list[int]) -> tuple[int, ...]:
    return tuple(sorted(set(clause)))


def is_rup(clauses: list[tuple[int, ...]], lemma: tuple[int, ...]) -> bool:
    true = {-l for l in lemma}
    if any(-l in true for l in true):
        return True  # tautology
    changed = True
    while changed:
        changed = False
        for clause in clauses:
            unassigned = None
            count = 0
            satisfied = False
            for l in clause:
                if l in true:
                    satisfied = True
                    break
                if -l not in true:
                    count += 1
                    unassigned = l
                    if count > 1:
                        break
            if satisfied or count > 1:
                continue
            if count == 0:
                return True  # conflict reached
            true.add(unassigned)
            changed = True
    return False


def check(formula: list[list[int]], proof_text: str) -> tuple[bool, str]:
    db: Counter[tuple[int, ...]] = Counter(_key(c) for c in formula)
    lemmas = 0
    for lineno, line in enumerate(proof_text.splitlines(), 1):
        toks = line.split()
        if not toks or toks[0] == "c":
            continue
        delete = toks[0] == "d"
        lits = [int(t) for t in toks[1 if delete else 0:]]
        if not lits or lits[-1] != 0:
            return False, f"line {lineno}: clause not terminated by 0"
        clause = _key(lits[:-1])
        if delete:
            if db[clause] > 0:
                db[clause] -= 1
            continue
        live = [c for c, n in db.items() if n > 0]
        if not is_rup(live, clause):
            return False, f"line {lineno}: lemma {list(clause)} is not RUP"
        lemmas += 1
        if not clause:
            return True, f"verified: {lemmas} lemmas, ending in the empty clause"
        db[clause] += 1
    return False, "proof does not derive the empty clause"


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    _, formula = parse_dimacs(Path(sys.argv[1]).read_text())
    ok, msg = check(formula, Path(sys.argv[2]).read_text())
    print(("s VERIFIED" if ok else "s NOT VERIFIED") + f"\nc {msg}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
