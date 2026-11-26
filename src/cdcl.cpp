#include "cdcl.hpp"

#include <algorithm>
#include <cmath>
#include <cstring>

namespace logiclab {

namespace {

inline int var_of(int lit) { return lit >> 1; }
inline int neg(int lit) { return lit ^ 1; }
inline int from_dimacs(int d) { return d > 0 ? 2 * (d - 1) : 2 * (-d - 1) + 1; }
inline int to_dimacs(int lit) { return (lit & 1) ? -(var_of(lit) + 1) : var_of(lit) + 1; }

// The Luby sequence 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,... scaled by powers of y.
// Restarting on this schedule is within a log factor of the optimal universal strategy
// (Luby, Sinclair & Zuckerman, 1993).
double luby(double y, uint64_t x) {
    uint64_t size = 1;
    int seq = 0;
    while (size < x + 1) {
        ++seq;
        size = 2 * size + 1;
    }
    while (size - 1 != x) {
        size = (size - 1) >> 1;
        --seq;
        x = x % size;
    }
    return std::pow(y, seq);
}

}  // namespace

// ---------------------------------------------------------------- heap

void Solver::VarHeap::insert(int v) {
    if (contains(v)) return;
    pos_[static_cast<size_t>(v)] = static_cast<int>(heap_.size());
    heap_.push_back(v);
    sift_up(pos_[static_cast<size_t>(v)]);
}

void Solver::VarHeap::increased(int v) {
    if (contains(v)) sift_up(pos_[static_cast<size_t>(v)]);
}

int Solver::VarHeap::pop() {
    const int top = heap_[0];
    const int last = heap_.back();
    heap_.pop_back();
    pos_[static_cast<size_t>(top)] = -1;
    if (!heap_.empty()) {
        heap_[0] = last;
        pos_[static_cast<size_t>(last)] = 0;
        sift_down(0);
    }
    return top;
}

void Solver::VarHeap::sift_up(int i) {
    const int v = heap_[static_cast<size_t>(i)];
    while (i > 0) {
        const int p = (i - 1) / 2;
        if (!better(v, heap_[static_cast<size_t>(p)])) break;
        heap_[static_cast<size_t>(i)] = heap_[static_cast<size_t>(p)];
        pos_[static_cast<size_t>(heap_[static_cast<size_t>(i)])] = i;
        i = p;
    }
    heap_[static_cast<size_t>(i)] = v;
    pos_[static_cast<size_t>(v)] = i;
}

void Solver::VarHeap::sift_down(int i) {
    const int v = heap_[static_cast<size_t>(i)];
    const int n = static_cast<int>(heap_.size());
    for (;;) {
        int c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && better(heap_[static_cast<size_t>(c + 1)], heap_[static_cast<size_t>(c)])) ++c;
        if (!better(heap_[static_cast<size_t>(c)], v)) break;
        heap_[static_cast<size_t>(i)] = heap_[static_cast<size_t>(c)];
        pos_[static_cast<size_t>(heap_[static_cast<size_t>(i)])] = i;
        i = c;
    }
    heap_[static_cast<size_t>(i)] = v;
    pos_[static_cast<size_t>(v)] = i;
}

// ---------------------------------------------------------------- setup

Solver::Solver(const CNF& cnf, SolverOptions opts)
    : n_(cnf.num_vars),
      opts_(opts),
      watches_(2 * static_cast<size_t>(cnf.num_vars)),
      assign_(static_cast<size_t>(cnf.num_vars), kUndef),
      level_(static_cast<size_t>(cnf.num_vars), 0),
      reason_(static_cast<size_t>(cnf.num_vars), -1),
      polarity_(static_cast<size_t>(cnf.num_vars), 1),
      activity_(static_cast<size_t>(cnf.num_vars), 0.0),
      heap_(activity_),
      seen_(static_cast<size_t>(cnf.num_vars), 0),
      level_stamp_(static_cast<size_t>(cnf.num_vars) + 1, 0),
      next_reduce_(opts.reduce_interval) {
    heap_.reserve(n_);
    for (int v = 0; v < n_; ++v) heap_.insert(v);
    arena_.reserve(cnf.clauses.size() * 6);
    for (const auto& c : cnf.clauses) {
        add_input_clause(c);
        if (!ok_) break;
    }
}

void Solver::add_input_clause(const std::vector<int>& dimacs) {
    std::vector<int> ls;
    ls.reserve(dimacs.size());
    for (int d : dimacs) ls.push_back(from_dimacs(d));
    std::sort(ls.begin(), ls.end());
    ls.erase(std::unique(ls.begin(), ls.end()), ls.end());
    // After sorting, x and ~x are adjacent (2v, 2v+1): such a clause is a tautology.
    for (size_t i = 1; i < ls.size(); ++i) {
        if (ls[i] == neg(ls[i - 1])) return;
    }

    if (ls.empty()) {
        ok_ = false;
        return;
    }
    if (ls.size() == 1) {
        const int8_t v = value(ls[0]);
        if (v == kFalse) ok_ = false;
        else if (v == kUndef) enqueue(ls[0], -1);
        return;
    }
    const int cref = alloc_clause(ls, false, 0);
    originals_.push_back(cref);
    attach(cref);
}

int Solver::alloc_clause(const std::vector<int>& ls, bool learnt, int lbd_value) {
    const int cref = static_cast<int>(arena_.size());
    arena_.push_back(static_cast<int>(ls.size()));
    arena_.push_back((learnt ? 1 : 0) | (lbd_value << 2));
    arena_.push_back(0);  // activity 0.0f
    arena_.insert(arena_.end(), ls.begin(), ls.end());
    return cref;
}

float Solver::activity(int cref) const {
    float a;
    std::memcpy(&a, &arena_[static_cast<size_t>(cref) + 2], sizeof a);
    return a;
}

void Solver::set_activity(int cref, float a) {
    std::memcpy(&arena_[static_cast<size_t>(cref) + 2], &a, sizeof a);
}

void Solver::attach(int cref) {
    const int* c = lits(cref);
    watches_[static_cast<size_t>(c[0])].push_back({cref, c[1]});
    watches_[static_cast<size_t>(c[1])].push_back({cref, c[0]});
}

void Solver::enqueue(int lit, int reason) {
    const size_t v = static_cast<size_t>(var_of(lit));
    assign_[v] = (lit & 1) ? kFalse : kTrue;
    level_[v] = decision_level();
    reason_[v] = reason;
    trail_.push_back(lit);
}

// ---------------------------------------------------------------- propagation

// Two-watched-literal unit propagation. Every clause watches two of its literals,
// stored in lits[0] and lits[1]. A clause only needs attention when a watched literal
// becomes false: then we look for a replacement watch; if there is none, the clause
// is either unit (propagate the other watch) or falsified (conflict).
// Backtracking needs no watch updates at all, which is what makes this scheme fast.
int Solver::propagate() {
    while (qhead_ < trail_.size()) {
        const int p = trail_[qhead_++];
        const int false_lit = neg(p);
        auto& ws = watches_[static_cast<size_t>(false_lit)];

        size_t i = 0, j = 0;
        while (i < ws.size()) {
            const Watcher w = ws[i++];
            if (value(w.blocker) == kTrue) {
                ws[j++] = w;
                continue;
            }
            int* c = lits(w.cref);
            const int sz = size(w.cref);

            if (c[0] == false_lit) std::swap(c[0], c[1]);
            const int first = c[0];
            const Watcher nw{w.cref, first};
            if (first != w.blocker && value(first) == kTrue) {
                ws[j++] = nw;
                continue;
            }

            bool moved = false;
            for (int k = 2; k < sz; ++k) {
                if (value(c[k]) != kFalse) {
                    std::swap(c[1], c[k]);
                    watches_[static_cast<size_t>(c[1])].push_back(nw);
                    moved = true;
                    break;
                }
            }
            if (moved) continue;

            ws[j++] = nw;
            if (value(first) == kFalse) {
                while (i < ws.size()) ws[j++] = ws[i++];
                ws.resize(j);
                qhead_ = trail_.size();
                return w.cref;
            }
            enqueue(first, w.cref);
            ++stats_.propagations;
        }
        ws.resize(j);
    }
    return -1;
}

// ---------------------------------------------------------------- conflict analysis

// First-UIP conflict analysis. Starting from the falsified clause, repeatedly resolve
// on the most recently assigned current-level literal with its reason clause, until
// exactly one literal of the current decision level remains: the first Unique
// Implication Point. The result is a clause implied by the formula (it is derived by
// resolution) that becomes unit right after backjumping.
void Solver::analyze(int confl, std::vector<int>& out, int& bt_level, int& lbd) {
    out.clear();
    out.push_back(-1);  // placeholder for the asserting literal
    int path_count = 0;
    int p = -1;
    int idx = static_cast<int>(trail_.size()) - 1;

    do {
        if (is_learnt(confl)) bump_clause(confl);
        const int* c = lits(confl);
        const int sz = size(confl);
        for (int j = (p == -1) ? 0 : 1; j < sz; ++j) {
            const int q = c[j];
            const size_t v = static_cast<size_t>(var_of(q));
            if (!seen_[v] && level_[v] > 0) {
                bump_var(static_cast<int>(v));
                seen_[v] = 1;
                if (level_[v] >= decision_level()) ++path_count;
                else out.push_back(q);
            }
        }
        while (!seen_[static_cast<size_t>(var_of(trail_[static_cast<size_t>(idx)]))]) --idx;
        p = trail_[static_cast<size_t>(idx)];
        --idx;
        confl = reason_[static_cast<size_t>(var_of(p))];
        seen_[static_cast<size_t>(var_of(p))] = 0;
        --path_count;
    } while (path_count > 0);
    out[0] = neg(p);

    if (opts_.minimize) minimize(out);
    else for (size_t i = 1; i < out.size(); ++i) seen_[static_cast<size_t>(var_of(out[i]))] = 0;

    // Backjump to the second-highest decision level in the clause, and keep that
    // literal in position 1 so the two watches are the asserting literal and it.
    if (out.size() == 1) {
        bt_level = 0;
    } else {
        size_t max_i = 1;
        for (size_t i = 2; i < out.size(); ++i) {
            if (level_[static_cast<size_t>(var_of(out[i]))] > level_[static_cast<size_t>(var_of(out[max_i]))]) max_i = i;
        }
        std::swap(out[1], out[max_i]);
        bt_level = level_[static_cast<size_t>(var_of(out[1]))];
    }

    ++stamp_;
    lbd = 0;
    for (int l : out) {
        const size_t lv = static_cast<size_t>(level_[static_cast<size_t>(var_of(l))]);
        if (level_stamp_[lv] != stamp_) {
            level_stamp_[lv] = stamp_;
            ++lbd;
        }
    }
}

// Remove literals whose reason clause is already covered by the learned clause:
// if ~l was implied by (~l | a | b) and a, b are already in the clause (or false at
// level 0), then resolving on l shortens the clause without changing what it says.
void Solver::minimize(std::vector<int>& clause) {
    const std::vector<int> to_clear(clause.begin() + 1, clause.end());
    size_t j = 1;
    for (size_t i = 1; i < clause.size(); ++i) {
        const int r = reason_[static_cast<size_t>(var_of(clause[i]))];
        bool keep = true;
        if (r >= 0) {
            keep = false;
            const int* c = lits(r);
            const int sz = size(r);
            for (int k = 1; k < sz; ++k) {
                const size_t u = static_cast<size_t>(var_of(c[k]));
                if (!seen_[u] && level_[u] > 0) {
                    keep = true;
                    break;
                }
            }
        }
        if (keep) clause[j++] = clause[i];
    }
    stats_.minimized_literals += clause.size() - j;
    clause.resize(j);
    for (int l : to_clear) seen_[static_cast<size_t>(var_of(l))] = 0;
}

// ---------------------------------------------------------------- search

void Solver::backtrack(int level) {
    if (decision_level() <= level) return;
    const int stop = trail_lim_[static_cast<size_t>(level)];
    for (int i = static_cast<int>(trail_.size()) - 1; i >= stop; --i) {
        const int lit = trail_[static_cast<size_t>(i)];
        const size_t v = static_cast<size_t>(var_of(lit));
        assign_[v] = kUndef;
        reason_[v] = -1;
        if (opts_.phase_saving) polarity_[v] = static_cast<int8_t>(lit & 1);
        heap_.insert(static_cast<int>(v));
    }
    trail_.resize(static_cast<size_t>(stop));
    trail_lim_.resize(static_cast<size_t>(level));
    qhead_ = trail_.size();
}

int Solver::pick_branch() {
    while (!heap_.empty()) {
        const int v = heap_.pop();
        if (assign_[static_cast<size_t>(v)] == kUndef) return 2 * v + polarity_[static_cast<size_t>(v)];
    }
    return -1;
}

void Solver::bump_var(int v) {
    double& a = activity_[static_cast<size_t>(v)];
    a += var_inc_;
    if (a > 1e100) {
        for (double& x : activity_) x *= 1e-100;
        var_inc_ *= 1e-100;
    }
    heap_.increased(v);
}

void Solver::bump_clause(int cref) {
    const float a = activity(cref) + static_cast<float>(cla_inc_);
    set_activity(cref, a);
    if (a > 1e20f) {
        for (int r : learnts_) set_activity(r, activity(r) * 1e-20f);
        cla_inc_ *= 1e-20;
    }
}

bool Solver::locked(int cref) const {
    const int l0 = lits(cref)[0];
    return reason_[static_cast<size_t>(var_of(l0))] == cref && value(l0) == kTrue;
}

// Learned clauses accumulate quickly and slow propagation down. Keep the ones that
// look useful: low LBD ("glue" clauses, Audemard & Simon 2009) and recently active.
void Solver::reduce_db() {
    ++stats_.db_reductions;
    std::sort(learnts_.begin(), learnts_.end(), [this](int a, int b) {
        if (lbd(a) != lbd(b)) return lbd(a) < lbd(b);
        return activity(a) > activity(b);
    });
    const size_t half = learnts_.size() / 2;
    size_t j = 0;
    for (size_t i = 0; i < learnts_.size(); ++i) {
        const int cref = learnts_[i];
        if (i < half || lbd(cref) <= 2 || locked(cref)) {
            learnts_[j++] = cref;
            continue;
        }
        proof_delete(std::vector<int>(lits(cref), lits(cref) + size(cref)));
        arena_[static_cast<size_t>(cref) + 1] |= 2;
        ++stats_.deleted;
    }
    learnts_.resize(j);
    collect_garbage();
}

// Compact the arena: copy live clauses into a fresh array, then fix up every cref
// (clause lists, reasons) and rebuild the watch lists.
void Solver::collect_garbage() {
    std::vector<int> fresh;
    fresh.reserve(arena_.size());
    auto relocate = [&](int& cref) {
        const int moved = static_cast<int>(fresh.size());
        const auto begin = arena_.begin() + cref;
        fresh.insert(fresh.end(), begin, begin + kHeader + size(cref));
        arena_[static_cast<size_t>(cref) + 2] = moved;  // forwarding address in the old copy
        cref = moved;
    };
    for (int& cref : originals_) relocate(cref);
    for (int& cref : learnts_) relocate(cref);
    for (int& r : reason_) {
        if (r >= 0) r = arena_[static_cast<size_t>(r) + 2];
    }
    arena_.swap(fresh);
    for (auto& ws : watches_) ws.clear();
    for (int cref : originals_) attach(cref);
    for (int cref : learnts_) attach(cref);
}

Result Solver::search(uint64_t conflict_budget) {
    uint64_t conflicts_here = 0;
    std::vector<int> learnt;

    for (;;) {
        const int confl = propagate();
        if (confl >= 0) {
            ++stats_.conflicts;
            ++conflicts_here;
            if (decision_level() == 0) return Result::UNSAT;

            int bt_level = 0, lbd = 0;
            analyze(confl, learnt, bt_level, lbd);
            backtrack(bt_level);
            proof_add(learnt);
            ++stats_.learned;
            stats_.learned_literals += learnt.size();

            if (learnt.size() == 1) {
                ++stats_.learned_units;
                enqueue(learnt[0], -1);
            } else {
                const int cref = alloc_clause(learnt, true, lbd);
                attach(cref);
                learnts_.push_back(cref);
                bump_clause(cref);
                enqueue(learnt[0], cref);
            }
            var_inc_ /= opts_.var_decay;
            cla_inc_ /= opts_.clause_decay;

            if (opts_.conflict_limit && stats_.conflicts >= opts_.conflict_limit) {
                backtrack(0);
                return Result::UNKNOWN;
            }
        } else {
            if (opts_.restarts && conflicts_here >= conflict_budget) {
                backtrack(0);
                return Result::UNKNOWN;
            }
            if (opts_.reduce_db && stats_.conflicts >= next_reduce_) {
                next_reduce_ = stats_.conflicts + opts_.reduce_interval + opts_.reduce_interval * 3 / 20 * stats_.db_reductions;
                reduce_db();
            }
            const int next = pick_branch();
            if (next < 0) return Result::SAT;
            ++stats_.decisions;
            trail_lim_.push_back(static_cast<int>(trail_.size()));
            enqueue(next, -1);
        }
    }
}

Result Solver::solve() {
    Result r = ok_ ? Result::UNKNOWN : Result::UNSAT;
    while (r == Result::UNKNOWN) {
        const auto budget = static_cast<uint64_t>(luby(2.0, stats_.restarts) * opts_.restart_base);
        r = search(budget);
        if (r == Result::UNKNOWN) {
            if (opts_.conflict_limit && stats_.conflicts >= opts_.conflict_limit) break;
            ++stats_.restarts;
        }
    }

    if (r == Result::UNSAT) {
        proof_add({});  // the empty clause closes a DRAT refutation
    } else if (r == Result::SAT) {
        model_.assign(static_cast<size_t>(n_) + 1, false);
        for (int v = 0; v < n_; ++v) model_[static_cast<size_t>(v) + 1] = assign_[static_cast<size_t>(v)] == kTrue;
    }
    if (opts_.proof) opts_.proof->flush();
    return r;
}

// ---------------------------------------------------------------- DRAT proof output

void Solver::proof_add(const std::vector<int>& lits) {
    if (!opts_.proof) return;
    for (int l : lits) *opts_.proof << to_dimacs(l) << ' ';
    *opts_.proof << "0\n";
}

void Solver::proof_delete(const std::vector<int>& lits) {
    if (!opts_.proof) return;
    *opts_.proof << "d ";
    for (int l : lits) *opts_.proof << to_dimacs(l) << ' ';
    *opts_.proof << "0\n";
}

}  // namespace logiclab
