#define DART_NO_MAIN
#include "dart.hpp"
#include <emscripten/emscripten.h>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

std::unique_ptr<dart::Game> g_game;
size_t g_last_event_idx = 0;
std::string g_ret_buf;
std::string g_err_buf;

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

EMSCRIPTEN_KEEPALIVE
int engine_init(const char* map_text, int n_players, unsigned int seed) {
    g_err_buf.clear();
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

    g_game = std::make_unique<dart::Game>(cf, m, true, dart::u64(seed));

    if (n_players == 3) {
        // Pick 3 well-spaced seats from the 4 FFA spawns (0, 1, 2)
        g_game->n = 3;
        g_game->snapshot();
    }

    g_last_event_idx = 0;
    return 1;
}

EMSCRIPTEN_KEEPALIVE
void engine_set_human_seat(int seat) {
    if (g_game) {
        g_game->human_slash_seat = seat;
    }
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_header(int seat) {
    if (!g_game || seat < 0 || seat >= g_game->n) {
        g_ret_buf.clear();
        return g_ret_buf.c_str();
    }
    g_ret_buf = dart::protocol_header(g_game->info_for(seat, 10, 1000));
    return g_ret_buf.c_str();
}

EMSCRIPTEN_KEEPALIVE
const char* engine_get_obs(int seat) {
    if (!g_game || seat < 0 || seat >= g_game->n) {
        g_ret_buf.clear();
        return g_ret_buf.c_str();
    }
    g_ret_buf = dart::protocol_step(g_game->observe(seat));
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
    g_game->step(acts);
    return g_game->over ? 0 : 1;
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
    o += "]}";
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
    o += "],\"events\":[";
    bool first_ev = true;
    for (size_t i = g_last_event_idx; i < g.events.size(); ++i) {
        const dart::Event& e = g.events[i];
        if (!first_ev) o += ',';
        first_ev = false;
        o += "{\"t\":" + std::to_string(e.t);
        o += ",\"type\":" + std::to_string(e.type);
        o += ",\"name\":\"" + std::string(dart::EV_NAME[e.type]) + "\"";
        o += ",\"a\":" + std::to_string(e.a);
        o += ",\"b\":" + std::to_string(e.b);
        o += ",\"c\":" + std::to_string(e.c);
        o += ",\"d\":" + std::to_string(e.d);
        o += "}";
    }
    o += "]}";
    g_ret_buf = std::move(o);
    return g_ret_buf.c_str();
}

}  // extern "C"
