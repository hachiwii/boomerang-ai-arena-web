#!/usr/bin/env python3
"""Export maps, voxel character models (including repo's built-in demo_blue/demo_red generic humanoids),
and character avatars from the cloned meow-ai-arena repository."""
import json
import os
import shutil
import sys
import types
from pathlib import Path

# voxkit only uses numpy in .mesh()/.bounds(), not in Model/to_json()
if "numpy" not in sys.modules:
    try:
        import numpy  # noqa: F401
    except ImportError:
        sys.modules["numpy"] = types.ModuleType("numpy")

SRC_REPO = Path(os.environ.get("MEOW_AI_ARENA_DIR", "../meow-ai-arena")).expanduser().resolve()
BOOM = SRC_REPO / "boomerang"
RENDER_SRC = BOOM / "renderer" / "src"
CHARS_DIR = SRC_REPO / "characters" / "boomerang"
AVATARS_SRC = BOOM / "renderer" / "assets" / "avatars"
MAPS_SRC = BOOM / "renderer" / "maps"

ROOT = Path(__file__).resolve().parent.parent
OUT_MAPS = ROOT / "public" / "assets" / "maps"
OUT_CHARS = ROOT / "public" / "assets" / "chars"
OUT_AVATARS = ROOT / "public" / "assets" / "avatars"

sys.path.insert(0, str(RENDER_SRC))
import voxchars  # noqa: E402
from voxchars.demo_red import build_hoodie  # noqa: E402

MAP_ORDER = [
    ("twinlakes", "standard"),
    ("yinyang", "standard"),
    ("stonecircle", "standard"),
    ("skybridge", "standard"),
    ("ruins", "standard"),
    ("icefloes", "standard"),
    ("hourglass", "large"),
    ("canyon", "large"),
    ("oldtown", "large"),
    ("forest", "large"),
]

AVATAR_MAP = {
    "astra": "GPT_大_Astra.png",
    "sol": "GPT_小_Sol.png",
    "fable": "Fable.png",
    "opus": "Claude_大_Opus.png",
    "gemini": "Gemini.png",
    "gemini_s": "Gemini_小.png",
    "grok": "Grok.png",
    "glm": "GLM.png",
    "deepseek": "DeepSeek.png",
    "kimi": "Kimi.png",
    "qwen": "Qwen_千问.png",
    "mimo": "小米MiMo.png",
    "doubao": "豆包.png",
}

OFFICIAL_BOTS = [
    {"id": "gpt-6.2-astra", "seat": "astra", "charKey": "astra", "name": "GPT-6.2 Astra", "shortName": "Astra", "rank": 1, "rating": 306.12, "category": "official"},
    {"id": "claude-fable-5.2", "seat": "fable", "charKey": "fable", "name": "Claude Fable 5.2", "shortName": "Fable", "rank": 2, "rating": 131.99, "category": "official"},
    {"id": "claude-opus-5.5", "seat": "opus", "charKey": "opus", "name": "Claude Opus 5.5", "shortName": "Opus", "rank": 3, "rating": 76.30, "category": "official"},
    {"id": "gemini-4-carbon", "seat": "carbon", "charKey": "gemini", "name": "Gemini 4 Carbon", "shortName": "Carbon", "rank": 4, "rating": 50.99, "category": "official"},
    {"id": "gpt-6.2-sol", "seat": "sol", "charKey": "sol", "name": "GPT-6.2 Sol", "shortName": "Sol", "rank": 5, "rating": 33.08, "category": "official"},
    {"id": "gemini-4-hydrogen", "seat": "hydrogen", "charKey": "gemini_s", "name": "Gemini 4 Hydrogen", "shortName": "Hydrogen", "rank": 6, "rating": 29.85, "category": "official"},
    {"id": "grok-4.7", "seat": "grok", "charKey": "grok", "name": "Grok 4.7", "shortName": "Grok", "rank": 7, "rating": -0.92, "category": "official"},
    {"id": "glm-5.3", "seat": "glm", "charKey": "glm", "name": "GLM 5.3", "shortName": "GLM", "rank": 8, "rating": -9.44, "category": "official"},
    {"id": "deepseek-v4.1-flash", "seat": "deepseek", "charKey": "deepseek", "name": "DeepSeek-V4.1-Flash", "shortName": "DeepSeek", "rank": 9, "rating": -29.99, "category": "official"},
    {"id": "kimi-k3.1-pro", "seat": "kimi", "charKey": "kimi", "name": "Kimi K3.1 Pro", "shortName": "Kimi", "rank": 10, "rating": -83.54, "category": "official"},
    {"id": "qwen4-max", "seat": "qwen", "charKey": "qwen", "name": "千问 Qwen4-Max", "shortName": "千问", "rank": 11, "rating": -87.08, "category": "official"},
    {"id": "mimo-v2.6-pro", "seat": "mimo", "charKey": "mimo", "name": "MiMo V2.6 Pro", "shortName": "MiMo", "rank": 12, "rating": -166.59, "category": "official"},
    {"id": "doubao-seed-evolving", "seat": "doubao", "charKey": "doubao", "name": "豆包 Seed-Evolving", "shortName": "豆包", "rank": 13, "rating": -250.74, "category": "official"},
    {"id": "sparring-strong", "seat": "strong", "charKey": "demo_red", "name": "强陪练 Strong", "shortName": "强陪练", "rank": None, "rating": 120.0, "category": "sparring"},
    {"id": "sparring-mid", "seat": "mid", "charKey": "sparring_mid", "name": "中陪练 Mid", "shortName": "中陪练", "rank": None, "rating": -180.0, "category": "sparring"},
    {"id": "sparring-weak", "seat": "weak", "charKey": "sparring_weak", "name": "弱陪练 Weak", "shortName": "弱陪练", "rank": None, "rating": -350.0, "category": "sparring"},
]


def export_maps():
    OUT_MAPS.mkdir(parents=True, exist_ok=True)
    manifest = []
    for map_id, size_cat in MAP_ORDER:
        src = MAPS_SRC / f"{map_id}.txt"
        text = src.read_text(encoding="utf-8")
        (OUT_MAPS / f"{map_id}.txt").write_text(text, encoding="utf-8")

        title = map_id
        theme = "meadow"
        desc = ""
        nx, ny = 36, 24
        grid_lines = []
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            s = ln.strip()
            if s.startswith("// TITLE "):
                title = s[len("// TITLE "):].strip()
            elif s.startswith("// THEME "):
                theme = s[len("// THEME "):].strip()
            elif s.startswith("// ") and not desc and not s.startswith("// CELL"):
                desc = s[3:].strip()
            elif s.startswith("GRID "):
                parts = s.split()
                nx = int(parts[1])
                ny = int(parts[2]) if len(parts) > 2 else nx
                grid_lines = lines[i + 1 : i + 1 + ny]

        manifest.append({
            "id": map_id,
            "title": title,
            "theme": theme,
            "category": size_cat,
            "nx": nx,
            "ny": ny,
            "desc": desc,
            "previewGrid": grid_lines,
        })
    (OUT_MAPS / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(manifest)} maps.")


def export_characters():
    OUT_CHARS.mkdir(parents=True, exist_ok=True)
    char_colors = {}

    # 13 official AI characters (copy official exported JSON + record official COLOR)
    for key in list(voxchars.KEYS) + list(voxchars.EXTRA):
        src_json = CHARS_DIR / f"{key}.json"
        data = json.loads(src_json.read_text(encoding="utf-8"))
        col = voxchars.color(key)
        data["color"] = col
        data["label"] = voxchars.label(key)
        (OUT_CHARS / f"{key}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        char_colors[key] = col

    # Repo's built-in generic humanoid models: demo_blue (Human Player) & demo_red (Sparring Strong)
    for key in ("demo_blue", "demo_red"):
        model = voxchars.build(key)
        data = model.to_json()
        col = voxchars.color(key)
        data["color"] = col
        data["label"] = "玩家" if key == "demo_blue" else "陪练"
        (OUT_CHARS / f"{key}.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        char_colors[key] = col

    # Two additional hoodie color variants for sparring mid & weak (same built-in hoodie rig)
    mid_pal = dict(hair="#3D3028", hair_d="#261D18", hair_hi="#6B5548", hood="#E89A2E", hood_d="#B8741C", hood_hi="#FFC76E",
                   pants="#3C4150", shoe="#F4F4F2", cord="#FFFFFF", eye="#3B2B3D")
    m_mid = build_hoodie("sparring_mid", mid_pal, None, bangs=(-3, -2, -1, 1, 2), cowlick=True)
    d_mid = m_mid.to_json()
    d_mid["color"] = "#F2A332"
    d_mid["label"] = "中陪练"
    (OUT_CHARS / "sparring_mid.json").write_text(json.dumps(d_mid, ensure_ascii=False), encoding="utf-8")
    char_colors["sparring_mid"] = "#F2A332"

    weak_pal = dict(hair="#4D423A", hair_d="#332B25", hair_hi="#7A6B60", hood="#4AB87A", hood_d="#328A59", hood_hi="#84E0A8",
                    pants="#3C4150", shoe="#F4F4F2", cord="#FFFFFF", eye="#2B3550")
    m_weak = build_hoodie("sparring_weak", weak_pal, None, bangs=(-3, -2, 0, 1, 2), cowlick=False)
    d_weak = m_weak.to_json()
    d_weak["color"] = "#4CC480"
    d_weak["label"] = "弱陪练"
    (OUT_CHARS / "sparring_weak.json").write_text(json.dumps(d_weak, ensure_ascii=False), encoding="utf-8")
    char_colors["sparring_weak"] = "#4CC480"

    # Pull exact official Elo ratings (overall, duel, ffa) from 海选成绩.json
    scores_path = BOOM / "results" / "海选成绩.json"
    official_scores = json.loads(scores_path.read_text(encoding="utf-8"))["players"] if scores_path.exists() else {}

    # Build roster catalog for frontend
    roster = []
    for b in OFFICIAL_BOTS:
        entry = dict(b)
        sc = official_scores.get(b["seat"])
        if sc:
            entry["rating"] = round(float(sc["rating"]), 2)
            entry["duelRating"] = round(float(sc["duel_rating"]), 2)
            entry["ffaRating"] = round(float(sc["ffa_rating"]), 2)
        else:
            entry["duelRating"] = None
            entry["ffaRating"] = None
        entry["color"] = char_colors[b["charKey"]]
        entry["avatar"] = f"/assets/avatars/{b['charKey']}.png" if b["charKey"] in AVATAR_MAP else None
        roster.append(entry)
    (OUT_CHARS / "roster.json").write_text(json.dumps(roster, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(char_colors)} voxel characters and roster.json.")


def export_avatars():
    import subprocess
    OUT_AVATARS.mkdir(parents=True, exist_ok=True)
    for key in AVATAR_MAP:
        src = CHARS_DIR / f"{key}_正面.png"
        dst = OUT_AVATARS / f"{key}.png"
        shutil.copy2(src, dst)
        subprocess.run(["sips", "-Z", "192", str(dst)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Exported {len(AVATAR_MAP)} optimized 192px voxel character avatars.")


def main():
    export_maps()
    export_characters()
    export_avatars()


if __name__ == "__main__":
    main()
