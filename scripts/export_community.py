#!/usr/bin/env python3
"""Community bots: built into the game like the official ones, but category "community" (never ranked).

For each entry below this script
  - copies the bot's character model into public/assets/chars/<charKey>.json (with the bot's colour and label),
  - draws a pixel avatar from the model's head into public/assets/avatars/<charKey>.svg
    (same front-view method as custom models, src/game/customBots/customModel.ts),
  - inserts / replaces the bot's entry in public/assets/chars/roster.json, right before the sparring bots
    (with `author` when the entry names one: the lobby shows it as a small pink "@author" after the bot's name).
The bot's C++ source lives in wasm/bots/<id>.cpp and is compiled by scripts/build_wasm.py like the others.

Ratings are on the contest scale (13 official bots average 0; the in-game ELO is rating x 2 + 1000, as for the
official bots). Unrated bots keep null ratings. Run on its own, or let scripts/export_assets.py call it after
writing roster.json.
"""
import json
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
OUT_CHARS = ROOT / "public" / "assets" / "chars"
OUT_AVATARS = ROOT / "public" / "assets" / "avatars"

COMMUNITY_BOTS = [
    {
        # GPT-6.2 Astra's bot after seven rounds of feedback (v9). Ratings: contest-style full scoring
        # (challenge.py --k 6, 2496 games each) averaged over seed bases 71001 / 85001 / 95001.
        "id": "astra-rlhf",
        "seat": "astra_rlhf",
        "charKey": "dragon_girl",
        "name": "Astra RLHF",
        "shortName": "Astra RLHF",
        "model": ROOT / "custom-bots" / "white-dragon.json",
        "color": "#FFFFFF",
        "rating": 374.58,
        "duel_rating": 446.53,
        "ffa_rating": 302.62,
    },
    {
        # RLHF with Kalman-assisted trajectory correction. Ratings are pending
        # evaluation on the contest scale; do not reuse another bot's scores.
        "id": "astra-rlhf-kf",
        "seat": "astra_rlhf_kf",
        "charKey": "kf_lena",
        "name": "RLHF-KF",
        "shortName": "RLHF-KF",
        "author": "透明人没有影子",
        "model": ROOT / "custom-bots" / "kf-lena.json",
        "color": "#383845",
        "rating": None,
        "duel_rating": None,
        "ffa_rating": None,
    },
]

ALT_FACES = {"face_tight", "face_happy"}


def elo(r: Optional[float]) -> Optional[int]:
    return None if r is None else int(round(r * 2.0 + 1000.0))


def model_avatar_svg(parts: dict) -> str:
    """Front view (from -y, +z up) of the head: frontmost voxel per column with its front paint, plus front slabs."""
    visible = [(nm, p) for nm, p in parts.items() if nm not in ALT_FACES]
    head = parts.get("head", {}).get("voxels") or None
    ref = head or [v for _, p in visible for v in p.get("voxels", [])]
    x0 = min(v[0] for v in ref)
    x1 = max(v[0] for v in ref) + 1
    z0 = min(v[2] for v in ref)
    z1 = max(v[2] for v in ref) + 1
    if not head:
        z0 = max(z0, z1 - max(4, round((z1 - z0) * 0.45)))
    size = max(x1 - x0, z1 - z0) + 2
    cx = (x0 + x1) / 2
    x0, x1 = cx - size / 2, cx + size / 2
    top = z1 + 1
    bottom = top - size
    front = {}
    for _, p in visible:
        paint_front = {(x, y, z): col for x, y, z, d, col in p.get("paint", []) if d == 3}
        for x, y, z, col in p.get("voxels", []):
            if x + 1 <= x0 or x >= x1 or z + 1 <= bottom or z >= top:
                continue
            cur = front.get((x, z))
            if cur is None or y < cur[0]:
                front[(x, z)] = (y, paint_front.get((x, y, z), col))
    px = lambda x: f"{x - x0:.2f}"
    pz = lambda z: f"{top - z:.2f}"
    rects = [f'<rect x="{px(x)}" y="{pz(z + 1)}" width="1" height="1" fill="{col}"/>' for (x, z), (_, col) in front.items()]
    for _, p in visible:
        for sx0, sx1, sy0, _sy1, sz0, sz1, col in p.get("slabs", []):
            f = front.get((int((sx0 + sx1) // 2), int((sz0 + sz1) // 2)))
            if f and sy0 > f[0] + 0.5:
                continue
            if sx1 <= x0 or sx0 >= x1 or sz1 <= bottom or sz0 >= top:
                continue
            rects.append(f'<rect x="{px(sx0)}" y="{pz(sz1)}" width="{sx1 - sx0:.2f}" height="{sz1 - sz0:.2f}" fill="{col}"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {size} {size}" shape-rendering="crispEdges">'
            + "".join(rects) + "</svg>\n")


def main():
    OUT_CHARS.mkdir(parents=True, exist_ok=True)
    OUT_AVATARS.mkdir(parents=True, exist_ok=True)
    roster_path = OUT_CHARS / "roster.json"
    roster = json.loads(roster_path.read_text(encoding="utf-8"))
    ids = {b["id"] for b in COMMUNITY_BOTS}
    roster = [r for r in roster if r["id"] not in ids]
    entries = []
    for b in COMMUNITY_BOTS:
        model = json.loads(Path(b["model"]).read_text(encoding="utf-8"))
        model["key"] = b["charKey"]
        model["color"] = b["color"]
        model["label"] = b["shortName"]
        (OUT_CHARS / f"{b['charKey']}.json").write_text(json.dumps(model, ensure_ascii=False), encoding="utf-8")
        (OUT_AVATARS / f"{b['charKey']}.svg").write_text(model_avatar_svg(model["parts"]), encoding="utf-8")
        entries.append({
            "id": b["id"], "seat": b["seat"], "charKey": b["charKey"], "name": b["name"], "shortName": b["shortName"],
            "rank": None, "rating": elo(b["rating"]), "category": "community",
            "duelRating": elo(b["duel_rating"]), "ffaRating": elo(b["ffa_rating"]),
            "color": b["color"], "avatar": f"/assets/avatars/{b['charKey']}.svg",
            **({"author": b["author"]} if b.get("author") else {}),
        })
    at = next((i for i, r in enumerate(roster) if r.get("category") == "sparring"), len(roster))
    roster[at:at] = entries
    roster_path.write_text(json.dumps(roster, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Exported {len(entries)} community bot(s): " + ", ".join(e["id"] for e in entries))


if __name__ == "__main__":
    main()
