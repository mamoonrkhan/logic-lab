#pragma once

#include <cstdint>
#include <vector>

#include "cnf.hpp"

namespace logiclab {

// Simple solvers kept around as baselines and as test oracles for the CDCL solver.

// Truth-table enumeration: checks all 2^n assignments. Refuses n > 30.
bool solve_brute_force(const CNF& cnf, std::vector<bool>& model, uint64_t& assignments_tried);

// Classic DPLL (Davis-Putnam-Logemann-Loveland, 1962): unit propagation, pure literal
// elimination and chronological backtracking. No learning, no backjumping.
bool solve_dpll(const CNF& cnf, std::vector<bool>& model, uint64_t& decisions);

}  // namespace logiclab
