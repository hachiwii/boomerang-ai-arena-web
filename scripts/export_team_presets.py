#!/usr/bin/env python3
"""Export the 5v5 team-match presets (formation + tactics sheet of every round) from the upstream repo.

Upstream: chen-006/meow-ai-arena, folder boomerang-team/rounds/R1..R6/{Astra队,Fable队}/{正式,备选1,备选2}/
(布阵.json + optional 战术.txt). Usage:

    python3 scripts/export_team_presets.py <path-to>/meow-ai-arena/boomerang-team

writes public/assets/team/presets.json, which the team-match lobby offers as 策略 presets.
Coordinates stay as upstream writes them: metres, written as if the team sits on the left.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "assets" / "team" / "presets.json"

ROUNDS = [  # round -> (mode, map)
    (1, 3, "caldera"), (2, 3, "caldera"),
    (3, 4, "piers"), (4, 4, "piers"),
    (5, 5, "keeps"), (6, 5, "keeps"),
]
TEAMS = {"astra": "Astra队", "fable": "Fable队"}
VARIANTS = ["正式", "备选1", "备选2"]
ORDER = {
    "astra": ["astra", "sol", "hydrogen", "grok", "kimi"],
    "fable": ["fable", "opus", "carbon", "glm", "deepseek"],
}


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    base = Path(sys.argv[1]) / "rounds"
    out = []
    for rnd, mode, map_id in ROUNDS:
        entry = {"round": rnd, "mode": mode, "map": map_id, "teams": {}}
        for team, folder in TEAMS.items():
            sets = []
            for variant in VARIANTS:
                d = base / f"R{rnd}" / folder / variant
                form = json.loads((d / "布阵.json").read_text(encoding="utf-8-sig"))
                plan_path = d / "战术.txt"
                plan = plan_path.read_bytes().decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n") if plan_path.exists() else ""
                spawns = {name: form["站位"][name] for name in ORDER[team]}
                sets.append({
                    "variant": variant,
                    "spawns": spawns,
                    "king": form.get("国王") if mode == 5 else None,
                    "plan": plan.rstrip("\n"),
                })
            entry["teams"][team] = sets
        out.append(entry)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT.relative_to(ROOT)} ({len(out)} rounds)")


if __name__ == "__main__":
    main()
