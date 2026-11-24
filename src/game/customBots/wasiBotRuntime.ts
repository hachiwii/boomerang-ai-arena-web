/**
 * Runs a user bot compiled in the browser (clang → wasm32-wasip1 reactor, see dart.hpp `DART_WASI_BOT`).
 *
 * The module only sees a tiny WASI surface: no files, no args/env, stdout/stderr discarded,
 * clocks and random wired to the host. Same text protocol as the bundled Emscripten bots:
 * `bot_init(header)` once, then `bot_decide(obs)` → "MX MY ACT AX AY MSG" each step.
 *
 * Written with erasable TypeScript only (no enums / parameter properties) so Node can run it directly in tests.
 */

export interface WasiBot {
  init(header: string): boolean;
  decide(obs: string): string;
}

/** Thrown when the bot calls exit() (proc_exit); a trap (abort, out-of-bounds…) surfaces as WebAssembly.RuntimeError. */
export class WasiExit extends Error {
  public readonly code: number;
  constructor(code: number) {
    super(`bot exited with code ${code}`);
    this.code = code;
  }
}

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

const REQUIRED_EXPORTS = ['memory', '_initialize', 'bot_alloc', 'bot_free', 'bot_init', 'bot_decide'] as const;

/** Imports a compiled module needs that this runtime cannot provide (anything outside wasi_snapshot_preview1). */
export function unsupportedImports(module: WebAssembly.Module): string[] {
  return WebAssembly.Module.imports(module)
    .filter((imp) => imp.module !== 'wasi_snapshot_preview1')
    .map((imp) => `${imp.module}.${imp.name}`);
}

export function missingExports(module: WebAssembly.Module): string[] {
  const have = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
  return REQUIRED_EXPORTS.filter((n) => !have.has(n));
}

export async function instantiateWasiBot(module: WebAssembly.Module): Promise<WasiBot> {
  const bad = unsupportedImports(module);
  if (bad.length > 0) throw new Error(`不支持的导入：${bad.join(', ')}`);
  const missing = missingExports(module);
  if (missing.length > 0) throw new Error(`缺少导出：${missing.join(', ')}`);

  let memory: WebAssembly.Memory | null = null;
  const view = () => new DataView(memory!.buffer);
  const bytes = () => new Uint8Array(memory!.buffer);

  const nowNs = (clockId: number): bigint => {
    // 0 = realtime; 1 = monotonic; 2/3 = process/thread CPU time (wall clock is the best a browser can do)
    if (clockId === 0) return BigInt(Date.now()) * 1000000n;
    return BigInt(Math.round(performance.now() * 1e6));
  };

  const wasi: Record<string, (...args: never[]) => number> = {
    args_sizes_get: (argc: number, argvBufSize: number) => {
      view().setUint32(argc, 0, true);
      view().setUint32(argvBufSize, 0, true);
      return ERRNO_SUCCESS;
    },
    args_get: () => ERRNO_SUCCESS,
    environ_sizes_get: (count: number, bufSize: number) => {
      view().setUint32(count, 0, true);
      view().setUint32(bufSize, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get: () => ERRNO_SUCCESS,
    clock_res_get: (clockId: number, out: number) => {
      if (clockId < 0 || clockId > 3) return ERRNO_INVAL;
      view().setBigUint64(out, 1000n, true);
      return ERRNO_SUCCESS;
    },
    clock_time_get: (clockId: number, _precision: bigint, out: number) => {
      if (clockId < 0 || clockId > 3) return ERRNO_INVAL;
      view().setBigUint64(out, nowNs(clockId), true);
      return ERRNO_SUCCESS;
    },
    fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number) => {
      if (fd !== 1 && fd !== 2) return ERRNO_BADF;
      // stdout / stderr are discarded: the protocol goes through bot_decide's return value
      const dv = view();
      let total = 0;
      for (let i = 0; i < iovsLen; i++) total += dv.getUint32(iovs + i * 8 + 4, true);
      dv.setUint32(nwritten, total, true);
      return ERRNO_SUCCESS;
    },
    fd_read: (fd: number, _iovs: number, _iovsLen: number, nread: number) => {
      if (fd !== 0) return ERRNO_BADF;
      view().setUint32(nread, 0, true); // stdin is always at EOF
      return ERRNO_SUCCESS;
    },
    fd_close: (fd: number) => (fd <= 2 ? ERRNO_SUCCESS : ERRNO_BADF),
    fd_seek: (fd: number) => (fd <= 2 ? ERRNO_SPIPE : ERRNO_BADF),
    fd_fdstat_get: (fd: number, out: number) => {
      if (fd > 2) return ERRNO_BADF;
      const dv = view();
      dv.setUint8(out, 2); // character device
      dv.setUint16(out + 2, 0, true);
      dv.setBigUint64(out + 8, 0n, true);
      dv.setBigUint64(out + 16, 0n, true);
      return ERRNO_SUCCESS;
    },
    fd_prestat_get: () => ERRNO_BADF, // no preopened directories: no file access at all
    fd_prestat_dir_name: () => ERRNO_BADF,
    random_get: (buf: number, len: number) => {
      const u8 = bytes();
      for (let off = 0; off < len; off += 65536) {
        crypto.getRandomValues(u8.subarray(buf + off, buf + Math.min(len, off + 65536)));
      }
      return ERRNO_SUCCESS;
    },
    sched_yield: () => ERRNO_SUCCESS,
    proc_exit: (code: number) => {
      throw new WasiExit(code);
    },
  };

  const wasiImports: Record<string, (...args: never[]) => number> = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') throw new Error(`不支持的导入：${imp.module}.${imp.name}`);
    wasiImports[imp.name] = wasi[imp.name] ?? (() => ERRNO_NOSYS);
  }

  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasiImports });
  const ex = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    _initialize: () => void;
    bot_alloc: (n: number) => number;
    bot_free: (p: number) => void;
    bot_init: (p: number) => number;
    bot_decide: (p: number) => number;
  };
  memory = ex.memory;
  ex._initialize(); // static constructors

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const withCString = <T>(text: string, fn: (ptr: number) => T): T => {
    const data = enc.encode(text);
    const ptr = ex.bot_alloc(data.length + 1) >>> 0;
    if (!ptr) throw new Error('bot_alloc failed');
    const u8 = bytes();
    u8.set(data, ptr);
    u8[ptr + data.length] = 0;
    try {
      return fn(ptr);
    } finally {
      ex.bot_free(ptr);
    }
  };

  const readCString = (ptr: number): string => {
    const u8 = bytes();
    let end = ptr;
    while (end < u8.length && u8[end] !== 0) end++;
    return dec.decode(u8.subarray(ptr, end));
  };

  return {
    init: (header) => withCString(header, (p) => ex.bot_init(p)) === 1,
    decide: (obs) => withCString(obs, (p) => readCString(ex.bot_decide(p) >>> 0)),
  };
}
