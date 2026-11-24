import { ICON_BOOMERANG, ICON_DESKTOP, ICON_PHONE } from './icons';

export interface LaunchScreenOptions {
  /** Element fullscreen (or an installed home-screen app) is available in this browser. */
  fullscreenSupported: boolean;
  /** Runs inside the tap handler (fullscreen / orientation lock need that user gesture). */
  onChoose: (choice: 'mobile' | 'desktop') => Promise<void>;
}

/**
 * Touch-device launch page shown on every load: one tap picks the presentation.
 * 移动端 (emphasised) → mobile mode + fullscreen + landscape (auto-rotates where the browser allows,
 * otherwise the app lays itself out sideways); 桌面端 → desktop layout with keyboard / mouse hints.
 * Works in either orientation, since it appears before anything is rotated.
 */
export function showLaunchScreen(opts: LaunchScreenOptions) {
  const el = document.createElement('div');
  el.className = 'launch-screen';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '选择游玩方式');
  el.innerHTML = `
    <div class="launch-card">
      <div class="launch-brand">
        <div class="launch-logo">${ICON_BOOMERANG}</div>
        <div class="launch-titles">
          <h1>回旋镖大作战</h1>
          <p>Boomerang AI Arena</p>
        </div>
      </div>
      <div class="launch-actions">
        <button type="button" class="launch-btn is-primary" data-launch="mobile">
          <span class="launch-btn-icon">${ICON_PHONE}</span>
          <span class="launch-btn-text">
            <strong>移动端</strong>
            <small>推荐 · 自动横屏全屏 · 触屏摇杆操作</small>
          </span>
        </button>
        <button type="button" class="launch-btn" data-launch="desktop">
          <span class="launch-btn-icon">${ICON_DESKTOP}</span>
          <span class="launch-btn-text">
            <strong>桌面端</strong>
            <small>键盘鼠标操作</small>
          </span>
        </button>
      </div>
      ${
        opts.fullscreenSupported
          ? ''
          : `<div class="launch-hint">当前浏览器不支持网页全屏 · 可通过「分享 → 添加到主屏幕」以全屏启动</div>`
      }
    </div>
  `;
  document.body.appendChild(el);

  let busy = false;
  el.querySelectorAll<HTMLButtonElement>('[data-launch]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (busy) return;
      busy = true;
      const choice = btn.dataset.launch === 'desktop' ? 'desktop' : 'mobile';
      btn.classList.add('is-busy');
      // Kick off fullscreen synchronously inside the gesture, then fade the page out
      void opts.onChoose(choice).finally(() => {
        el.classList.add('is-leaving');
        window.setTimeout(() => el.remove(), 260);
      });
    });
  });
}
