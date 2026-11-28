// 分享对局的弹窗：上传中 → 短链接（一键复制）/ 失败（重试）。按键在弹窗打开时不会传到游戏（ESC 只关弹窗）。
import { ICON_SHARE } from './icons';

let openDialog: { close: () => void } | null = null;

export function isShareDialogOpen(): boolean {
  return openDialog !== null;
}

export function closeShareDialog() {
  openDialog?.close();
}

async function copyText(text: string, input: HTMLInputElement): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 退到下面的老办法
  }
  try {
    input.focus();
    input.select();
    input.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  }
}

/** 打开分享链接（?r=）时盖住页面直到回放开始，不露出大厅；返回的函数把它去掉。 */
export function showShareOpening(): () => void {
  const el = document.createElement('div');
  el.className = 'share-opening';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="share-spinner" aria-hidden="true"></span><span>正在打开分享的回放…</span>`;
  document.body.appendChild(el);
  return () => {
    el.classList.add('is-leaving');
    window.setTimeout(() => el.remove(), 220);
  };
}

/**
 * 打开分享弹窗并开始上传。`upload` 返回短链接；失败时弹窗显示原因和「重试」。
 */
export function openShareDialog(upload: () => Promise<{ url: string }>) {
  closeShareDialog();
  const backdrop = document.createElement('div');
  backdrop.className = 'share-backdrop';
  backdrop.innerHTML = `
    <div class="share-card" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div class="share-head">
        <span class="share-head-icon">${ICON_SHARE}</span>
        <span class="share-title" id="share-title">分享对局</span>
        <button type="button" class="share-close" aria-label="关闭">×</button>
      </div>
      <div class="share-body"></div>
    </div>`;
  const card = backdrop.querySelector<HTMLElement>('.share-card')!;
  const body = backdrop.querySelector<HTMLElement>('.share-body')!;
  let closed = false;
  let seq = 0;

  const onKey = (e: KeyboardEvent) => {
    // 弹窗打开时按键不给游戏（ESC 退出、空格暂停、R 重开…）；输入框里的复制、Tab 等默认行为照常
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    seq++;
    window.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (openDialog === handle) openDialog = null;
  };
  const handle = { close };

  const showLoading = () => {
    body.innerHTML = `
      <div class="share-status"><span class="share-spinner" aria-hidden="true"></span>正在压缩并上传对局…</div>`;
  };
  const showResult = (url: string) => {
    body.innerHTML = `
      <div class="share-hint">复制链接发给好友，打开就能看这局回放。</div>
      <div class="share-link-row">
        <input class="share-link-input" type="text" readonly spellcheck="false" aria-label="分享链接" />
        <button type="button" class="share-copy-btn">复制链接</button>
      </div>`;
    const input = body.querySelector<HTMLInputElement>('.share-link-input')!;
    const btn = body.querySelector<HTMLButtonElement>('.share-copy-btn')!;
    input.value = url;
    input.addEventListener('focus', () => input.select());
    let resetTimer = 0;
    btn.addEventListener('click', () => {
      void copyText(url, input).then((ok) => {
        if (closed) return;
        btn.textContent = ok ? '已复制 ✓' : '请手动复制';
        btn.classList.toggle('is-done', ok);
        window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          btn.textContent = '复制链接';
          btn.classList.remove('is-done');
        }, 2000);
      });
    });
    btn.focus();
  };
  const showError = (message: string) => {
    body.innerHTML = `
      <div class="share-error"></div>
      <div class="share-actions">
        <button type="button" class="share-retry-btn">重试</button>
      </div>`;
    body.querySelector<HTMLElement>('.share-error')!.textContent = message;
    body.querySelector<HTMLButtonElement>('.share-retry-btn')!.addEventListener('click', run);
  };
  function run() {
    const mine = ++seq;
    showLoading();
    void upload().then(
      ({ url }) => {
        if (mine === seq && !closed) showResult(url);
      },
      (err: unknown) => {
        console.warn('Share upload failed:', err);
        if (mine === seq && !closed) showError(err instanceof Error ? err.message : String(err));
      },
    );
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.share-close')!.addEventListener('click', close);
  // 鼠标按键也不传给游戏（鼠标可以绑快捷键）
  for (const type of ['mousedown', 'pointerdown', 'touchstart', 'wheel'] as const) {
    backdrop.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
  }
  card.addEventListener('contextmenu', (e) => e.stopPropagation());
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  openDialog = handle;
  run();
}
