#!/usr/bin/env python3
"""Solve a Sudoku by reducing it to SAT.

Variable x(r,c,d) means "cell (r,c) holds digit d": 729 variables. The rules become:
  - every cell holds exactly one digit
  - every row, column and 3x3 box contains each digit exactly once
  - each given clue is a unit clause

usage: sudoku.py [PUZZLE]      81 characters, digits with 0 or . for blanks
       sudoku.py --cnf PUZZLE  print the DIMACS encoding instead of solving
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from satlib import Formula, solve  # noqa: E402

# A puzzle often cited as one of the hardest for human solvers (Arto Inkala, 2012).
DEFAULT = "8..........36......7..9.2...5...7.......457.....1...3...1....68..85...1..9....4.."


def encode(puzzle: str) -> Formula:
    puzzle = puzzle.replace(".", "0")
    if len(puzzle) != 81 or not puzzle.isdigit():
        raise SystemExit("puzzle must be 81 characters of digits, with 0 or . for blanks")
    f = Formula()
    x = lambda r, c, d: f.var((r, c, d))  # noqa: E731
    R = range(9)
    for r in R:
        for c in R:
            f.exactly_one([x(r, c, d) for d in range(1, 10)])
    for d in range(1, 10):
        for i in R:
            f.exactly_one([x(i, c, d) for c in R])  # row i
            f.exactly_one([x(r, i, d) for r in R])  # column i
            br, bc = 3 * (i // 3), 3 * (i % 3)
            f.exactly_one([x(br + a, bc + b, d) for a in range(3) for b in range(3)])  # box i
    for i, ch in enumerate(puzzle):
        if ch != "0":
            f.add([x(i // 9, i % 9, int(ch))])
    return f


def decode(f: Formula, model: dict[int, bool]) -> list[list[int]]:
    grid = [[0] * 9 for _ in range(9)]
    for (r, c, d), v in f.names.items():
        if model.get(v):
            grid[r][c] = d
    return grid


def is_valid(grid: list[list[int]], puzzle: str) -> bool:
    full = set(range(1, 10))
    rows = all(set(row) == full for row in grid)
    cols = all({grid[r][c] for r in range(9)} == full for c in range(9))
    boxes = all({grid[br + a][bc + b] for a in range(3) for b in range(3)} == full
                for br in (0, 3, 6) for bc in (0, 3, 6))
    clues = all(ch in "0." or grid[i // 9][i % 9] == int(ch) for i, ch in enumerate(puzzle))
    return rows and cols and boxes and clues


def show(grid: list[list[int]]) -> str:
    lines = []
    for r, row in enumerate(grid):
        if r and r % 3 == 0:
            lines.append("------+-------+------")
        lines.append(" | ".join(" ".join(str(d) for d in row[i:i + 3]) for i in (0, 3, 6)))
    return "\n".join(lines)


def main() -> int:
    args = sys.argv[1:]
    if args and args[0] == "--cnf":
        print(encode(args[1] if len(args) > 1 else DEFAULT).dimacs(), end="")
        return 0
    puzzle = args[0] if args else DEFAULT
    f = encode(puzzle)
    res = solve(f.dimacs())
    print(f"{f.num_vars} variables, {len(f.clauses)} clauses -> {res.status} in {res.seconds:.3f}s "
          f"({res.stats.get('conflicts', '?')} conflicts)\n")
    if res.status != "SAT":
        print("no solution")
        return 1
    grid = decode(f, res.model)
    print(show(grid))
    assert is_valid(grid, puzzle)
    return 0


if __name__ == "__main__":
    sys.exit(main())
