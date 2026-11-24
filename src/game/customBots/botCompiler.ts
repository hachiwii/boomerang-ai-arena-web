import type { CompileWorkerMessage } from '../../workers/botCompileWorker';

export type CompileProgress =
  | { stage: 'download'; done: number; total: number }
  | { stage: 'compile' };

export type CompileResult =
  | { ok: true; wasm: ArrayBuffer; hash: string; ms: number; warnings: string }
  | { ok: false; stage: 'check' | 'compile' | 'validate' | 'load'; message: string };

/**
 * Main-thread handle to the compile worker. The worker (and with it the in-browser clang) is only created on the
 * first compile request, then kept for the rest of the session so the toolchain is downloaded once.
 */
export class BotCompiler {
  private worker: Worker | null = null;
  private reqSeq = 1;
  private pending = new Map<number, { resolve: (r: CompileResult) => void; onProgress?: (p: CompileProgress) => void }>();
  private toolchainReady = false;

  /** True once a compile has finished in this session (the compiler is downloaded and warm). */
  public isToolchainReady(): boolean {
    return this.toolchainReady;
  }

  public compile(source: string, onProgress?: (p: CompileProgress) => void): Promise<CompileResult> {
    const w = this.ensureWorker();
    const reqId = this.reqSeq++;
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve, onProgress });
      w.postMessage({ type: 'compile', reqId, source });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(new URL('../../workers/botCompileWorker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (ev: MessageEvent<CompileWorkerMessage>) => {
      const msg = ev.data;
      const p = this.pending.get(msg.reqId);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.stage === 'download' ? { stage: 'download', done: msg.done, total: msg.total } : { stage: 'compile' });
        return;
      }
      this.pending.delete(msg.reqId);
      if (msg.ok) {
        this.toolchainReady = true;
        p.resolve({ ok: true, wasm: msg.wasm, hash: msg.hash, ms: msg.ms, warnings: msg.warnings });
      } else {
        if (msg.stage !== 'load' && msg.stage !== 'check') this.toolchainReady = true;
        p.resolve({ ok: false, stage: msg.stage, message: msg.message });
      }
    };
    w.onerror = (ev) => {
      // A crash of the worker itself (e.g. out of memory while compiling): fail everything in flight and start over next time
      const message = ev.message || '编译进程异常退出';
      for (const p of this.pending.values()) p.resolve({ ok: false, stage: 'compile', message });
      this.pending.clear();
      w.terminate();
      if (this.worker === w) this.worker = null;
    };
    this.worker = w;
    return w;
  }
}
