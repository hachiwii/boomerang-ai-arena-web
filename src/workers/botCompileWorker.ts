/// <reference lib="webworker" />
/**
 * Compiles an uploaded single-file bot (player.cpp + dart.hpp + standard library, the original contest's rule)
 * to a wasm32-wasip1 reactor with in-browser clang (@yowasp/clang). The ~100 MB toolchain is only fetched
 * on the first compile of the session; this worker stays alive afterwards so later compiles reuse it.
 */
import dartHpp from '../../wasm/include/dart.hpp?raw';
import { CLANG_ARGS, compileInputs } from '../game/customBots/compileConfig';
import { checkSource } from '../game/customBots/sourceCheck';
import { sha256Hex } from '../game/customBots/sha256';
import { missingExports, unsupportedImports } from '../game/customBots/wasiBotRuntime';

import type { Command } from '@yowasp/clang';

// The bundle exports `runClang` (see the package README) but its .d.ts omits it
type ClangApi = { runClang: Command; runLLVM: Command };

export type CompileWorkerRequest = { type: 'compile'; reqId: number; source: string };

export type CompileWorkerMessage =
  | { type: 'progress'; reqId: number; stage: 'download'; done: number; total: number }
  | { type: 'progress'; reqId: number; stage: 'compile' }
  | { type: 'result'; reqId: number; ok: true; wasm: ArrayBuffer; hash: string; ms: number; warnings: string }
  | { type: 'result'; reqId: number; ok: false; stage: 'check' | 'compile' | 'validate' | 'load'; message: string };

let clangPromise: Promise<ClangApi> | null = null;
let downloadSink: ((done: number, total: number) => void) | null = null;

/**
 * Imports the toolchain and prefetches its resources (wasm + sysroot) with progress. runClang's own first step
 * (`clang -###`) doesn't forward `fetchProgress`, so without this the download would only be logged to the console.
 */
const loadClang = () => {
  if (!clangPromise) {
    clangPromise = (async () => {
      const api = (await import('@yowasp/clang')) as unknown as ClangApi;
      // args = null: fetch resources only, run nothing (YoWASP runtime prefetch convention; the .d.ts doesn't allow null)
      await api.runLLVM(null as unknown as string[], {}, {
        fetchProgress: ({ doneLength, totalLength }: { doneLength: number; totalLength: number }) =>
          downloadSink?.(doneLength, totalLength),
      });
      return api;
    })().catch((err) => {
      clangPromise = null; // allow a retry after a network failure
      throw err;
    });
  }
  return clangPromise;
};

const post = (msg: CompileWorkerMessage, transfer: Transferable[] = []) =>
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer);

async function compile(reqId: number, source: string) {
  const problems = checkSource(source);
  if (problems.length > 0) {
    post({ type: 'result', reqId, ok: false, stage: 'check', message: problems.join('\n') });
    return;
  }

  let clang: ClangApi;
  let lastPost = 0;
  downloadSink = (done, total) => {
    const now = performance.now();
    if (done < total && now - lastPost < 100) return; // ~10 updates/s is plenty
    lastPost = now;
    post({ type: 'progress', reqId, stage: 'download', done, total });
  };
  try {
    clang = await loadClang();
  } catch (err) {
    post({ type: 'result', reqId, ok: false, stage: 'load', message: `编译器加载失败：${errText(err)}` });
    return;
  } finally {
    downloadSink = null;
  }
  post({ type: 'progress', reqId, stage: 'compile' });

  let stderr = '';
  const dec = new TextDecoder();
  const t0 = performance.now();
  let files: Record<string, unknown> | undefined;
  try {
    const out = await clang.runClang(
      CLANG_ARGS,
      compileInputs(source, dartHpp),
      {
        stdout: () => {},
        stderr: (bytes: Uint8Array | null) => {
          if (bytes) stderr += dec.decode(bytes, { stream: true });
        },
      },
    );
    files = out as Record<string, unknown> | undefined;
  } catch (err) {
    const msg = stderr.trim() || errText(err);
    post({ type: 'result', reqId, ok: false, stage: 'compile', message: tidyLog(msg) });
    return;
  }
  const ms = performance.now() - t0;

  const wasm = files?.['bot.wasm'];
  if (!(wasm instanceof Uint8Array)) {
    post({ type: 'result', reqId, ok: false, stage: 'compile', message: tidyLog(stderr.trim() || '编译器没有生成 bot.wasm') });
    return;
  }

  let module: WebAssembly.Module;
  try {
    module = await WebAssembly.compile(wasm as BufferSource);
  } catch (err) {
    post({ type: 'result', reqId, ok: false, stage: 'validate', message: `生成的 wasm 无效：${errText(err)}` });
    return;
  }
  const badImports = unsupportedImports(module);
  const missing = missingExports(module);
  if (badImports.length > 0 || missing.length > 0) {
    const lines: string[] = [];
    if (missing.length > 0) lines.push(`缺少导出 ${missing.join(', ')}：文件末尾需要 DART_MAIN(你的结构体名)`);
    if (badImports.length > 0) lines.push(`用到了网页里无法提供的系统接口：${badImports.join(', ')}`);
    post({ type: 'result', reqId, ok: false, stage: 'validate', message: lines.join('\n') });
    return;
  }

  const hash = await sha256Hex(wasm);
  const buf = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer;
  post({ type: 'result', reqId, ok: true, wasm: buf, hash, ms, warnings: tidyLog(stderr.trim()) }, [buf]);
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Readable compiler output: virtual-FS paths shortened, and capped so a template avalanche doesn't flood the UI. */
function tidyLog(text: string): string {
  const cleaned = text.replace(/\/tmp\/player-[0-9a-f]+\.o/g, 'player.o');
  const MAX = 12000;
  return cleaned.length > MAX ? `${cleaned.slice(0, MAX)}\n…（输出过长，已截断）` : cleaned;
}

self.onmessage = (ev: MessageEvent<CompileWorkerRequest>) => {
  const msg = ev.data;
  if (msg?.type === 'compile') {
    void compile(msg.reqId, String(msg.source ?? '')).catch((err) => {
      post({ type: 'result', reqId: msg.reqId, ok: false, stage: 'compile', message: errText(err) });
    });
  }
};
