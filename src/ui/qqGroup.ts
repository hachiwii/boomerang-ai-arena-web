// 玩家 QQ 群：PC 标题行的群号胶囊（点击复制）+ 移动端企鹅按钮弹窗（群号 + 复制按钮）。弹窗沿用分享弹窗的样式。

export const QQ_GROUP_NUMBER = '1135491994';

/** A simple original penguin glyph (not the QQ brand mark) for the mobile header button and the dialog title. */
export const ICON_PENGUIN = `<svg class="penguin-ico" viewBox="0 0 24 24" aria-hidden="true">
  <ellipse cx="8.7" cy="21.5" rx="2.7" ry="1.15" fill="#ffb21f"/>
  <ellipse cx="15.3" cy="21.5" rx="2.7" ry="1.15" fill="#ffb21f"/>
  <path d="M12 1.9c-3.9 0-6.4 3.1-6.4 7.2 0 1.2.2 2.3.5 3.3-1.3 1.3-2.1 3-2.1 4.7 0 2.9 3.5 4.5 8 4.5s8-1.6 8-4.5c0-1.7-.8-3.4-2.1-4.7.3-1 .5-2.1.5-3.3 0-4.1-2.5-7.2-6.4-7.2z" fill="#1e2638" stroke="rgba(226,236,255,.75)" stroke-width=".7"/>
  <ellipse cx="12" cy="15.6" rx="4.3" ry="5" fill="#f7fbff"/>
  <ellipse cx="12" cy="8.5" rx="3.8" ry="3.3" fill="#f7fbff"/>
  <circle cx="10.5" cy="7.9" r="1" fill="#1e2638"/>
  <circle cx="13.5" cy="7.9" r="1" fill="#1e2638"/>
  <path d="M10.3 9.9h3.4L12 11.7z" fill="#ffb21f"/>
</svg>`;

export async function copyPlainText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall back to execCommand below
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** PC title-row pill: shows the group number; clicking it copies the number and flashes 已复制. */
export function qqGroupPillHtml(): string {
  return `<button type="button" class="lobby-qq-pill" id="btn-copy-qq-group" title="点击复制群号" aria-label="玩家 QQ 群 ${QQ_GROUP_NUMBER}，点击复制群号">
    <span class="lobby-qq-label">玩家 QQ 群：</span><span class="lobby-qq-num">${QQ_GROUP_NUMBER}</span>
  </button>`;
}

export function bindQqGroupPill(btn: HTMLButtonElement | null) {
  if (!btn) return;
  let timer = 0;
  btn.addEventListener('click', () => {
    void copyPlainText(QQ_GROUP_NUMBER).then((ok) => {
      const num = btn.querySelector<HTMLElement>('.lobby-qq-num');
      if (!num) return;
      num.textContent = ok ? '已复制 ✓' : QQ_GROUP_NUMBER;
      btn.classList.toggle('is-copied', ok);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        num.textContent = QQ_GROUP_NUMBER;
        btn.classList.remove('is-copied');
      }, 1600);
    });
  });
}

/**
 * Official QQ logo, if the site ships one: drop Tencent's icon file at public/assets/brand/qq-logo.svg (or .png).
 * Until then (or if it fails to load) the original penguin above is shown.
 */
const QQ_LOGO_SVG = '/assets/brand/qq-logo.svg';
const QQ_LOGO_PNG = '/assets/brand/qq-logo.png';

function qqIconHtml(): string {
  const onerror = `if(!this.dataset.png){this.dataset.png='1';this.src='${QQ_LOGO_PNG}'}else{this.remove()}`;
  return `<span class="qq-ico"><img class="qq-logo-img" src="${QQ_LOGO_SVG}" alt="" draggable="false" onerror="${onerror}" />${ICON_PENGUIN}</span>`;
}

/** Mobile header button (icon only, like the other header buttons there). */
export function qqGroupButtonHtml(): string {
  return `<button type="button" class="lobby-settings-btn lobby-qq-btn" id="btn-open-qq-group" title="玩家 QQ 群" aria-label="玩家 QQ 群"><span class="nav-ico">${qqIconHtml()}</span><span class="nav-label"> QQ 群</span></button>`;
}

let openDialog: { close: () => void } | null = null;

export function openQqGroupDialog() {
  openDialog?.close();
  const backdrop = document.createElement('div');
  backdrop.className = 'share-backdrop qq-backdrop';
  backdrop.innerHTML = `
    <div class="share-card qq-card" role="dialog" aria-modal="true" aria-labelledby="qq-title">
      <div class="share-head">
        <span class="share-head-icon qq-head-icon">${qqIconHtml()}</span>
        <span class="share-title" id="qq-title">玩家 QQ 群</span>
        <button type="button" class="share-close" aria-label="关闭">×</button>
      </div>
      <div class="share-body">
        <div class="share-hint">复制群号，在 QQ 里搜索加群。</div>
        <div class="share-link-row">
          <input class="share-link-input qq-num-input" type="text" readonly spellcheck="false" aria-label="QQ 群号" />
          <button type="button" class="share-copy-btn">复制群号</button>
        </div>
      </div>
    </div>`;
  const input = backdrop.querySelector<HTMLInputElement>('.qq-num-input')!;
  const btn = backdrop.querySelector<HTMLButtonElement>('.share-copy-btn')!;
  input.value = QQ_GROUP_NUMBER;
  input.addEventListener('focus', () => input.select());
  let closed = false;
  let timer = 0;
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (openDialog === handle) openDialog = null;
  };
  const handle = { close };
  btn.addEventListener('click', () => {
    void copyPlainText(QQ_GROUP_NUMBER).then((ok) => {
      if (closed) return;
      if (!ok) {
        input.focus();
        input.select();
      }
      btn.textContent = ok ? '已复制 ✓' : '请手动复制';
      btn.classList.toggle('is-done', ok);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        btn.textContent = '复制群号';
        btn.classList.remove('is-done');
      }, 2000);
    });
  });
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  });
  backdrop.querySelector('.share-close')!.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  document.body.appendChild(backdrop);
  openDialog = handle;
}
