#!/usr/bin/env python3
"""Graph coloring and chromatic numbers via SAT.

A k-coloring assigns each vertex one of k colors so that adjacent vertices differ.
To compute the chromatic number chi(G), ask "is G k-colorable?" for k = 1, 2, ...
The first SAT answer gives a coloring (an upper bound you can check by eye), and the
UNSAT answer just before it comes with a DRAT proof (a lower bound you can verify
mechanically with tools/drat_check.py). Together they *prove* chi(G) = k.

usage: coloring.py petersen | grotzsch | mycielski K | queens N | random N P [SEED]
       coloring.py --cnf K GRAPH...   print the k-coloring CNF instead
"""

from __future__ import annotations

import itertools
import random
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import drat_check  # noqa: E402
from satlib import Formula, solve  # noqa: E402

Graph = tuple[int, list[tuple[int, int]]]  # (vertex count, edge list)


def petersen() -> Graph:
    outer = [(i, (i + 1) % 5) for i in range(5)]
    spokes = [(i, i + 5) for i in range(5)]
    inner = [(5 + i, 5 + (i + 2) % 5) for i in range(5)]
    return 10, outer + spokes + inner


def mycielski(g: Graph) -> Graph:
    """Mycielski's construction: triangle-free in, triangle-free out, chi goes up by one."""
    n, edges = g
    new = list(edges)
    for u, v in edges:
        new += [(u, n + v), (v, n + u)]
    new += [(n + i, 2 * n) for i in range(n)]
    return 2 * n + 1, new


def mycielski_k(k: int) -> Graph:
    """The k-th Mycielski graph: triangle-free with chromatic number k."""
    g: Graph = (2, [(0, 1)])
    for _ in range(k - 2):
        g = mycielski(g)
    return g


def queens_graph(n: int) -> Graph:
    cells = [(r, c) for r in range(n) for c in range(n)]
    idx = {cell: i for i, cell in enumerate(cells)}
    edges = []
    for (a, b), (c, d) in itertools.combinations(cells, 2):
        if a == c or b == d or abs(a - c) == abs(b - d):
            edges.append((idx[(a, b)], idx[(c, d)]))
    return n * n, edges


def random_graph(n: int, p: float, seed: int = 0) -> Graph:
    rng = random.Random(seed)
    return n, [(u, v) for u, v in itertools.combinations(range(n), 2) if rng.random() < p]


def encode(g: Graph, k: int) -> Formula:
    n, edges = g
    f = Formula()
    x = lambda v, c: f.var((v, c))  # noqa: E731
    for v in range(n):
        f.add([x(v, c) for c in range(k)])  # every vertex gets a color
        f.at_most_one([x(v, c) for c in range(k)])
    for u, v in edges:
        for c in range(k):
            f.add([-x(u, c), -x(v, c)])
    if n:  # symmetry breaking: colors are interchangeable, so fix vertex 0's color
        f.add([x(0, 0)])
    return f


def parse_graph(args: list[str]) -> tuple[str, Graph]:
    kind = args[0]
    if kind == "petersen":
        return "Petersen graph", petersen()
    if kind == "grotzsch":
        return "Grötzsch graph", mycielski_k(4)
    if kind == "mycielski":
        k = int(args[1])
        return f"Mycielski graph M{k}", mycielski_k(k)
    if kind == "queens":
        n = int(args[1])
        return f"{n}x{n} queens graph", queens_graph(n)
    if kind == "random":
        n, p = int(args[1]), float(args[2])
        seed = int(args[3]) if len(args) > 3 else 0
        return f"G({n}, {p}) seed {seed}", random_graph(n, p, seed)
    raise SystemExit(__doc__)


def chromatic_number(name: str, g: Graph) -> int:
    n, edges = g
    print(f"{name}: {n} vertices, {len(edges)} edges")
    for k in range(1, n + 1):
        f = encode(g, k)
        with tempfile.NamedTemporaryFile("r", suffix=".drat") as proof:
            res = solve(f.dimacs(), [f"--proof={proof.name}"])
            if res.status == "SAT":
                colors = {v: c for (v, c), var in f.names.items() if res.model.get(var)}
                assert all(colors[u] != colors[v] for u, v in edges)
                print(f"  k={k}: SAT    found a {k}-coloring ({res.stats['conflicts']} conflicts)")
                print(f"  chi = {k}")
                return k
            verdict = "skipped (large)"
            proof_text = proof.read()
            if len(proof_text) < 200_000:
                ok, _ = drat_check.check(f.clauses, proof_text)
                verdict = "proof verified" if ok else "PROOF REJECTED"
            print(f"  k={k}: UNSAT  no {k}-coloring ({res.stats['conflicts']} conflicts, {verdict})")
    return n


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    if args[0] == "--cnf":
        k = int(args[1])
        _, g = parse_graph(args[2:])
        print(encode(g, k).dimacs(), end="")
        return 0
    chromatic_number(*parse_graph(args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
