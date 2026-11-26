// logiclab: a CDCL SAT solver.
//
// Output follows the SAT Competition conventions: an "s" status line, "v" model
// lines, "c" comments, and exit code 10 (SAT), 20 (UNSAT) or 0 (unknown).

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <string>

#include "cdcl.hpp"
#include "cnf.hpp"
#include "reference.hpp"

using namespace logiclab;

namespace {

void usage() {
    std::cerr <<
        "usage: logiclab [options] <file.cnf | ->\n"
        "\n"
        "  --algo=cdcl|dpll|brute   solving algorithm (default: cdcl)\n"
        "  --proof=FILE             write a DRAT proof of unsatisfiability (cdcl)\n"
        "  --stats                  print search statistics\n"
        "  --max-conflicts=N        give up after N conflicts (cdcl)\n"
        "  --restarts=glucose|luby|none\n"
        "                           restart policy (cdcl, default: glucose)\n"
        "  --no-restarts            same as --restarts=none\n"
        "  --no-minimize            disable learned-clause minimization (cdcl)\n"
        "  --no-phase-saving        disable phase saving (cdcl)\n"
        "  --no-reduce              never delete learned clauses (cdcl)\n"
        "  --reduce-interval=N      conflicts between learned-clause cleanups (cdcl, default 2000)\n"
        "  --no-model               do not print the satisfying assignment\n"
        "  --lbd-window=N           glucose: recent learned clauses to average (default 50)\n"
        "  --block-after=N          glucose: conflicts before restart blocking starts (default 10000)\n"
        "  -h, --help               show this help\n";
}

bool starts_with(const char* s, const char* prefix, const char** rest) {
    const size_t n = std::strlen(prefix);
    if (std::strncmp(s, prefix, n) != 0) return false;
    *rest = s + n;
    return true;
}

void print_model(const std::vector<bool>& model) {
    std::string line = "v";
    for (size_t v = 1; v < model.size(); ++v) {
        std::string tok = " " + std::string(model[v] ? "" : "-") + std::to_string(v);
        if (line.size() + tok.size() > 78) {
            std::cout << line << '\n';
            line = "v";
        }
        line += tok;
    }
    std::cout << line << " 0\n";
}

}  // namespace

int main(int argc, char** argv) {
    std::ios::sync_with_stdio(false);

    std::string algo = "cdcl", input, proof_path;
    bool show_stats = false, show_model = true;
    SolverOptions opts;

    for (int i = 1; i < argc; ++i) {
        const char* a = argv[i];
        const char* rest = nullptr;
        if (!std::strcmp(a, "-h") || !std::strcmp(a, "--help")) { usage(); return 0; }
        else if (starts_with(a, "--algo=", &rest)) algo = rest;
        else if (starts_with(a, "--proof=", &rest)) proof_path = rest;
        else if (starts_with(a, "--max-conflicts=", &rest)) opts.conflict_limit = std::stoull(rest);
        else if (starts_with(a, "--reduce-interval=", &rest)) opts.reduce_interval = std::max<uint64_t>(1, std::stoull(rest));
        else if (!std::strcmp(a, "--stats")) show_stats = true;
        else if (!std::strcmp(a, "--no-model")) show_model = false;
        else if (!std::strcmp(a, "--no-restarts")) opts.restarts = RestartPolicy::None;
        else if (starts_with(a, "--restarts=", &rest)) {
            if (!std::strcmp(rest, "glucose")) opts.restarts = RestartPolicy::Glucose;
            else if (!std::strcmp(rest, "luby")) opts.restarts = RestartPolicy::Luby;
            else if (!std::strcmp(rest, "none")) opts.restarts = RestartPolicy::None;
            else { std::cerr << "unknown restart policy: " << rest << "\n"; return 1; }
        }
        else if (starts_with(a, "--lbd-window=", &rest)) opts.lbd_window = std::max(1, std::stoi(rest));
        else if (starts_with(a, "--block-after=", &rest)) opts.block_after = std::stoull(rest);
        else if (!std::strcmp(a, "--no-minimize")) opts.minimize = false;
        else if (!std::strcmp(a, "--no-phase-saving")) opts.phase_saving = false;
        else if (!std::strcmp(a, "--no-reduce")) opts.reduce_db = false;
        else if (a[0] == '-' && a[1] != '\0') { std::cerr << "unknown option: " << a << "\n"; usage(); return 1; }
        else input = a;
    }
    if (input.empty()) { usage(); return 1; }
    if (algo != "cdcl" && algo != "dpll" && algo != "brute") {
        std::cerr << "unknown algorithm: " << algo << "\n";
        return 1;
    }

    CNF cnf;
    try {
        if (input == "-") {
            cnf = parse_dimacs(std::cin);
        } else {
            std::ifstream f(input);
            if (!f) { std::cerr << "cannot open " << input << "\n"; return 1; }
            cnf = parse_dimacs(f);
        }
    } catch (const std::exception& e) {
        std::cerr << "parse error: " << e.what() << "\n";
        return 1;
    }

    std::cout << "c logic-lab (" << algo << "): " << cnf.num_vars << " variables, "
              << cnf.clauses.size() << " clauses\n";

    std::unique_ptr<std::ofstream> proof;
    if (!proof_path.empty()) {
        proof = std::make_unique<std::ofstream>(proof_path);
        if (!*proof) { std::cerr << "cannot write " << proof_path << "\n"; return 1; }
        opts.proof = proof.get();
    }

    const auto t0 = std::chrono::steady_clock::now();
    Result result = Result::UNKNOWN;
    std::vector<bool> model;
    Stats stats;
    uint64_t ref_count = 0;

    try {
        if (algo == "cdcl") {
            Solver solver(cnf, opts);
            result = solver.solve();
            stats = solver.stats();
            model = solver.model();
        } else {
            const bool sat = algo == "dpll" ? solve_dpll(cnf, model, ref_count)
                                            : solve_brute_force(cnf, model, ref_count);
            result = sat ? Result::SAT : Result::UNSAT;
        }
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 1;
    }
    const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    if (result == Result::SAT && !satisfies(cnf, model)) {
        std::cerr << "internal error: model does not satisfy the formula\n";
        return 1;
    }

    if (show_stats) {
        char buf[64];
        std::snprintf(buf, sizeof buf, "%.3f", secs);
        std::cout << "c time            " << buf << " s\n";
        if (algo == "cdcl") {
            const double avg = stats.learned ? double(stats.learned_literals) / double(stats.learned) : 0.0;
            std::snprintf(buf, sizeof buf, "%.1f", avg);
            std::cout << "c decisions       " << stats.decisions << "\n"
                      << "c propagations    " << stats.propagations << "\n"
                      << "c conflicts       " << stats.conflicts << "\n"
                      << "c restarts        " << stats.restarts << " (" << stats.blocked_restarts << " blocked)\n"
                      << "c learned         " << stats.learned << " (" << stats.learned_units << " units, avg "
                      << buf << " literals)\n"
                      << "c minimized lits  " << stats.minimized_literals << "\n"
                      << "c deleted         " << stats.deleted << " in " << stats.db_reductions << " reductions\n";
            if (secs > 0) {
                std::snprintf(buf, sizeof buf, "%.0f", double(stats.conflicts) / secs);
                std::cout << "c conflicts/sec   " << buf << "\n";
            }
        } else {
            std::cout << "c " << (algo == "dpll" ? "decisions       " : "assignments     ") << ref_count << "\n";
        }
    }

    switch (result) {
        case Result::SAT:
            std::cout << "s SATISFIABLE\n";
            if (show_model) print_model(model);
            return 10;
        case Result::UNSAT:
            std::cout << "s UNSATISFIABLE\n";
            return 20;
        case Result::UNKNOWN:
            std::cout << "s UNKNOWN\n";
            return 0;
    }
    return 0;
}
