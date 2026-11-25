export type MobileExportKind = 'mp4' | 'gif';

export interface MobileExportReadyPayload {
  kind: MobileExportKind;
  blob: Blob;
  filename: string;
  metaText: string;
}

export interface MobileExportModalCallbacks {
  onOpenChange?: (open: boolean) => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function buildShareableFile(blob: Blob, filename: string, kind: MobileExportKind): File | null {
  if (typeof File === 'undefined' || typeof navigator === 'undefined') return null;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return null;
  try {
    const mime = kind === 'gif' ? 'image/gif' : 'video/mp4';
    const file = new File([blob], filename, { type: mime });
    return navigator.canShare({ files: [file] }) ? file : null;
  } catch {
    return null;
  }
}

/**
 * Mobile / tablet dedicated export modal:
 * - Runs after exiting DOM fullscreen so browser download bars & native share sheets are never blocked.
 * - Shows a clear progress bar + cancel button during offline rendering/encoding.
 * - Upon completion, presents real user-gesture buttons: native `<a download>` ("保存文件")
 *   and optional Web Share API ("分享 / 存相册"), guaranteeing fresh transient user activation.
 */
export class MobileExportModal {
  private readonly callbacks: MobileExportModalCallbacks;
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly footerEl: HTMLDivElement;

  private openState = false;
  private exporting = false;
  private abortController: AbortController | null = null;
  private activeObjectUrl: string | null = null;
  private sessionSeq = 0;

  private readonly handleKeyDown: (e: KeyboardEvent) => void;

  constructor(callbacks: MobileExportModalCallbacks = {}) {
    this.callbacks = callbacks;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'mobile-export-backdrop hidden';

    this.card = document.createElement('div');
    this.card.className = 'mobile-export-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-modal', 'true');
    this.card.setAttribute('aria-label', '导出进度与保存');
    this.card.innerHTML = `
      <div class="mem-head">
        <h2 class="mem-title" id="mem-title">🎬 正在导出</h2>
        <div class="mem-sub" id="mem-sub"></div>
      </div>
      <div class="mem-body" id="mem-body"></div>
      <div class="mem-footer" id="mem-footer"></div>
    `;

    this.titleEl = this.card.querySelector<HTMLElement>('#mem-title')!;
    this.subEl = this.card.querySelector<HTMLElement>('#mem-sub')!;
    this.bodyEl = this.card.querySelector<HTMLDivElement>('#mem-body')!;
    this.footerEl = this.card.querySelector<HTMLDivElement>('#mem-footer')!;

    this.backdrop.appendChild(this.card);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && !this.exporting) {
        this.close();
      }
    });

    this.handleKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!this.exporting) this.close();
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public isExporting(): boolean {
    return this.exporting;
  }

  public openProgress(opts: {
    kind: MobileExportKind;
    subtitle: string;
    abortController: AbortController;
  }): number {
    this.revokeActiveUrlSoon(0);
    const seq = ++this.sessionSeq;
    const wasOpen = this.openState;
    this.openState = true;
    this.exporting = true;
    this.abortController = opts.abortController;

    this.titleEl.textContent = opts.kind === 'gif' ? '🎞 正在导出 10s GIF' : '🎬 正在导出 MP4';
    this.subEl.textContent = opts.subtitle;

    this.bodyEl.innerHTML = `
      <div class="mem-progress-box">
        <div class="mem-progress-top">
          <span class="mem-phase" id="mem-phase">准备导出...</span>
          <span class="mem-pct" id="mem-pct">1%</span>
        </div>
        <div class="mem-track">
          <div class="mem-fill" id="mem-fill" style="width:1%"></div>
        </div>
        <div class="mem-tip">已暂时退出全屏，导出完成后请点击按钮手动保存或分享</div>
      </div>
    `;

    this.footerEl.innerHTML = `
      <button type="button" class="mem-btn mem-btn-danger" id="mem-cancel-btn">取消导出</button>
    `;
    this.footerEl.querySelector<HTMLButtonElement>('#mem-cancel-btn')?.addEventListener('click', () => {
      const btn = this.footerEl.querySelector<HTMLButtonElement>('#mem-cancel-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '正在取消...';
      }
      this.abortController?.abort();
    });

    this.backdrop.classList.remove('hidden');
    if (!wasOpen) this.callbacks.onOpenChange?.(true);
    return seq;
  }

  public updateProgress(seq: number, progress01: number, phaseText: string) {
    if (!this.openState || !this.exporting || seq !== this.sessionSeq) return;
    const pct = Math.max(1, Math.min(100, Math.round(progress01 * 100)));
    const phaseEl = this.bodyEl.querySelector<HTMLElement>('#mem-phase');
    const pctEl = this.bodyEl.querySelector<HTMLElement>('#mem-pct');
    const fillEl = this.bodyEl.querySelector<HTMLElement>('#mem-fill');
    if (phaseEl) phaseEl.textContent = phaseText;
    if (pctEl) pctEl.textContent = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  }

  public showReady(seq: number, payload: MobileExportReadyPayload) {
    if (!this.openState || seq !== this.sessionSeq) return;
    this.exporting = false;
    this.abortController = null;
    this.revokeActiveUrlSoon(0);

    const url = URL.createObjectURL(payload.blob);
    this.activeObjectUrl = url;
    const shareFile = buildShareableFile(payload.blob, payload.filename, payload.kind);
    const sizeText = formatFileSize(payload.blob.size);

    this.titleEl.textContent = payload.kind === 'gif' ? '✅ GIF 导出完成' : '✅ MP4 导出完成';

    this.bodyEl.innerHTML = `
      <div class="mem-ready-box">
        <div class="mem-file-name" title="${escapeHtml(payload.filename)}">${escapeHtml(payload.filename)}</div>
        <div class="mem-file-meta">${escapeHtml(sizeText)} · ${escapeHtml(payload.metaText)}</div>
        <div class="mem-status-hint" id="mem-status-hint">点击下方按钮保存到本地${shareFile ? '，或通过系统分享存入相册' : ''}</div>
      </div>
    `;

    this.footerEl.innerHTML = `
      <div class="mem-action-row">
        <a
          class="mem-btn mem-btn-primary"
          id="mem-save-link"
          href="${url}"
          download="${escapeHtml(payload.filename)}"
        >⬇ 保存文件</a>
        ${
          shareFile
            ? `<button type="button" class="mem-btn mem-btn-share" id="mem-share-btn">📤 分享 / 存相册</button>`
            : ''
        }
        <button type="button" class="mem-btn mem-btn-secondary" id="mem-close-btn">完成</button>
      </div>
    `;

    const setHint = (text: string, kind: 'normal' | 'ok' | 'err' = 'normal') => {
      const hintEl = this.bodyEl.querySelector<HTMLElement>('#mem-status-hint');
      if (!hintEl) return;
      hintEl.textContent = text;
      hintEl.className = `mem-status-hint ${kind === 'ok' ? 'is-ok' : kind === 'err' ? 'is-err' : ''}`;
    };

    this.footerEl.querySelector<HTMLAnchorElement>('#mem-save-link')?.addEventListener('click', () => {
      // Do NOT preventDefault — let the browser natively handle <a download> with this fresh user gesture!
      setHint(
        shareFile
          ? '已触发浏览器下载（若浏览器未弹出下载，请点击「分享 / 存相册」）'
          : '已触发浏览器下载，请在浏览器下载列表中查看',
        'ok',
      );
    });

    const shareBtn = this.footerEl.querySelector<HTMLButtonElement>('#mem-share-btn');
    if (shareBtn && shareFile) {
      shareBtn.addEventListener('click', async () => {
        shareBtn.disabled = true;
        try {
          await navigator.share({
            files: [shareFile],
            title: payload.filename,
          });
          setHint('已完成系统分享 / 保存', 'ok');
        } catch (err) {
          if (!(err instanceof DOMException && err.name === 'AbortError')) {
            console.warn('Web Share failed:', err);
            setHint('系统分享未能打开，请点击「保存文件」直接下载', 'err');
          }
        } finally {
          shareBtn.disabled = false;
        }
      });
    }

    this.footerEl.querySelector<HTMLButtonElement>('#mem-close-btn')?.addEventListener('click', () => {
      this.close();
    });
  }

  public showError(seq: number, message: string) {
    if (!this.openState || seq !== this.sessionSeq) return;
    this.exporting = false;
    this.abortController = null;
    this.titleEl.textContent = '❌ 导出失败';
    this.bodyEl.innerHTML = `<div class="mem-error-box">${escapeHtml(message)}</div>`;
    this.footerEl.innerHTML = `
      <button type="button" class="mem-btn mem-btn-secondary" id="mem-close-btn">关闭</button>
    `;
    this.footerEl.querySelector<HTMLButtonElement>('#mem-close-btn')?.addEventListener('click', () => {
      this.close();
    });
  }

  public close() {
    if (!this.openState) return;
    if (this.exporting) {
      this.abortController?.abort();
      this.exporting = false;
      this.abortController = null;
    }
    this.sessionSeq++;
    this.openState = false;
    this.backdrop.classList.add('hidden');
    // Keep the Blob URL alive briefly so an in-flight download handoff finishes cleanly
    this.revokeActiveUrlSoon(15_000);
    this.callbacks.onOpenChange?.(false);
  }

  private revokeActiveUrlSoon(delayMs: number) {
    const url = this.activeObjectUrl;
    if (!url) return;
    this.activeObjectUrl = null;
    if (delayMs <= 0) {
      URL.revokeObjectURL(url);
    } else {
      window.setTimeout(() => URL.revokeObjectURL(url), delayMs);
    }
  }
}
