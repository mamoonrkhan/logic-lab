#!/usr/bin/env python3
"""Place N non-attacking queens on an N x N board via SAT.

usage: nqueens.py N [--cnf]
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from satlib import Formula, solve  # noqa: E402


def encode(n: int) -> Formula:
    f = Formula()
    q = lambda r, c: f.var((r, c))  # noqa: E731
    for r in range(n):
        for c in range(n):
            q(r, c)
    for i in range(n):
        f.exactly_one([q(i, c) for c in range(n)])  # one queen per row
        f.at_most_one([q(r, i) for r in range(n)])  # at most one per column
    for s in range(2 * n - 1):  # diagonals r + c = s and r - c = s - (n - 1)
        f.at_most_one([q(r, s - r) for r in range(n) if 0 <= s - r < n])
        d = s - (n - 1)
        f.at_most_one([q(r, r - d) for r in range(n) if 0 <= r - d < n])
    return f


def decode(f: Formula, model: dict[int, bool], n: int) -> list[tuple[int, int]]:
    return sorted(pos for pos, v in f.names.items() if model.get(v))


def is_valid(queens: list[tuple[int, int]], n: int) -> bool:
    return (len(queens) == n and len({r for r, _ in queens}) == n and len({c for _, c in queens}) == n
            and len({r + c for r, c in queens}) == n and len({r - c for r, c in queens}) == n)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    n = int(sys.argv[1])
    f = encode(n)
    if "--cnf" in sys.argv:
        print(f.dimacs(), end="")
        return 0
    res = solve(f.dimacs())
    print(f"{n}-queens: {f.num_vars} variables, {len(f.clauses)} clauses -> {res.status} in {res.seconds:.3f}s")
    if res.status == "SAT":
        queens = decode(f, res.model, n)
        assert is_valid(queens, n)
        if n <= 40:
            cols = dict(queens)
            for r in range(n):
                print(" ".join("Q" if cols[r] == c else "." for c in range(n)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
