#!/usr/bin/env python3
"""Compile authoritative dart.hpp engine and all 16 C++ bots into Emscripten WASM modules."""
import concurrent.futures
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WASM_DIR = ROOT / "wasm"
INC_DIR = WASM_DIR / "include"
BOTS_SRC = WASM_DIR / "bots"
OUT_DIR = ROOT / "public" / "wasm"
OUT_BOTS = OUT_DIR / "bots"

COMMON_FLAGS = [
    "-std=c++17",
    "-O3",
    "-I", str(INC_DIR),
    "-sMODULARIZE=1",
    "-sEXPORT_ES6=1",
    "-sENVIRONMENT=web,worker,node",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sGROWABLE_ARRAYBUFFERS=0",
    "-sSTACK_SIZE=4194304",
    "-sINITIAL_MEMORY=33554432",
    "-sEXPORTED_RUNTIME_METHODS=[\"ccall\",\"cwrap\",\"UTF8ToString\"]",
    "-sNO_EXIT_RUNTIME=1",
    "-Wno-everything",
]


def build_engine():
    t0 = time.time()
    out_js = OUT_DIR / "engine.js"
    cmd = [
        "em++",
        str(WASM_DIR / "engine_wasm.cpp"),
        *COMMON_FLAGS,
        "-sEXPORT_NAME=createEngineModule",
        "-sEXPORTED_FUNCTIONS=[\"_engine_init\",\"_engine_set_human_seat\",\"_engine_last_error\",\"_engine_get_header\",\"_engine_get_obs\",\"_engine_step\",\"_engine_get_map_json\",\"_engine_get_state_json\"]",
        "-o", str(out_js),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        return ("engine", False, res.stderr)
    sz = (OUT_DIR / "engine.wasm").stat().st_size // 1024
    return ("engine", True, f"{sz} KB ({time.time() - t0:.1f}s)")


def build_bot(cpp_path: Path):
    t0 = time.time()
    bot_id = cpp_path.stem
    out_js = OUT_BOTS / f"{bot_id}.js"
    cmd = [
        "em++",
        str(cpp_path),
        "-DDART_WASM_BOT",
        *COMMON_FLAGS,
        "-sEXPORT_NAME=createBotModule",
        "-sEXPORTED_FUNCTIONS=[\"_bot_init\",\"_bot_decide\"]",
        "-o", str(out_js),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        return (bot_id, False, res.stderr)
    sz = (OUT_BOTS / f"{bot_id}.wasm").stat().st_size // 1024
    return (bot_id, True, f"{sz} KB ({time.time() - t0:.1f}s)")


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    OUT_BOTS.mkdir(parents=True, exist_ok=True)
    bot_files = sorted(BOTS_SRC.glob("*.cpp"))
    print(f"Building engine + {len(bot_files)} C++ bots to WASM...")

    failures = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 4)) as ex:
        futs = [ex.submit(build_engine)] + [ex.submit(build_bot, f) for f in bot_files]
        for fut in concurrent.futures.as_completed(futs):
            name, ok, msg = fut.result()
            status = "OK  " if ok else "FAIL"
            print(f"  [{status}] {name:24s} {msg}")
            if not ok:
                failures.append((name, msg))

    if failures:
        print(f"\n{len(failures)} build(s) failed!", file=sys.stderr)
        sys.exit(1)
    print(f"\nAll {1 + len(bot_files)} WASM modules compiled successfully!")


if __name__ == "__main__":
    main()
