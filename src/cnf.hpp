#pragma once

#include <istream>
#include <vector>

namespace logiclab {

// A formula in conjunctive normal form, using DIMACS conventions:
// variables are 1..num_vars, a literal is +v or -v.
struct CNF {
    int num_vars = 0;
    std::vector<std::vector<int>> clauses;
};

// Parses DIMACS CNF. Tolerates a missing header, clauses spanning
// several lines, a missing trailing 0, and the SATLIB '%' terminator.
// Throws std::runtime_error on malformed input.
CNF parse_dimacs(std::istream& in);

// Checks a full assignment (model[v] for v in 1..num_vars) against the formula.
bool satisfies(const CNF& cnf, const std::vector<bool>& model);

}  // namespace logiclab
