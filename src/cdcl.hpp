#pragma once

#include <cstdint>
#include <ostream>
#include <vector>

#include "cnf.hpp"

namespace logiclab {

enum class Result { SAT, UNSAT, UNKNOWN };

enum class RestartPolicy {
    None,
    Luby,     // restart after a fixed schedule of conflicts: 1,1,2,1,1,2,4,... x restart_base
    Glucose,  // restart when recent learned clauses are worse than average (Audemard & Simon)
};

struct Stats {
    uint64_t decisions = 0;
    uint64_t propagations = 0;
    uint64_t conflicts = 0;
    uint64_t restarts = 0;
    uint64_t blocked_restarts = 0;
    uint64_t learned = 0;
    uint64_t learned_units = 0;
    uint64_t deleted = 0;
    uint64_t learned_literals = 0;
    uint64_t minimized_literals = 0;
    uint64_t db_reductions = 0;
};

struct SolverOptions {
    double var_decay = 0.95;       // VSIDS decay factor
    double clause_decay = 0.999;   // learned-clause activity decay
    RestartPolicy restarts = RestartPolicy::Glucose;
    int restart_base = 100;        // Luby: conflicts per unit of the sequence
    int lbd_window = 50;           // Glucose: how many recent LBDs make up the "recent" average
    double restart_margin = 0.8;   // Glucose: restart when recent avg * margin > overall avg
    int trail_window = 5000;       // Glucose: recent trail sizes used for restart blocking
    double block_margin = 1.4;     // Glucose: block a restart if the trail is this much above average
    uint64_t block_after = 10000;  // Glucose: no blocking before this many conflicts
    bool phase_saving = true;
    bool minimize = true;          // learned-clause minimization
    bool reduce_db = true;         // periodically delete low-quality learned clauses
    uint64_t reduce_interval = 2000;  // conflicts before the first reduction (grows by 15% of it each time)
    uint64_t conflict_limit = 0;   // 0 = unlimited; otherwise give up with UNKNOWN
    std::ostream* proof = nullptr; // if set, a DRAT proof is written here
};

// Conflict-Driven Clause Learning SAT solver.
//
// Literals are encoded internally as 2*var + sign (var is 0-based, sign 1 = negated),
// so the negation of a literal is lit ^ 1.
class Solver {
public:
    explicit Solver(const CNF& cnf, SolverOptions opts = {});

    Result solve();

    // After SAT: model()[v] is the value of DIMACS variable v (index 0 unused).
    const std::vector<bool>& model() const { return model_; }
    const Stats& stats() const { return stats_; }

private:
    // Clauses live back to back in one flat array (the "arena") and are addressed by
    // their offset, a "cref". This keeps propagation cache-friendly: visiting a clause
    // is one memory access, not a pointer chase into a separately allocated vector.
    //
    //   arena_[cref + 0]   number of literals
    //   arena_[cref + 1]   flags: bit 0 learnt, bit 1 deleted, bits 2.. LBD
    //   arena_[cref + 2]   activity (float bits)
    //   arena_[cref + 3..] literals
    static constexpr int kHeader = 3;

    struct Watcher {
        int cref;
        int blocker;  // some other literal of the clause; if true, skip the clause
    };

    // Max-heap of variables ordered by VSIDS activity.
    class VarHeap {
    public:
        explicit VarHeap(const std::vector<double>& activity) : act_(activity) {}
        void reserve(int n) { pos_.assign(static_cast<size_t>(n), -1); }
        bool empty() const { return heap_.empty(); }
        bool contains(int v) const { return pos_[static_cast<size_t>(v)] >= 0; }
        void insert(int v);
        void increased(int v);
        int pop();

    private:
        bool better(int a, int b) const { return act_[a] > act_[b]; }
        void sift_up(int i);
        void sift_down(int i);
        const std::vector<double>& act_;
        std::vector<int> heap_;
        std::vector<int> pos_;
    };

    // Fixed-size window over the most recent values, with a running sum.
    class Window {
    public:
        void resize(int n) { buf_.assign(static_cast<size_t>(n > 0 ? n : 1), 0); clear(); }
        void clear() { size_ = 0; head_ = 0; sum_ = 0; }
        bool full() const { return size_ == buf_.size(); }
        double average() const { return size_ ? double(sum_) / double(size_) : 0.0; }
        void push(uint64_t x) {
            if (full()) sum_ -= buf_[head_];
            else ++size_;
            buf_[head_] = x;
            sum_ += x;
            head_ = (head_ + 1) % buf_.size();
        }

    private:
        std::vector<uint64_t> buf_;
        size_t size_ = 0, head_ = 0;
        uint64_t sum_ = 0;
    };

    static constexpr int8_t kUndef = 0, kTrue = 1, kFalse = -1;

    int8_t value(int lit) const {
        const int8_t a = assign_[static_cast<size_t>(lit >> 1)];
        return (lit & 1) ? static_cast<int8_t>(-a) : a;
    }
    int decision_level() const { return static_cast<int>(trail_lim_.size()); }

    int* lits(int cref) { return &arena_[static_cast<size_t>(cref) + kHeader]; }
    const int* lits(int cref) const { return &arena_[static_cast<size_t>(cref) + kHeader]; }
    int size(int cref) const { return arena_[static_cast<size_t>(cref)]; }
    bool is_learnt(int cref) const { return arena_[static_cast<size_t>(cref) + 1] & 1; }
    bool is_deleted(int cref) const { return arena_[static_cast<size_t>(cref) + 1] & 2; }
    int lbd(int cref) const { return arena_[static_cast<size_t>(cref) + 1] >> 2; }
    float activity(int cref) const;
    void set_activity(int cref, float a);
    int alloc_clause(const std::vector<int>& lits, bool learnt, int lbd);
    void collect_garbage();

    void add_input_clause(const std::vector<int>& dimacs);
    void attach(int cref);
    void enqueue(int lit, int reason);
    int propagate();  // returns conflicting clause ref, or -1
    void analyze(int confl, std::vector<int>& out, int& bt_level, int& lbd);
    void minimize(std::vector<int>& clause);
    void backtrack(int level);
    int pick_branch();
    Result search(uint64_t conflict_budget);
    bool restart_due(uint64_t conflicts_here, uint64_t budget);
    void reduce_db();
    bool locked(int cref) const;

    void bump_var(int v);
    void bump_clause(int cref);

    void proof_add(const std::vector<int>& lits);
    void proof_delete(const std::vector<int>& lits);

    int n_;
    SolverOptions opts_;
    Stats stats_;
    bool ok_ = true;

    std::vector<int> arena_;
    std::vector<int> originals_;  // crefs of input clauses
    std::vector<int> learnts_;    // crefs of learned clauses
    std::vector<std::vector<Watcher>> watches_;  // watches_[lit]: clauses watching lit

    std::vector<int8_t> assign_;
    std::vector<int> level_;
    std::vector<int> reason_;
    std::vector<int8_t> polarity_;
    std::vector<double> activity_;
    VarHeap heap_;
    double var_inc_ = 1.0;
    double cla_inc_ = 1.0;

    std::vector<int> trail_;
    std::vector<int> trail_lim_;
    size_t qhead_ = 0;

    std::vector<int8_t> seen_;
    std::vector<uint64_t> level_stamp_;
    uint64_t stamp_ = 0;
    uint64_t next_reduce_ = 0;

    Window recent_lbd_;
    Window recent_trail_;
    uint64_t lbd_sum_ = 0;

    std::vector<bool> model_;
};

}  // namespace logiclab
