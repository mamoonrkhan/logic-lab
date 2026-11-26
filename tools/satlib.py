"""Shared helpers: writing DIMACS, running the solver, parsing its output."""

from __future__ import annotations

import os
import random
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SOLVER = ROOT / "build" / "logiclab"


class Formula:
    """A CNF formula under construction. Variables are allocated by name."""

    def __init__(self) -> None:
        self.num_vars = 0
        self.clauses: list[list[int]] = []
        self.names: dict[object, int] = {}

    def var(self, name: object) -> int:
        if name not in self.names:
            self.num_vars += 1
            self.names[name] = self.num_vars
        return self.names[name]

    def add(self, clause: list[int]) -> None:
        self.clauses.append(list(clause))

    def exactly_one(self, lits: list[int]) -> None:
        self.add(lits)
        self.at_most_one(lits)

    def at_most_one(self, lits: list[int]) -> None:
        # Pairwise encoding: for every pair, not both.
        for i in range(len(lits)):
            for j in range(i + 1, len(lits)):
                self.add([-lits[i], -lits[j]])

    def dimacs(self) -> str:
        return to_dimacs(self.num_vars, self.clauses)


def to_dimacs(num_vars: int, clauses: list[list[int]], comment: str | None = None) -> str:
    out = []
    if comment:
        out.extend(f"c {line}" for line in comment.splitlines())
    out.append(f"p cnf {num_vars} {len(clauses)}")
    out.extend(" ".join(map(str, c)) + " 0" for c in clauses)
    return "\n".join(out) + "\n"


def parse_dimacs(text: str) -> tuple[int, list[list[int]]]:
    num_vars, clauses, cur = 0, [], []
    for line in text.splitlines():
        line = line.strip()
        if not line or line[0] == "c":
            continue
        if line[0] == "%":
            break
        if line[0] == "p":
            num_vars = int(line.split()[2])
            continue
        for tok in line.split():
            v = int(tok)
            if v == 0:
                clauses.append(cur)
                cur = []
            else:
                num_vars = max(num_vars, abs(v))
                cur.append(v)
    if cur:
        clauses.append(cur)
    return num_vars, clauses


def random_ksat(num_vars: int, num_clauses: int, k: int = 3, rng: random.Random | None = None) -> list[list[int]]:
    rng = rng or random.Random()
    clauses = []
    for _ in range(num_clauses):
        vs = rng.sample(range(1, num_vars + 1), k)
        clauses.append([v if rng.random() < 0.5 else -v for v in vs])
    return clauses


@dataclass
class SolveResult:
    status: str  # "SAT", "UNSAT" or "UNKNOWN"
    model: dict[int, bool] = field(default_factory=dict)
    stats: dict[str, str] = field(default_factory=dict)
    seconds: float | None = None
    output: str = ""


def solver_path() -> Path:
    return Path(os.environ.get("LOGICLAB", DEFAULT_SOLVER))


def solve(cnf: str, args: list[str] | None = None, solver: Path | None = None,
          timeout: float | None = None) -> SolveResult:
    """Run the solver on DIMACS text. Raises subprocess.TimeoutExpired on timeout."""
    exe = solver or solver_path()
    if not exe.exists():
        raise SystemExit(f"solver not found at {exe}; run `make` first")
    proc = subprocess.run([str(exe), "--stats", *(args or []), "-"], input=cnf, capture_output=True,
                          text=True, timeout=timeout)
    if proc.returncode not in (0, 10, 20):
        raise RuntimeError(f"solver failed ({proc.returncode}):\n{proc.stderr}")
    return parse_output(proc.stdout)


def parse_output(text: str) -> SolveResult:
    res = SolveResult(status="UNKNOWN", output=text)
    for line in text.splitlines():
        if line.startswith("s "):
            res.status = {"SATISFIABLE": "SAT", "UNSATISFIABLE": "UNSAT"}.get(line[2:].strip(), "UNKNOWN")
        elif line.startswith("v "):
            for tok in line[2:].split():
                v = int(tok)
                if v:
                    res.model[abs(v)] = v > 0
        elif line.startswith("c ") and not line.startswith("c logic-lab"):
            parts = line[2:].split(None, 1)
            if len(parts) == 2:
                res.stats[parts[0]] = parts[1].strip()
    if "time" in res.stats:
        res.seconds = float(res.stats["time"].split()[0])
    return res


def check_model(clauses: list[list[int]], model: dict[int, bool]) -> bool:
    return all(any(model.get(abs(l), False) == (l > 0) for l in c) for c in clauses)
