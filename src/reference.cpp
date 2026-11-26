#include "reference.hpp"

#include <stdexcept>

namespace logiclab {

bool solve_brute_force(const CNF& cnf, std::vector<bool>& model, uint64_t& tried) {
    const int n = cnf.num_vars;
    if (n > 30) throw std::runtime_error("brute force refuses formulas with more than 30 variables");
    model.assign(static_cast<size_t>(n) + 1, false);
    tried = 0;
    for (uint64_t mask = 0; mask < (uint64_t{1} << n); ++mask) {
        ++tried;
        for (int v = 1; v <= n; ++v) model[static_cast<size_t>(v)] = (mask >> (v - 1)) & 1;
        if (satisfies(cnf, model)) return true;
    }
    return false;
}

namespace {

// assignment: 0 = unassigned, 1 = true, -1 = false; indexed by DIMACS variable.
using Assignment = std::vector<int8_t>;

int8_t lit_value(const Assignment& a, int lit) {
    const int8_t v = a[static_cast<size_t>(lit < 0 ? -lit : lit)];
    return lit < 0 ? static_cast<int8_t>(-v) : v;
}

void set_true(Assignment& a, int lit) { a[static_cast<size_t>(lit < 0 ? -lit : lit)] = lit < 0 ? -1 : 1; }

// Returns false on conflict. Sets `branch` to an unassigned literal from an
// unsatisfied clause, or 0 if every clause is satisfied.
bool simplify(const CNF& cnf, Assignment& a, int& branch) {
    const int n = cnf.num_vars;
    for (;;) {
        bool changed = false;
        branch = 0;
        std::vector<int8_t> pos(static_cast<size_t>(n) + 1, 0), negs(static_cast<size_t>(n) + 1, 0);

        for (const auto& clause : cnf.clauses) {
            int unassigned = 0, last = 0;
            bool sat = false;
            for (int lit : clause) {
                const int8_t v = lit_value(a, lit);
                if (v == 1) { sat = true; break; }
                if (v == 0) { ++unassigned; last = lit; }
            }
            if (sat) continue;
            if (unassigned == 0) return false;  // clause falsified
            if (unassigned == 1) {               // unit clause: forced
                set_true(a, last);
                changed = true;
                continue;
            }
            for (int lit : clause) {
                if (lit_value(a, lit) != 0) continue;
                (lit > 0 ? pos : negs)[static_cast<size_t>(lit < 0 ? -lit : lit)] = 1;
                if (!branch) branch = lit;
            }
        }
        if (changed) continue;

        // Pure literals: a variable appearing with only one polarity among the
        // unsatisfied clauses can be set to satisfy all of them.
        for (int v = 1; v <= n; ++v) {
            if (a[static_cast<size_t>(v)] != 0) continue;
            if (pos[static_cast<size_t>(v)] && !negs[static_cast<size_t>(v)]) { a[static_cast<size_t>(v)] = 1; changed = true; }
            else if (negs[static_cast<size_t>(v)] && !pos[static_cast<size_t>(v)]) { a[static_cast<size_t>(v)] = -1; changed = true; }
        }
        if (!changed) return true;
    }
}

bool dpll(const CNF& cnf, Assignment& a, uint64_t& decisions) {
    int branch = 0;
    if (!simplify(cnf, a, branch)) return false;
    if (branch == 0) return true;
    for (int lit : {branch, -branch}) {
        ++decisions;
        Assignment copy = a;
        set_true(copy, lit);
        if (dpll(cnf, copy, decisions)) {
            a = std::move(copy);
            return true;
        }
    }
    return false;
}

}  // namespace

bool solve_dpll(const CNF& cnf, std::vector<bool>& model, uint64_t& decisions) {
    Assignment a(static_cast<size_t>(cnf.num_vars) + 1, 0);
    decisions = 0;
    const bool sat = dpll(cnf, a, decisions);
    model.assign(static_cast<size_t>(cnf.num_vars) + 1, false);
    if (sat) {
        for (int v = 1; v <= cnf.num_vars; ++v) model[static_cast<size_t>(v)] = a[static_cast<size_t>(v)] == 1;
    }
    return sat;
}

}  // namespace logiclab
