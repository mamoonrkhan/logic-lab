#!/usr/bin/env python3
"""The pigeonhole principle as a SAT instance: PHP(n+1, n).

"n+1 pigeons cannot each sit in their own hole when there are only n holes" is
obviously true, and the formula is unsatisfiable. But Haken (1985) proved that any
*resolution* proof of it needs exponentially many steps. CDCL solvers are, at their
core, resolution-proof generators, so this tiny family of formulas defeats them:
watch the conflict count roughly multiply with each extra hole.

usage: pigeonhole.py N          print PHP(N+1, N) as DIMACS
       pigeonhole.py --sweep M  solve PHP(n+1, n) for n = 2..M and report growth
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from satlib import Formula, solve  # noqa: E402


def encode(holes: int) -> Formula:
    f = Formula()
    pigeons = holes + 1
    p = lambda i, j: f.var((i, j))  # noqa: E731 - pigeon i sits in hole j
    for i in range(pigeons):
        f.add([p(i, j) for j in range(holes)])  # every pigeon gets a hole
    for j in range(holes):
        f.at_most_one([p(i, j) for i in range(pigeons)])  # no hole is shared
    return f


def main() -> int:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--sweep":
        print(f"{'holes':>5} {'vars':>5} {'clauses':>7} {'conflicts':>10} {'time (s)':>9}")
        for n in range(2, int(args[1]) + 1):
            f = encode(n)
            res = solve(f.dimacs(), ["--no-model"])
            assert res.status == "UNSAT"
            print(f"{n:>5} {f.num_vars:>5} {len(f.clauses):>7} {res.stats['conflicts']:>10} {res.seconds:>9.3f}")
        return 0
    if len(args) == 1:
        print(encode(int(args[0])).dimacs(), end="")
        return 0
    print(__doc__.strip().splitlines()[-2], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
