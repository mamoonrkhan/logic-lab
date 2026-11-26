#include "cnf.hpp"

#include <cstdlib>
#include <sstream>
#include <stdexcept>
#include <string>

namespace logiclab {

namespace {
constexpr long kMaxVar = 1L << 28;

[[noreturn]] void fail(int lineno, const std::string& msg) {
    throw std::runtime_error("line " + std::to_string(lineno) + ": " + msg);
}
}  // namespace

CNF parse_dimacs(std::istream& in) {
    CNF cnf;
    std::vector<int> current;
    std::string line;
    int lineno = 0;

    while (std::getline(in, line)) {
        ++lineno;
        const size_t start = line.find_first_not_of(" \t\r");
        if (start == std::string::npos) continue;
        const char first = line[start];
        if (first == 'c') continue;
        if (first == '%') break;  // SATLIB end-of-file marker

        if (first == 'p') {
            std::istringstream ss(line.substr(start + 1));
            std::string fmt;
            long vars = -1, clauses = -1;
            ss >> fmt >> vars >> clauses;
            if (fmt != "cnf" || vars < 0 || clauses < 0 || vars > kMaxVar) {
                fail(lineno, "malformed header, expected 'p cnf <vars> <clauses>'");
            }
            cnf.num_vars = static_cast<int>(vars);
            cnf.clauses.reserve(static_cast<size_t>(clauses));
            continue;
        }

        std::istringstream ss(line);
        std::string tok;
        while (ss >> tok) {
            char* end = nullptr;
            const long v = std::strtol(tok.c_str(), &end, 10);
            if (end == tok.c_str() || *end != '\0') fail(lineno, "unexpected token '" + tok + "'");
            if (v == 0) {
                cnf.clauses.push_back(current);
                current.clear();
                continue;
            }
            const long a = v < 0 ? -v : v;
            if (a > kMaxVar) fail(lineno, "variable index too large");
            if (a > cnf.num_vars) cnf.num_vars = static_cast<int>(a);
            current.push_back(static_cast<int>(v));
        }
    }
    if (!current.empty()) cnf.clauses.push_back(current);
    return cnf;
}

bool satisfies(const CNF& cnf, const std::vector<bool>& model) {
    for (const auto& clause : cnf.clauses) {
        bool sat = false;
        for (int lit : clause) {
            const bool value = model[static_cast<size_t>(lit < 0 ? -lit : lit)];
            if ((lit > 0) == value) {
                sat = true;
                break;
            }
        }
        if (!sat) return false;
    }
    return true;
}

}  // namespace logiclab
