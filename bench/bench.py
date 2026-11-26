#!/usr/bin/env python3
"""Experiments for logic-lab. Writes bench/RESULTS.md and SVG charts into docs/.

  phase     the random 3-SAT phase transition (satisfiability and hardness vs. m/n)
  scaling   DPLL vs CDCL on random 3-SAT at the threshold as n grows
  php       pigeonhole formulas: exponential growth predicted by Haken's theorem
  ablation  what each CDCL feature is worth
  restarts  Glucose vs Luby vs no restarts, including SATLIB industrial instances

usage: bench.py [phase|scaling|php|ablation ...] [--quick]
"""

from __future__ import annotations

import argparse
import os
import platform
import random
import statistics
import subprocess
import sys
import tarfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

import coloring  # noqa: E402
import pigeonhole  # noqa: E402
import satlib  # noqa: E402

DOCS = ROOT / "docs"
RESULTS = ROOT / "bench" / "RESULTS.md"
WORKERS = max(1, (os.cpu_count() or 2) // 2)


def run(cnf: str, args: list[str], timeout: float) -> tuple[str, float, int]:
    """Returns (status, wall seconds, conflicts); status is TIMEOUT if the limit was hit."""
    t0 = time.perf_counter()
    try:
        res = satlib.solve(cnf, ["--no-model", *args], timeout=timeout)
    except subprocess.TimeoutExpired:
        return "TIMEOUT", timeout, -1
    return res.status, time.perf_counter() - t0, int(res.stats.get("conflicts", "0").split()[0])


# ------------------------------------------------------------------ SVG charts

PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#9333ea"]


def line_chart(path: Path, title: str, xlabel: str, ylabel: str, series: list[tuple[str, list[tuple[float, float]]]],
               log_y: bool = False, y_range: tuple[float, float] | None = None, vline: float | None = None) -> None:
    import math
    W, H, L, R, T, B = 640, 380, 70, 150, 40, 50
    pw, ph = W - L - R, H - T - B
    xs = [x for _, pts in series for x, _ in pts]
    ys = [y for _, pts in series for _, y in pts if not log_y or y > 0]
    x0, x1 = min(xs), max(xs)
    tf = (lambda v: math.log10(max(v, 1e-9))) if log_y else (lambda v: v)
    if y_range:
        y0, y1 = y_range
    elif log_y:
        y0, y1 = math.floor(tf(min(ys))), math.ceil(tf(max(ys)))
    else:
        y0, y1 = 0.0, max(ys) * 1.05
    sx = lambda x: L + (x - x0) / (x1 - x0 or 1) * pw  # noqa: E731
    sy = lambda y: T + ph - ((tf(y) if not y_range or log_y else y) - y0) / (y1 - y0 or 1) * ph  # noqa: E731

    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" font-family="system-ui, sans-serif" font-size="12">',
           '<style>text{fill:#334155} .grid{stroke:#e2e8f0} .axis{stroke:#94a3b8}</style>',
           f'<rect width="{W}" height="{H}" fill="#ffffff"/>',
           f'<text x="{L}" y="24" font-size="15" font-weight="600">{title}</text>']
    ticks = range(int(y0), int(y1) + 1) if log_y else [y0 + i * (y1 - y0) / 5 for i in range(6)]
    for t in ticks:
        y = T + ph - (t - y0) / (y1 - y0 or 1) * ph
        label = (f"10^{int(t)}" if log_y else (f"{t:.0%}" if y_range == (0, 1) else f"{t:.3g}"))
        out.append(f'<line class="grid" x1="{L}" x2="{L + pw}" y1="{y:.1f}" y2="{y:.1f}"/>')
        out.append(f'<text x="{L - 8}" y="{y + 4:.1f}" text-anchor="end">{label}</text>')
    xt = sorted(set(xs))
    step = max(1, len(xt) // 8)
    for x in xt[::step]:
        out.append(f'<text x="{sx(x):.1f}" y="{T + ph + 18}" text-anchor="middle">{x:g}</text>')
    if vline is not None:
        out.append(f'<line x1="{sx(vline):.1f}" x2="{sx(vline):.1f}" y1="{T}" y2="{T + ph}" stroke="#64748b" stroke-dasharray="4 4"/>')
        out.append(f'<text x="{sx(vline) + 4:.1f}" y="{T + 12}" fill="#64748b">{vline:g}</text>')
    out.append(f'<line class="axis" x1="{L}" x2="{L}" y1="{T}" y2="{T + ph}"/>')
    out.append(f'<line class="axis" x1="{L}" x2="{L + pw}" y1="{T + ph}" y2="{T + ph}"/>')
    out.append(f'<text x="{L + pw / 2}" y="{H - 10}" text-anchor="middle">{xlabel}</text>')
    out.append(f'<text transform="translate(16 {T + ph / 2}) rotate(-90)" text-anchor="middle">{ylabel}</text>')
    for i, (name, pts) in enumerate(series):
        color = PALETTE[i % len(PALETTE)]
        pts = [(x, y) for x, y in pts if not log_y or y > 0]
        d = " ".join(f"{'M' if j == 0 else 'L'}{sx(x):.1f},{sy(y):.1f}" for j, (x, y) in enumerate(pts))
        out.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="2"/>')
        out.extend(f'<circle cx="{sx(x):.1f}" cy="{sy(y):.1f}" r="2.5" fill="{color}"/>' for x, y in pts)
        ly = T + 10 + i * 20
        out.append(f'<line x1="{L + pw + 16}" x2="{L + pw + 36}" y1="{ly}" y2="{ly}" stroke="{color}" stroke-width="2"/>')
        out.append(f'<text x="{L + pw + 42}" y="{ly + 4}">{name}</text>')
    out.append("</svg>")
    path.write_text("\n".join(out) + "\n")


# ------------------------------------------------------------------ experiments

def phase(quick: bool) -> str:
    sizes = [50, 100] if quick else [50, 100, 150]
    per_point = 30 if quick else 80
    ratios = [round(3.0 + 0.2 * i, 1) for i in range(16)]
    sat_series, hard_series = [], []
    rows = []
    for n in sizes:
        rng = random.Random(n)
        jobs = [(r, satlib.to_dimacs(n, satlib.random_ksat(n, round(r * n), 3, rng))) for r in ratios for _ in range(per_point)]
        with ThreadPoolExecutor(WORKERS) as pool:
            results = list(pool.map(lambda j: (j[0], run(j[1], [], 120)), jobs))
        sat_pts, hard_pts = [], []
        for r in ratios:
            rs = [res for ratio, res in results if ratio == r]
            frac = sum(s == "SAT" for s, _, _ in rs) / len(rs)
            med = statistics.median(c for _, _, c in rs)
            sat_pts.append((r, frac))
            hard_pts.append((r, max(med, 1)))
            rows.append((n, r, frac, med))
        sat_series.append((f"n = {n}", sat_pts))
        hard_series.append((f"n = {n}", hard_pts))
        print(f"  phase n={n} done")
    line_chart(DOCS / "phase-transition.svg", "Random 3-SAT: probability of satisfiability", "clauses / variables",
               "fraction satisfiable", sat_series, y_range=(0, 1), vline=4.26)
    line_chart(DOCS / "hardness.svg", "Random 3-SAT: hardness peaks at the threshold", "clauses / variables",
               "median conflicts (log)", hard_series, log_y=True, vline=4.26)

    md = [f"## Phase transition\n\n{per_point} random 3-SAT formulas per point.\n",
          "![phase transition](../docs/phase-transition.svg)\n", "![hardness](../docs/hardness.svg)\n",
          "| n | m/n | % SAT | median conflicts |", "|---:|---:|---:|---:|"]
    md += [f"| {n} | {r} | {f:.0%} | {c:g} |" for n, r, f, c in rows if r in (3.0, 3.6, 4.0, 4.2, 4.4, 4.8, 5.4, 6.0)]
    return "\n".join(md) + "\n"


def scaling(quick: bool) -> str:
    sizes = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250] if not quick else [25, 50, 75, 100, 150]
    per = 10 if quick else 20
    limits = {"DPLL": 10.0, "CDCL": 10.0 if quick else 60.0}
    rows, series = [], {"DPLL": [], "CDCL": []}
    dpll_dead = False
    for n in sizes:
        rng = random.Random(1000 + n)
        cnfs = [satlib.to_dimacs(n, satlib.random_ksat(n, round(4.26 * n), 3, rng)) for _ in range(per)]
        row = [n]
        for algo, args in [("DPLL", ["--algo=dpll"]), ("CDCL", [])]:
            if algo == "DPLL" and dpll_dead:
                row.append("—")
                continue
            with ThreadPoolExecutor(WORKERS) as pool:
                times = list(pool.map(lambda c: run(c, args, limits[algo]), cnfs))
            solved = [t for s, t, _ in times if s != "TIMEOUT"]
            med = statistics.median(t for _, t, _ in times)
            if len(solved) < per / 2:
                row.append(f"timeout ({len(solved)}/{per} solved)")
                if algo == "DPLL":
                    dpll_dead = True
                continue
            series[algo].append((n, max(med, 1e-3)))
            row.append(f"{med * 1000:.1f} ms" + ("" if len(solved) == per else f" ({len(solved)}/{per} solved)"))
        rows.append(row)
        print(f"  scaling n={n}: {row[1:]}")
    line_chart(DOCS / "scaling.svg", "Random 3-SAT at m/n = 4.26: DPLL vs CDCL", "variables",
               "median wall time, s (log)", [(k, v) for k, v in series.items() if v], log_y=True)
    md = [f"## DPLL vs CDCL\n\n{per} random 3-SAT formulas per size at the threshold (m = 4.26n), "
          f"limit {limits['DPLL']:g}s (DPLL) / {limits['CDCL']:g}s (CDCL) per run, median wall time including process startup.\n",
          "![scaling](../docs/scaling.svg)\n", "| n | DPLL | CDCL |", "|---:|---:|---:|"]
    md += [f"| {r[0]} | {r[1]} | {r[2]} |" for r in rows]
    return "\n".join(md) + "\n"


def php(quick: bool) -> str:
    top = 9 if quick else 11
    rows, pts = [], []
    for holes in range(3, top + 1):
        f = pigeonhole.encode(holes)
        status, secs, conflicts = run(f.dimacs(), [], 600)
        rows.append((holes, f.num_vars, len(f.clauses), conflicts, secs, status))
        if conflicts > 0:
            pts.append((holes, conflicts))
        print(f"  php {holes}: {status} {conflicts} conflicts {secs:.2f}s")
        if status == "TIMEOUT":
            break
    line_chart(DOCS / "pigeonhole.svg", "Pigeonhole PHP(n+1, n): exponential, as Haken predicted", "holes n",
               "conflicts (log)", [("CDCL", pts)], log_y=True)
    md = ["## Pigeonhole principle\n\nPHP(n+1, n) is unsatisfiable for every n, but every resolution "
          "refutation has exponential size (Haken 1985). CDCL can't escape that lower bound.\n",
          "![pigeonhole](../docs/pigeonhole.svg)\n",
          "| holes | vars | clauses | conflicts | time | ratio |", "|---:|---:|---:|---:|---:|---:|"]
    prev = None
    for h, v, c, k, s, st in rows:
        ratio = f"×{k / prev:.1f}" if prev and k > 0 else ""
        md.append(f"| {h} | {v} | {c} | {k if k >= 0 else st} | {s:.2f}s | {ratio} |")
        prev = k if k > 0 else None
    return "\n".join(md) + "\n"


def ablation(quick: bool) -> str:
    rng = random.Random(7)
    n, count = (150, 8) if quick else (200, 16)
    suite = [(f"random 3-SAT n={n} (x{count})",
              [satlib.to_dimacs(n, satlib.random_ksat(n, round(4.26 * n), 3, rng)) for _ in range(count)]),
             ("pigeonhole PHP(10,9)", [pigeonhole.encode(9).dimacs()]),
             ("7x7 queens graph, 7 colors", [coloring.encode(coloring.queens_graph(7), 7).dimacs()]),
             ("Mycielski M6, 5 colors", [coloring.encode(coloring.mycielski_k(6), 5).dimacs()])]
    configs = [("full solver", []), ("Luby restarts instead", ["--restarts=luby"]), ("no restarts", ["--no-restarts"]),
               ("no minimization", ["--no-minimize"]),
               ("no phase saving", ["--no-phase-saving"]), ("no clause deletion", ["--no-reduce"])]
    limit = 30.0 if quick else 60.0
    header = "| configuration | " + " | ".join(name for name, _ in suite) + " |"
    md = [f"## Ablation\n\nTotal wall time summed over each family's instances ({limit:g}s limit per instance; "
          "conflicts in parentheses).\n", header, "|---" + "|---:" * len(suite) + "|"]
    for cname, args in configs:
        cells = []
        for _, cnfs in suite:
            with ThreadPoolExecutor(WORKERS) as pool:
                res = list(pool.map(lambda c: run(c, args, limit), cnfs))
            timeouts = sum(s == "TIMEOUT" for s, _, _ in res)
            total = sum(t for _, t, _ in res)
            conflicts = sum(k for _, _, k in res if k > 0)
            cells.append(f"{total:.2f}s ({conflicts:,})" + (f", {timeouts} timeout" if timeouts else ""))
        md.append(f"| {cname} | " + " | ".join(cells) + " |")
        print(f"  ablation {cname}: {cells}")
    return "\n".join(md) + "\n"


SATLIB_URL = "https://www.cs.ubc.ca/~hoos/SATLIB/Benchmarks/SAT/"
SATLIB_FAMILIES = {
    "bounded model checking (bmc)": "BMC/bmc.tar.gz",
    "circuit fault analysis (bf)": "DIMACS/BF/bf.tar.gz",
    "circuit fault analysis (ssa)": "DIMACS/SSA/ssa.tar.gz",
    "planning: logistics": "PLANNING/Logistics/logistics.tar.gz",
    "planning: blocks world": "PLANNING/BlocksWorld/blocksworld.tar.gz",
}


def satlib_family(path: str) -> list[str]:
    """Downloads (once) and returns the CNF files of a SATLIB benchmark family."""
    dest = ROOT / "bench" / "satlib" / Path(path).name.replace(".tar.gz", "")
    if not dest.exists():
        dest.mkdir(parents=True)
        archive = dest.with_suffix(".tar.gz")
        print(f"  downloading {SATLIB_URL + path}")
        urllib.request.urlretrieve(SATLIB_URL + path, archive)
        with tarfile.open(archive) as tar:
            members = [m for m in tar.getmembers() if m.isfile() and m.name.endswith(".cnf")]
            for m in members:
                m.name = Path(m.name).name  # flatten, and never write outside dest
                tar.extract(m, dest)
        archive.unlink()
    return [f.read_text() for f in sorted(dest.glob("*.cnf"))]


def restarts(quick: bool) -> str:
    rng = random.Random(11)
    n, count = (200, 8) if quick else (250, 16)
    suite = [(f"random 3-SAT n={n} (×{count})",
              [satlib.to_dimacs(n, satlib.random_ksat(n, round(4.26 * n), 3, rng)) for _ in range(count)]),
             ("pigeonhole PHP(10,9)", [pigeonhole.encode(9).dimacs()]),
             ("Mycielski M6, 5 colors", [coloring.encode(coloring.mycielski_k(6), 5).dimacs()])]
    for name, path in SATLIB_FAMILIES.items():
        cnfs = satlib_family(path)
        suite.append((f"{name} (×{len(cnfs)})", cnfs))
    policies = ["glucose", "luby", "none"]
    limit = 60.0 if quick else 300.0
    md = ["## Restart policies\n\nTotal wall time per family "
          f"({limit:g}s limit per instance; a timeout counts as the full limit). "
          "SATLIB instances: https://www.cs.ubc.ca/~hoos/SATLIB/\n",
          "| family | Glucose | Luby | none |", "|---|---:|---:|---:|"]
    for name, cnfs in suite:
        cells = []
        for pol in policies:
            with ThreadPoolExecutor(WORKERS) as pool:
                res = list(pool.map(lambda c: run(c, [f"--restarts={pol}"], limit), cnfs))
            timeouts = sum(s == "TIMEOUT" for s, _, _ in res)
            cells.append(f"{sum(t for _, t, _ in res):.2f}s" + (f" ({timeouts} timeout)" if timeouts else ""))
        md.append(f"| {name} | " + " | ".join(cells) + " |")
        print(f"  restarts {name}: {cells}")
    return "\n".join(md) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("experiments", nargs="*", default=["phase", "scaling", "php", "ablation", "restarts"])
    ap.add_argument("--quick", action="store_true")
    args = ap.parse_args()
    DOCS.mkdir(exist_ok=True)
    cpu = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip() \
        if platform.system() == "Darwin" else platform.processor()
    sections = [f"# Benchmark results\n\nGenerated by `make bench` on {cpu or platform.machine()} "
                f"({platform.system()}), {time.strftime('%Y-%m-%d')}.\n"]
    for name in args.experiments:
        print(name)
        sections.append({"phase": phase, "scaling": scaling, "php": php, "ablation": ablation,
                         "restarts": restarts}[name](args.quick))
    RESULTS.write_text("\n".join(sections))
    print(f"wrote {RESULTS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
