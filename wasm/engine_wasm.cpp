#define DART_NO_MAIN
#define DART_TRAINING  // 网页引擎带训练场规则（engine_init_training）；dart.hpp 的其他使用者不定义它
#include "dart.hpp"
#include <emscripten/emscripten.h>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::unique_ptr<dart::Game> g_game;
size_t g_last_event_idx = 0;
std::string g_ret_buf;
std::string g_err_buf;
bool g_team_mode = false;  // 当前这局是 5v5 团队赛（engine_init_team）

struct Checkpoint {
    std::unique_ptr<dart::Game> game;
    size_t event_idx = 0;
};

std::array<Checkpoint, 64> g_checkpoints;

std::unique_ptr<dart::Game> copy_game(const dart::Game& game) {
    auto copy = std::make_unique<dart::Game>(game);
    // Map and live maps are immutable. Only the observation ring needs a separate allocation.
    if (game.hist) copy->hist = std::make_shared<std::vector<dart::Game::Snap>>(*game.hist);
    return copy;
}

struct StateHash {
    uint64_t value = 14695981039346656037ULL;

    void byte(uint8_t b) {
        value ^= b;
        value *= 1099511628211ULL;
    }

    void add(uint64_t v) {
        for (int i = 0; i < 8; ++i, v >>= 8) byte(uint8_t(v));
    }

    void add_player(const dart::Player& p) {
        for (auto v : {p.alive, p.vis, p.x, p.y, p.vx, p.vy, p.face, p.st, p.timer, p.ax, p.ay,
                       p.cd, p.expose, p.kills, p.msg, p.team, p.dashing, p.kicked_by, p.kick_t,
                       p.dead_t, p.cause, p.killer, p.px, p.py, p.mvx, p.mvy, p.retired, p.unknown,
                       p.slash_win, p.melee_win, p.slash_win_hits, p.melee_win_used, p.block_win_used,
                       p.swing_emitted, p.dash_has_target, p.dash_rem_x, p.dash_rem_y, p.dash_total_len,
                       p.n_throw, p.n_slash, p.n_kick, p.n_dash, p.n_recall, p.n_catch, p.n_pick, p.n_drop,
                       p.n_block, p.n_call_done, p.n_clash, p.n_dash_melee, p.k_dart, p.k_slash, p.k_fall,
                       p.k_team, p.kick_hits, p.kick_hits_team, p.ret_kills, p.multi, p.grass_steps,
                       p.hidden_steps, p.empty_steps, p.dash_steps, p.curve_kills, p.gap_dash, p.dash_pit}) add(v);
        add(p.dash_pt_n);
        for (int i = 0; i < 6; ++i) { add(p.dash_pt_x[i]); add(p.dash_pt_y[i]); }
    }

    void add_dart(const dart::Dart& d) {
        for (auto v : {d.st, d.x, d.y, d.vx, d.vy, d.left, d.age, d.hits, d.bent, d.ldir}) add(v);
    }
};

void append_step_events(std::string& out) {
    out += '[';
    for (size_t i = g_last_event_idx; i < g_game->events.size(); ++i) {
        if (i > g_last_event_idx) out += ',';
        const dart::Event& e = g_game->events[i];
        out += "{\"t\":" + std::to_string(e.t);
        out += ",\"type\":" + std::to_string(e.type);
        out += ",\"name\":\"" + std::string(dart::EV_NAME[e.type]) + "\"";
        out += ",\"a\":" + std::to_string(e.a);
        out += ",\"b\":" + std::to_string(e.b);
        out += ",\"c\":" + std::to_string(e.c);
        out += ",\"d\":" + std::to_string(e.d) + "}";
    }
    out += ']';
}

enum SymOp : int {
    SYM_ID = 0,
    SYM_LR = 1,
    SYM_TB = 2,
    SYM_R180 = 3,
    SYM_R90 = 4,
    SYM_R270 = 5,
    SYM_D1 = 6,
    SYM_D2 = 7,
};

inline void apply_sym_point(dart::i64 W, dart::i64 H, int op, dart::i64 x, dart::i64 y, dart::i64& ox, dart::i64& oy) {
    switch (op) {
        case SYM_ID:   ox = x;     oy = y;     break;
        case SYM_LR:   ox = W - x; oy = y;     break;
        case SYM_TB:   ox = x;     oy = H - y; break;
        case SYM_R180: ox = W - x; oy = H - y; break;
        case SYM_R90:  ox = W - y; oy = x;     break;
        case SYM_R270: ox = y;     oy = W - x; break;
        case SYM_D1:   ox = y;     oy = x;     break;
        case SYM_D2:   ox = W - y; oy = W - x; break;
        default:       ox = x;     oy = y;     break;
    }
}

inline void apply_sym_vec(int op, dart::i64 dx, dart::i64 dy, dart::i64& ox, dart::i64& oy) {
    apply_sym_point(0, 0, op, dx, dy, ox, oy);
}

inline bool circle_hits_pit(const dart::Map& M, dart::i64 r, dart::i64 x, dart::i64 y) {
    const int cx = dart::cell_index(x), cy = dart::cell_index(y);
    const dart::i64 r2 = r * r;
    for (int gy = cy - 1; gy <= cy + 1; ++gy) {
        for (int gx = cx - 1; gx <= cx + 1; ++gx) {
            if (M.inside(gx, gy) && M.at(gx, gy) != dart::C_PIT) continue;
            const dart::i64 qx = dart::iclamp(x, dart::i64(gx) * dart::CELL, dart::i64(gx + 1) * dart::CELL);
            const dart::i64 qy = dart::iclamp(y, dart::i64(gy) * dart::CELL, dart::i64(gy + 1) * dart::CELL);
            const dart::i64 dx = x - qx, dy = y - qy;
            if (dx * dx + dy * dy < r2) return true;
        }
    }
    return false;
}

struct OrbitMember {
    int seat;
    int sym_op;  // transforms representative's (dx, dy) into this seat's offset
};

// Randomize spawns uniformly inside a circle of radius cf.see_r (grass detection radius = 2500mm)
// centered at each original map spawn point, while automatically detecting and preserving
// the original spawns' geometric symmetry (Klein-4, C4, R180, LR, TB, diagonals, or partial pairs).
void randomize_spawns_symmetric(const dart::Config& cf, const dart::Map& m, dart::u64 spawn_seed, dart::i64* sx, dart::i64* sy) {
    const int md = int(dart::iclamp(cf.mode, 0, 2));
    const int np = dart::MODE_PLAYERS[md];
    dart::i64 orig_x[dart::MAXP] = {};
    dart::i64 orig_y[dart::MAXP] = {};
    for (int k = 0; k < np; ++k) {
        orig_x[k] = m.spx[md][k];
        orig_y[k] = m.spy[md][k];
        sx[k] = orig_x[k];
        sy[k] = orig_y[k];
    }
    const dart::i64 R = cf.see_r;
    if (spawn_seed == 0 || R <= 0) return;

    const dart::i64 W = m.width();
    const dart::i64 H = m.height();
    const bool is_square = (W == H);

    // 1. Detect free symmetry group acting on the original spawns (no fixed points, so 2D disk never collapses to 1D)
    auto is_valid_free_sym = [&](int op, int perm_out[dart::MAXP]) -> bool {
        if (op >= SYM_R90 && !is_square) return false;
        bool used[dart::MAXP] = {};
        for (int k = 0; k < np; ++k) {
            dart::i64 ox, oy;
            apply_sym_point(W, H, op, orig_x[k], orig_y[k], ox, oy);
            int match = -1;
            for (int j = 0; j < np; ++j) {
                if (std::llabs(ox - orig_x[j]) <= 1 && std::llabs(oy - orig_y[j]) <= 1) {
                    match = j;
                    break;
                }
            }
            if (match < 0 || match == k || used[match]) return false;
            used[match] = true;
            perm_out[k] = match;
        }
        return true;
    };

    int p_lr[dart::MAXP] = {}, p_tb[dart::MAXP] = {}, p_r180[dart::MAXP] = {};
    int p_r90[dart::MAXP] = {}, p_r270[dart::MAXP] = {}, p_d1[dart::MAXP] = {}, p_d2[dart::MAXP] = {};
    const bool has_lr = is_valid_free_sym(SYM_LR, p_lr);
    const bool has_tb = is_valid_free_sym(SYM_TB, p_tb);
    const bool has_r180 = is_valid_free_sym(SYM_R180, p_r180);
    const bool has_r90 = is_square && is_valid_free_sym(SYM_R90, p_r90);
    const bool has_r270 = is_square && is_valid_free_sym(SYM_R270, p_r270);
    const bool has_d1 = is_square && is_valid_free_sym(SYM_D1, p_d1);
    const bool has_d2 = is_square && is_valid_free_sym(SYM_D2, p_d2);

    std::vector<std::vector<OrbitMember>> orbits;
    bool assigned[dart::MAXP] = {};

    auto build_group_orbits = [&](const std::vector<std::pair<int, const int*>>& ops) {
        for (int k = 0; k < np; ++k) {
            if (assigned[k]) continue;
            std::vector<OrbitMember> orb;
            orb.push_back({k, SYM_ID});
            assigned[k] = true;
            for (const auto& [op, perm] : ops) {
                int target = perm[k];
                if (!assigned[target]) {
                    orb.push_back({target, op});
                    assigned[target] = true;
                }
            }
            orbits.push_back(std::move(orb));
        }
    };

    if (has_lr && has_tb && has_r180) {
        build_group_orbits({{SYM_LR, p_lr}, {SYM_R180, p_r180}, {SYM_TB, p_tb}});
    } else if (has_r90 && has_r180 && has_r270) {
        build_group_orbits({{SYM_R90, p_r90}, {SYM_R180, p_r180}, {SYM_R270, p_r270}});
    } else if (has_r180) {
        build_group_orbits({{SYM_R180, p_r180}});
    } else if (has_lr) {
        build_group_orbits({{SYM_LR, p_lr}});
    } else if (has_tb) {
        build_group_orbits({{SYM_TB, p_tb}});
    } else if (has_d1) {
        build_group_orbits({{SYM_D1, p_d1}});
    } else if (has_d2) {
        build_group_orbits({{SYM_D2, p_d2}});
    } else {
        // Partial pairwise symmetry fallback (e.g. yinyang 4p where seats 0 & 2 are exact R180 partners)
        const int cand_ops[5] = {SYM_R180, SYM_LR, SYM_TB, SYM_D1, SYM_D2};
        const int num_cand = is_square ? 5 : 3;
        for (int oi = 0; oi < num_cand; ++oi) {
            const int op = cand_ops[oi];
            for (int u = 0; u < np; ++u) {
                if (assigned[u]) continue;
                dart::i64 ox, oy;
                apply_sym_point(W, H, op, orig_x[u], orig_y[u], ox, oy);
                for (int v = u + 1; v < np; ++v) {
                    if (assigned[v]) continue;
                    if (std::llabs(ox - orig_x[v]) <= 1 && std::llabs(oy - orig_y[v]) <= 1) {
                        orbits.push_back({{u, SYM_ID}, {v, op}});
                        assigned[u] = true;
                        assigned[v] = true;
                        break;
                    }
                }
            }
        }
        for (int u = 0; u < np; ++u) {
            if (!assigned[u]) {
                orbits.push_back({{u, SYM_ID}});
                assigned[u] = true;
            }
        }
    }

    // 2. Compute walkable connected component from each original spawn so players never land on isolated islands
    std::vector<std::vector<uint8_t>> reachable(static_cast<size_t>(np));
    for (int k = 0; k < np; ++k) {
        std::vector<uint8_t> vis(size_t(m.nx) * m.ny, 0);
        int sgx = dart::iclamp(dart::cell_index(orig_x[k]), 0, m.nx - 1);
        int sgy = dart::iclamp(dart::cell_index(orig_y[k]), 0, m.ny - 1);
        int sc = m.at(sgx, sgy);
        if (sc == dart::C_FLOOR || sc == dart::C_GRASS) {
            std::vector<int> q;
            q.reserve(size_t(m.nx) * m.ny);
            vis[size_t(sgy) * m.nx + sgx] = 1;
            q.push_back(sgy * m.nx + sgx);
            static const int dxs[4] = {1, -1, 0, 0};
            static const int dys[4] = {0, 0, 1, -1};
            for (size_t qi = 0; qi < q.size(); ++qi) {
                int idx = q[qi];
                int cx = idx % m.nx;
                int cy = idx / m.nx;
                for (int dir = 0; dir < 4; ++dir) {
                    int nx2 = cx + dxs[dir];
                    int ny2 = cy + dys[dir];
                    if (!m.inside(nx2, ny2)) continue;
                    size_t nidx = size_t(ny2) * m.nx + nx2;
                    if (vis[nidx]) continue;
                    int c = m.at(nx2, ny2);
                    if (c != dart::C_FLOOR && c != dart::C_GRASS) continue;
                    vis[nidx] = 1;
                    q.push_back(int(nidx));
                }
            }
        }
        reachable[size_t(k)] = std::move(vis);
    }

    // 3. Minimum pairwise separation between distinct spawns (2500mm, capped at original map's min distance)
    dart::i64 min_sep_d2 = dart::i64(2500) * 2500;
    for (int i = 0; i < np; ++i) {
        for (int j = i + 1; j < np; ++j) {
            dart::i64 ddx = orig_x[i] - orig_x[j];
            dart::i64 ddy = orig_y[i] - orig_y[j];
            dart::i64 d2 = ddx * ddx + ddy * ddy;
            if (d2 < min_sep_d2) min_sep_d2 = d2;
        }
    }

    auto point_valid = [&](int seat, dart::i64 x, dart::i64 y, bool strict_pit) -> bool {
        if (x < cf.body_r || y < cf.body_r || x > W - cf.body_r || y > H - cf.body_r) return false;
        const int c = dart::cell_of_point(cf, m, x, y, 0);
        if (c != dart::C_FLOOR && c != dart::C_GRASS) return false;
        if (dart::circle_hits_wall(m, cf.body_r, x, y)) return false;
        if (strict_pit && circle_hits_pit(m, cf.body_r, x, y)) return false;
        int gx[4], gy[4];
        const int ncells = dart::point_cells(x, y, gx, gy);
        bool any_reach = false;
        const auto& vis = reachable[size_t(seat)];
        for (int i = 0; i < ncells; ++i) {
            if (m.inside(gx[i], gy[i]) && vis[size_t(gy[i]) * m.nx + gx[i]]) {
                any_reach = true;
                break;
            }
        }
        return any_reach;
    };

    // 4. Rejection-sample one uniform (dx, dy) in disk dx^2 + dy^2 <= R^2 per symmetry orbit
    // Hash the seed through one SplitMix64 step before using it: seeding with `seed * GOLDEN + C` would make each
    // seed's stream the neighbouring seed's stream shifted by one draw (SplitMix64 itself advances by GOLDEN), so after
    // rejection sampling nearby seeds (e.g. 6, 8, 10) could land on the exact same spawns.
    dart::SplitMix64 rng(dart::SplitMix64(spawn_seed ^ 0x51ED270B27C6F3A1ULL).next());
    const dart::i64 R2 = R * R;
    bool placed[dart::MAXP] = {};

    for (const auto& orb : orbits) {
        bool found = false;
        for (int pass = 0; pass < 2 && !found; ++pass) {
            const bool strict_pit = (pass == 0);
            const int max_disk_tries = (pass == 0) ? 512 : 256;
            int disk_tries = 0;
            for (int raw = 0; raw < max_disk_tries * 4 && disk_tries < max_disk_tries; ++raw) {
                const dart::i64 dx = rng.range(-R, R);
                const dart::i64 dy = rng.range(-R, R);
                if (dx * dx + dy * dy > R2) continue;
                ++disk_tries;

                dart::i64 tx[dart::MAXP];
                dart::i64 ty[dart::MAXP];
                bool ok = true;
                for (size_t i = 0; i < orb.size() && ok; ++i) {
                    const int u = orb[i].seat;
                    dart::i64 ox, oy;
                    apply_sym_vec(orb[i].sym_op, dx, dy, ox, oy);
                    tx[i] = orig_x[u] + ox;
                    ty[i] = orig_y[u] + oy;
                    if (!point_valid(u, tx[i], ty[i], strict_pit)) {
                        ok = false;
                        break;
                    }
                    // Check separation against intra-orbit peers
                    for (size_t j = 0; j < i; ++j) {
                        const dart::i64 sx_d = tx[i] - tx[j];
                        const dart::i64 sy_d = ty[i] - ty[j];
                        if (sx_d * sx_d + sy_d * sy_d < min_sep_d2) {
                            ok = false;
                            break;
                        }
                    }
                    // Check separation against already-placed orbits
                    for (int other = 0; other < np && ok; ++other) {
                        if (!placed[other]) continue;
                        const dart::i64 sx_d = tx[i] - sx[other];
                        const dart::i64 sy_d = ty[i] - sy[other];
                        if (sx_d * sx_d + sy_d * sy_d < min_sep_d2) {
                            ok = false;
                        }
                    }
                }
                if (ok) {
                    for (size_t i = 0; i < orb.size(); ++i) {
                        const int u = orb[i].seat;
                        sx[u] = tx[i];
                        sy[u] = ty[i];
                    }
                    found = true;
                    break;
                }
            }
        }
        for (const auto& mem : orb) {
            placed[mem.seat] = true;
        }
    }
}

int init_engine_impl(const char* map_text, int n_players, unsigned int seed, unsigned int spawn_seed) {
    g_err_buf.clear();
    g_team_mode = false;
    if (n_players < 2 || n_players > 4) {
        g_err_buf = "n_players must be 2..4";
        return 0;
    }
    auto m = std::make_shared<dart::Map>();
    std::string err = dart::parse_map(map_text ? map_text : "", *m);
    if (!err.empty()) {
        g_err_buf = err;
        return 0;
    }

    // If this is a 4v4-only map (MODES 2), synthesize symmetric 2p and 4p spawns from SPAWN 2
    if (!m->modes[0] && m->modes[2]) {
        m->modes[0] = true;
        m->spx[0][0] = m->spx[2][0];
        m->spy[0][0] = m->spy[2][0];
        m->spx[0][1] = m->spx[2][4];
        m->spy[0][1] = m->spy[2][4];
    }
    if (!m->modes[1] && m->modes[2]) {
        m->modes[1] = true;
        const int pick[4] = {0, 7, 4, 3};
        for (int k = 0; k < 4; ++k) {
            m->spx[1][k] = m->spx[2][pick[k]];
            m->spy[1][k] = m->spy[2][pick[k]];
        }
    }

    dart::Config cf;
    cf.mode = (n_players == 2) ? dart::M_DUEL : dart::M_FFA;
    cf.delay = 4;
    cf.steps = 800;

    if (!m->modes[cf.mode]) {
        g_err_buf = "Map does not support requested mode";
        return 0;
    }

    if (spawn_seed != 0) {
        // Bypass legacy square jitter_spawns and apply symmetry-preserving circular randomization (radius = see_r)
        g_game = std::make_unique<dart::Game>(cf, m, true, dart::u64(0));
        g_game->seed = dart::u64(seed);
        randomize_spawns_symmetric(cf, *m, dart::u64(spawn_seed), g_game->spx, g_game->spy);
        const dart::i64 W = m->width(), H = m->height();
        for (int k = 0; k < g_game->n; ++k) {
            dart::Player& P = g_game->p[k];
            P.x = g_game->spx[k];
            P.y = g_game->spy[k];
            P.px = P.x;
            P.py = P.y;
            P.face = dart::iatan2(H / 2 - P.y, W / 2 - P.x);
            g_game->d[k].x = P.x;
            g_game->d[k].y = P.y;
        }
        if (n_players == 3) {
            // Pick 3 well-spaced seats from the 4 FFA spawns (0, 1, 2)
            g_game->n = 3;
        }
        g_game->snapshot();
    } else {
        // Legacy engine_init path: 100% backward compatible with old seeds and tests
        g_game = std::make_unique<dart::Game>(cf, m, true, dart::u64(seed));
        if (n_players == 3) {
            g_game->n = 3;
            g_game->snapshot();
        }
    }

    g_last_event_idx = 0;
    g_checkpoints = {};
    return 1;
}

// ---------------------------------------------------------------- 5v5 团队赛（MODE 3 歼灭 / 4 占点 / 5 刺王）
// 两支原版战队用两套互不兼容的队内电台：
//   Astra 队：格x + 64·格y + 4096·意图 + 16384·(t mod 4)（0.5 米格，意图 0 走 / 1 扔 / 2 近战 / 3 冲刺）
//   Fable 队：⌊x/250⌋ + 128·⌊y/250⌋ + 16384·F（F=1 位置，F=2 出手那步的镖路终点，F=3 冲刺那步的落点）
// 混编时，引擎按收信方的协议把队友这一步的状态和动作重新编码后再放进观察里（“电台翻译”），真人也由此自动发电台。
// 同协议的 bot 之间仍原样转发它自己发的消息，原版阵容的行为与原赛一致。
enum RadioProto { RP_NONE = 0, RP_ASTRA = 1, RP_FABLE = 2 };
int g_proto[dart::MAXP] = {};
dart::i64 g_tmsg[dart::MAXP][3] = {};   // 每人最近一次（活着时）按两种协议编码的消息
std::string g_seat_plan[dart::MAXP];
bool g_has_seat_plan[dart::MAXP] = {};

dart::i64 radio_astra(const dart::Player& P, const dart::Action& a, dart::i64 t) {
    int intent = 0;
    if (a.act == dart::A_THROW) intent = 1;
    else if (a.act == dart::A_MELEE) intent = 2;
    else if (a.act == dart::A_DASH) intent = 3;
    else if (P.st == dart::S_THROW) intent = 1;
    else if (P.st == dart::S_SLASH || P.st == dart::S_KICK) intent = 2;
    else if (P.st == dart::S_DASH) intent = 3;
    const dart::i64 x = dart::iclamp(dart::i64(dart::cell_index(P.x)), 0, 63);
    const dart::i64 y = dart::iclamp(dart::i64(dart::cell_index(P.y)), 0, 63);
    return x + 64 * y + 4096 * intent + 16384 * (t % 4);
}

dart::i64 radio_fable(const dart::Game& g, const dart::Player& P, const dart::Dart& D, const dart::Action& a) {
    const dart::Config& cf = g.cf;
    dart::i64 px = P.x, py = P.y, F = 1;
    dart::i64 ux = 0, uy = 0;
    if (a.act == dart::A_THROW && P.st == dart::S_FREE && D.st == dart::D_HAND && (a.ax || a.ay) &&
        dart::scale_to(a.ax, a.ay, 1000, ux, uy)) {
        const dart::i64 W = g.M().width(), H = g.M().height();
        for (dart::i64 L = cf.range; L > 0; L -= 100) {
            const dart::i64 qx = P.x + ux * L / 1000, qy = P.y + uy * L / 1000;
            if (qx >= 300 && qy >= 300 && qx <= W - 300 && qy <= H - 300) { px = qx; py = qy; F = 2; break; }
        }
    }
    if (a.act == dart::A_DASH && P.st == dart::S_FREE && P.cd == 0 && (a.ax || a.ay) &&
        dart::scale_to(a.ax, a.ay, 1000, ux, uy)) {
        const dart::i64 L = cf.dash_v * cf.dash_t;
        px = P.x + ux * L / 1000;
        py = P.y + uy * L / 1000;
        F = 3;
    }
    return dart::iclamp(px / 250, 0, 127) + 128 * dart::iclamp(py / 250, 0, 127) + 16384 * F;
}

// 按收信方 seat 的协议改写观察里队友的 msg
void translate_radio(const dart::Game& g, int seat, dart::Obs& o) {
    if (!g_team_mode) return;
    const int rp = g_proto[seat];
    if (rp == RP_NONE) return;
    for (int q = 0; q < g.n; ++q) {
        if (q == seat || !g.mates(seat, q)) continue;
        const bool same_bot = g_proto[q] == rp && !g.is_human(q);
        if (!same_bot) o.p[q].msg = g_tmsg[q][rp];
    }
}

std::string unhex(const std::string& h) {
    std::string s;
    for (size_t i = 0; i + 1 < h.size(); i += 2) s.push_back(char(std::strtol(h.substr(i, 2).c_str(), nullptr, 16)));
    return s;
}

std::string json_escape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        if (c == '"' || c == '\\') { out += '\\'; out += c; }
        else if (c == '\n') out += "\\n";
        else if (c == '\r') {}
        else out += c;
    }
    return out;
}

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char* engine_last_error() {
    return g_err_buf.c_str();
}

// Upstream's end-of-game state hash (FNV-1a over every player / dart / point field), for batch comparisons
EMSCRIPTEN_KEEPALIVE
const char* engine_get_digest() {
    g_ret_buf = g_game ? g_game->digest() : std::string();
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
int engine_init(const char* map_text, int n_players, unsigned int seed) {
    return init_engine_impl(map_text, n_players, seed, 0);
}

EMSCRIPTEN_KEEPALIVE
int engine_init_with_spawn_seed(const char* map_text, int n_players, unsigned int seed, unsigned int spawn_seed) {
    return init_engine_impl(map_text, n_players, seed, spawn_seed);
}

// 训练场：地图必须有 MODES 2（8 个出生点）。座位分工固定：
//   0 = 玩家（无敌：被镖 / 被砍不出局；坠崖放回最近的安全地面）
//   1-3 = 击打区假人、4-5 = 湖边假人（能砍、能踢下水，出局 2 秒后在原位复活）
//   6-7 = 飞镖假人（无敌 + 定身：不出局、不被踢飞也不被推开；扔镖由前端驱动）
// 场地不塌、不限时。只有这里会打开 Game::training，正常对局走 engine_init / engine_init_with_spawn_seed，规则不受影响。
EMSCRIPTEN_KEEPALIVE
int engine_init_training(const char* map_text) {
    g_err_buf.clear();
    g_team_mode = false;
    auto m = std::make_shared<dart::Map>();
    std::string err = dart::parse_map(map_text ? map_text : "", *m);
    if (!err.empty()) {
        g_err_buf = err;
        return 0;
    }
    if (!m->modes[2]) {
        g_err_buf = "training map needs MODES 2 (8 spawns)";
        return 0;
    }
    m->w.assign(m->c.size(), -1);  // 训练场不塌
    m->nwave = 0;

    dart::Config cf;
    cf.mode = dart::M_TEAM;  // 借 4v4 的 8 个座位；队伍下面改成各自为战
    cf.delay = 4;
    cf.steps = 100000;
    g_game = std::make_unique<dart::Game>(cf, m, true, dart::u64(0));
    dart::Game& g = *g_game;
    g.training = true;
    constexpr int REVIVE_TICKS = 40;  // 2 秒（20 步 / 秒）
    for (int k = 0; k < g.n; ++k) {
        dart::Player& P = g.p[k];
        P.team = k;
        P.face = k >= 6 ? 18000 : 9000;  // 飞镖假人面朝 -x（它们扔镖的方向），其余面朝 +y（朝向镜头）
        g.train_face[k] = P.face;
        g.train_flags[k] = 0;
        g.train_revive[k] = 0;
    }
    g.train_flags[0] = dart::Game::TF_NODIE | dart::Game::TF_FALLBACK;
    for (int k = 1; k <= 5 && k < g.n; ++k) g.train_revive[k] = REVIVE_TICKS;
    for (int k = 6; k <= 7 && k < g.n; ++k) g.train_flags[k] = dart::Game::TF_NODIE | dart::Game::TF_ANCHOR;
    g.snapshot();
    g_last_event_idx = 0;
    g_checkpoints = {};
    return 1;
}

// 5v5 团队赛：mode 3 歼灭 / 4 占点 / 5 刺王，10 个座位（0～4 左队，5～9 右队）。form 是若干行：
//   NAMES n0 … n9          每个座位的短名（bot 认战术单、默认分工都看它）
//   XY x0 y0 … x9 y9       布阵（场地毫米，右队已经转过 180 度）；不写就用地图的默认站位
//   KING k0 k1             刺王：两队国王座位
//   PLAN seat hex          这个座位读到的战术单（UTF-8 十六进制；每人一份，引擎只在开局协议里交给他）
//   PROTO p0 … p9          电台协议：0 无（真人 / 不听电台）1 Astra 队 2 Fable 队
EMSCRIPTEN_KEEPALIVE
int engine_init_team(const char* map_text, int mode, unsigned int seed, const char* form_text) {
    g_err_buf.clear();
    g_team_mode = false;
    if (mode < dart::M_ELIM || mode > dart::M_KING) {
        g_err_buf = "team mode must be 3..5";
        return 0;
    }
    auto m = std::make_shared<dart::Map>();
    std::string err = dart::parse_map(map_text ? map_text : "", *m);
    if (!err.empty()) {
        g_err_buf = err;
        return 0;
    }
    if (!m->modes[mode]) {
        g_err_buf = "Map does not support requested mode";
        return 0;
    }
    dart::Config cf;
    cf.select_mode(mode);
    cf.delay = 4;
    dart::Formation f = dart::Formation::defaults(*m, mode);
    for (int k = 0; k < dart::MAXP; ++k) {
        g_proto[k] = RP_NONE;
        g_seat_plan[k].clear();
        g_has_seat_plan[k] = false;
        g_tmsg[k][0] = g_tmsg[k][1] = g_tmsg[k][2] = 0;
    }
    std::istringstream is(form_text ? form_text : "");
    std::string line;
    while (std::getline(is, line)) {
        std::istringstream ls(line);
        std::string tag;
        if (!(ls >> tag)) continue;
        if (tag == "NAMES") {
            for (int k = 0; k < 10; ++k) ls >> f.names[k];
        } else if (tag == "XY") {
            for (int k = 0; k < 10; ++k) ls >> f.x[k] >> f.y[k];
        } else if (tag == "KING") {
            ls >> f.king[0] >> f.king[1];
        } else if (tag == "PLAN") {
            int k = -1;
            std::string h;
            ls >> k >> h;
            if (k >= 0 && k < 10) {
                g_seat_plan[k] = unhex(h);
                g_has_seat_plan[k] = true;
            }
        } else if (tag == "PROTO") {
            for (int k = 0; k < 10; ++k) ls >> g_proto[k];
        }
    }
    for (int k = 0; k < 10; ++k) {
        if (f.names[k].empty()) f.names[k] = std::to_string(k);
        const int terrain = dart::cell_of_point(cf, *m, f.x[k], f.y[k], 0);
        if (!m->in_deploy(k, f.x[k], f.y[k]) || (terrain != dart::C_FLOOR && terrain != dart::C_GRASS) ||
            dart::circle_hits_wall(*m, cf.body_r, f.x[k], f.y[k])) {
            g_err_buf = "seat " + std::to_string(k) + " spawn is outside the deploy area or not standable";
            return 0;
        }
    }
    if (f.king[0] < 0 || f.king[0] > 4 || f.king[1] < 5 || f.king[1] > 9) {
        g_err_buf = "kings must be one seat on each side";
        return 0;
    }
    g_game = std::make_unique<dart::Game>(cf, m, true, dart::u64(seed), &f);
    g_team_mode = true;
    g_last_event_idx = 0;
    g_checkpoints = {};
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_seat(int seat) {
    if (g_game) {
        g_game->human_seats = seat >= 0 && seat < g_game->n ? 1u << seat : 0;
    }
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_seats(unsigned int seats) {
    if (g_game) g_game->human_seats = seats & ((1u << g_game->n) - 1);
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_slash_ticks(int ticks) {
    if (g_game) {
        g_game->human_slash_ticks = (ticks > 0) ? ticks : 0;
        // 常规(3帧砍镖) -> 砍人/踢人 2 帧；严格(2帧砍镖) 与 AI(0) -> 砍人/踢人 0（1 帧前摇 + 1 帧，与 AI 相同）
        g_game->human_melee_ticks = (ticks >= 3) ? 2 : 0;
    }
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_cliff_guard(int enabled) {
    if (g_game) {
        g_game->human_cliff_guard = (enabled != 0);
    }
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_walk_guard(int enabled) {
    if (g_game) g_game->human_walk_guard = enabled != 0;
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_melee_assist(int enabled) {
    if (g_game) {
        g_game->human_melee_assist = (enabled != 0);
    }
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_dash_target(int active, int tx, int ty) {
    // 已移除“冲刺停在鼠标位置”特性（鼠标仅决定方向），保留空实现以兼容导出 ABI
    (void)active;
    (void)tx;
    (void)ty;
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_header(int seat) {
    if (!g_game || seat < 0 || seat >= g_game->n) {
        g_ret_buf.clear();
        return g_ret_buf.c_str();
    }
    dart::GameInfo gi = g_game->info_for(seat, 10, 1000);
    if (g_team_mode && g_has_seat_plan[seat]) gi.plan = g_seat_plan[seat];
    g_ret_buf = dart::protocol_header(gi);
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_obs(int seat) {
    if (!g_game || seat < 0 || seat >= g_game->n) {
        g_ret_buf.clear();
        return g_ret_buf.c_str();
    }
    dart::Obs o = g_game->observe(seat);
    translate_radio(*g_game, seat, o);
    g_ret_buf = dart::protocol_step(o);
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
int engine_step(const char* actions_text) {
    if (!g_game || g_game->over) return 0;
    dart::Action acts[dart::MAXP];
    std::istringstream iss(actions_text ? actions_text : "");
    std::string line;
    for (int k = 0; k < g_game->n; ++k) {
        if (std::getline(iss, line)) {
            acts[k] = dart::parse_action(line, g_game->cf);
        } else {
            acts[k] = dart::Action();
        }
    }
    g_last_event_idx = g_game->events.size();
    if (g_team_mode) {
        dart::Game& g = *g_game;
        dart::i64 enc[dart::MAXP][3] = {};
        bool acted[dart::MAXP] = {};
        dart::i64 revivals[dart::MAXP] = {};
        for (int k = 0; k < g.n; ++k) {
            revivals[k] = g.p[k].revivals;
            const dart::Player& P = g.p[k];
            if (!P.alive || P.unknown) continue;
            acted[k] = true;
            const dart::Action& a = acts[k];
            if (!a.ok || P.retired || !dart::action_in_range(a, g.cf)) continue;  // 非法动作：消息照引擎记为 0
            enc[k][RP_ASTRA] = radio_astra(P, a, g.t);
            enc[k][RP_FABLE] = radio_fable(g, P, g.d[k], a);
        }
        g.step(acts);
        for (int k = 0; k < g.n; ++k) {
            if (acted[k]) {
                g_tmsg[k][RP_ASTRA] = enc[k][RP_ASTRA];
                g_tmsg[k][RP_FABLE] = enc[k][RP_FABLE];
            }
            if (g.p[k].revivals != revivals[k]) g_tmsg[k][RP_ASTRA] = g_tmsg[k][RP_FABLE] = 0;  // 占点复活当步清零
        }
        return g.over ? 0 : 1;
    }
    g_game->step(acts);
    return g_game->over ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE
int engine_snapshot_save(unsigned int slot) {
    if (!g_game || slot >= g_checkpoints.size()) return 0;
    g_checkpoints[slot] = {copy_game(*g_game), g_last_event_idx};
    return 1;
}

EMSCRIPTEN_KEEPALIVE
int engine_snapshot_restore(unsigned int slot) {
    if (slot >= g_checkpoints.size() || !g_checkpoints[slot].game) return 0;
    g_game = copy_game(*g_checkpoints[slot].game);
    g_last_event_idx = g_checkpoints[slot].event_idx;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
const char* engine_state_hash() {
    g_ret_buf.clear();
    if (!g_game) return g_ret_buf.c_str();
    const dart::Game& g = *g_game;
    StateHash hash;
    for (const auto& item : dart::cfg_items()) hash.add(g.cf.*item.f);
    hash.add(g.seed); // SplitMix is local to spawn generation; there is no persistent RNG cursor.
    hash.add(g.n);
    hash.add(g.t);
    hash.add(g.over);
    hash.add(g.winner);
    hash.add(g.human_seats);
    hash.add(g.human_slash_ticks);
    hash.add(g.human_melee_ticks);
    hash.add(g.human_cliff_guard | (g.human_walk_guard ? 2 : 0));
    hash.add(g.human_melee_assist);
    hash.add(g.human_dash_target_active);
    hash.add(g.human_dash_target_x);
    hash.add(g.human_dash_target_y);
    hash.add(g.training);
    hash.add(g.record);
    hash.add(g.M().nx);
    hash.add(g.M().ny);
    hash.add(g.M().nwave);
    for (auto c : g.M().c) hash.byte(uint8_t(c));
    for (auto w : g.M().w) hash.byte(uint8_t(w));
    // Cache allocation and refresh timing are immaterial; collapse state follows the map and tick.
    for (int k = 0; k < g.n; ++k) {
        hash.add(g.spx[k]); hash.add(g.spy[k]);
        hash.add_player(g.p[k]);
        hash.add_dart(g.d[k]);
        hash.add(g.train_flags[k]); hash.add(g.train_revive[k]); hash.add(g.train_face[k]);
    }
    if (g.hist) {
        for (const auto& snap : *g.hist) {
            hash.add(snap.t);
            if (snap.t < 0) continue;
            for (int k = 0; k < g.n; ++k) {
                hash.add_player(snap.p[k]);
                hash.add_dart(snap.d[k]);
                hash.add(snap.vis[k]);
            }
        }
    }
    for (const auto& e : g.events) {
        for (auto v : {e.t, e.type, e.a, e.b, e.c, e.d}) hash.add(v);
    }
    char hex[17];
    std::snprintf(hex, sizeof(hex), "%016llx", static_cast<unsigned long long>(hash.value));
    g_ret_buf = hex;
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_events_json() {
    g_ret_buf.clear();
    if (g_game) append_step_events(g_ret_buf);
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_map_json() {
    if (!g_game) {
        g_ret_buf = "{}";
        return g_ret_buf.c_str();
    }
    const dart::Map& M = g_game->M();
    const dart::Config& cf = g_game->cf;
    std::string o;
    o.reserve(M.nx * M.ny * 6 + 512);
    o += "{\"name\":\"" + json_escape(M.name) + "\"";
    o += ",\"nx\":" + std::to_string(M.nx);
    o += ",\"ny\":" + std::to_string(M.ny);
    o += ",\"cell\":" + std::to_string(dart::CELL);
    o += ",\"nwave\":" + std::to_string(M.nwave);
    o += ",\"colStart\":" + std::to_string(cf.col_start);
    o += ",\"colEvery\":" + std::to_string(cf.col_every);
    o += ",\"colWarn\":" + std::to_string(cf.col_warn);
    o += ",\"steps\":" + std::to_string(cf.steps);
    o += ",\"bodyR\":" + std::to_string(cf.body_r);
    o += ",\"dartR\":" + std::to_string(cf.dart_r);
    o += ",\"range\":" + std::to_string(cf.range);
    o += ",\"slashReach\":" + std::to_string(cf.slash_reach);
    o += ",\"dashCd\":" + std::to_string(cf.dash_cd);
    o += ",\"recallPre\":" + std::to_string(cf.recall_pre);
    o += ",\"cells\":[";
    for (size_t i = 0; i < M.c.size(); ++i) {
        if (i) o += ',';
        o += std::to_string(int(M.c[i]));
    }
    o += "],\"waves\":[";
    for (size_t i = 0; i < M.w.size(); ++i) {
        if (i) o += ',';
        o += std::to_string(int(M.w[i]));
    }
    o += "],\"waveSteps\":[";
    for (int r = 0; r < M.nwave; ++r) {
        if (r) o += ',';
        o += std::to_string(dart::wave_fall_step(cf, r));
    }
    o += "],\"spawns\":[";
    for (int k = 0; k < g_game->n; ++k) {
        if (k) o += ',';
        o += "[" + std::to_string(g_game->spx[k]) + "," + std::to_string(g_game->spy[k]) + "]";
    }
    o += "]";
    if (g_team_mode) {
        const dart::Game& g = *g_game;
        o += ",\"mode\":" + std::to_string(cf.mode);
        o += ",\"respawn\":" + std::to_string(cf.respawn);
        o += ",\"capture\":" + std::to_string(cf.capture);
        o += ",\"kingLives\":" + std::to_string(cf.king_lives);
        o += ",\"kingInv\":" + std::to_string(cf.king_inv);
        o += ",\"kings\":[" + std::to_string(cf.mode == dart::M_KING ? g.formation.king[0] : -1) + "," +
             std::to_string(cf.mode == dart::M_KING ? g.formation.king[1] : -1) + "]";
        o += ",\"names\":[";
        for (int k = 0; k < g.n; ++k) {
            if (k) o += ',';
            o += "\"" + json_escape(g.formation.names[k]) + "\"";
        }
        o += "],\"bases\":[";
        for (int k = 0; k < g.n; ++k) {
            if (k) o += ',';
            o += "[" + std::to_string(g.formation.x[k]) + "," + std::to_string(g.formation.y[k]) + "]";
        }
        o += "],\"points\":[";
        for (size_t i = 0; i < M.points.size(); ++i) {
            if (i) o += ',';
            const dart::Point& pt = M.points[i];
            o += "{\"name\":\"" + json_escape(pt.name) + "\",\"x\":" + std::to_string(pt.x) + ",\"y\":" + std::to_string(pt.y) +
                 ",\"r\":" + std::to_string(pt.r) + "}";
        }
        o += "],\"deploy\":[";
        for (size_t i = 0; i < M.deploy.size(); ++i) {
            if (i) o += ',';
            const dart::Deploy& z = M.deploy[i];
            o += "[" + std::to_string(z.x0) + "," + std::to_string(z.y0) + "," + std::to_string(z.x1) + "," + std::to_string(z.y1) + "]";
        }
        o += "]";
    }
    o += "}";
    g_ret_buf = std::move(o);
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_state_json() {
    if (!g_game) {
        g_ret_buf = "{}";
        return g_ret_buf.c_str();
    }
    const dart::Game& g = *g_game;
    dart::i64 fallen = 0, warn = -1;
    dart::collapse_state(g.cf, g.M(), g.t, fallen, warn);
    int rks[dart::MAXP] = {};
    g.ranks(rks);

    std::string o;
    o.reserve(2048);
    o += "{\"t\":" + std::to_string(g.t);
    o += ",\"n\":" + std::to_string(g.n);
    o += ",\"over\":" + std::string(g.over ? "true" : "false");
    o += ",\"winner\":" + std::to_string(g.winner);
    o += ",\"fallen\":" + std::to_string(fallen);
    o += ",\"warn\":" + std::to_string(warn);
    o += ",\"players\":[";
    for (int k = 0; k < g.n; ++k) {
        if (k) o += ',';
        const dart::Player& P = g.p[k];
        o += "{\"alive\":" + std::to_string(P.alive);
        o += ",\"x\":" + std::to_string(P.x);
        o += ",\"y\":" + std::to_string(P.y);
        o += ",\"px\":" + std::to_string(P.px);
        o += ",\"py\":" + std::to_string(P.py);
        o += ",\"vx\":" + std::to_string(P.vx);
        o += ",\"vy\":" + std::to_string(P.vy);
        o += ",\"face\":" + std::to_string(P.face);
        o += ",\"st\":" + std::to_string(P.st);
        o += ",\"timer\":" + std::to_string(P.timer);
        o += ",\"ax\":" + std::to_string(P.ax);
        o += ",\"ay\":" + std::to_string(P.ay);
        o += ",\"cd\":" + std::to_string(P.cd);
        o += ",\"expose\":" + std::to_string(P.expose);
        o += ",\"kills\":" + std::to_string(P.kills);
        o += ",\"kDart\":" + std::to_string(P.k_dart);
        o += ",\"kSlash\":" + std::to_string(P.k_slash);
        o += ",\"kFall\":" + std::to_string(P.k_fall);
        o += ",\"visMask\":" + std::to_string(g.vis_mask(k));
        o += ",\"deadT\":" + std::to_string(P.dead_t);
        o += ",\"cause\":" + std::to_string(P.cause);
        o += ",\"killer\":" + std::to_string(P.killer);
        o += ",\"dashing\":" + std::to_string(P.dashing);
        o += ",\"kickedBy\":" + std::to_string(P.kicked_by);
        o += ",\"rank\":" + std::to_string(rks[k]);
        if (g_team_mode) {
            o += ",\"team\":" + std::to_string(P.team);
            o += ",\"lives\":" + std::to_string(P.lives);
            o += ",\"inv\":" + std::to_string(P.inv);
            o += ",\"revivals\":" + std::to_string(P.revivals);
            o += ",\"kTeam\":" + std::to_string(P.k_team);  // 误杀队友（kills 里也算了）
        }
        o += "}";
    }
    o += "],\"darts\":[";
    for (int k = 0; k < g.n; ++k) {
        if (k) o += ',';
        const dart::Dart& D = g.d[k];
        o += "{\"st\":" + std::to_string(D.st);
        o += ",\"x\":" + std::to_string(D.x);
        o += ",\"y\":" + std::to_string(D.y);
        o += ",\"vx\":" + std::to_string(D.vx);
        o += ",\"vy\":" + std::to_string(D.vy);
        o += ",\"left\":" + std::to_string(D.left);
        o += ",\"age\":" + std::to_string(D.age);
        o += "}";
    }
    o += "]";
    if (g_team_mode) {
        o += ",\"owner\":[" + std::to_string(g.owner[0]) + "," + std::to_string(g.owner[1]) + "," + std::to_string(g.owner[2]) + "]";
        o += ",\"taking\":[" + std::to_string(g.taking[0]) + "," + std::to_string(g.taking[1]) + "," + std::to_string(g.taking[2]) + "]";
        o += ",\"prog\":[" + std::to_string(g.prog[0]) + "," + std::to_string(g.prog[1]) + "," + std::to_string(g.prog[2]) + "]";
        o += ",\"score\":[" + std::to_string(g.score[0]) + "," + std::to_string(g.score[1]) + "]";
    }
    o += ",\"events\":";
    append_step_events(o);
    o += '}';
    g_ret_buf = std::move(o);
    return g_ret_buf.c_str();
}

}  // extern "C"
