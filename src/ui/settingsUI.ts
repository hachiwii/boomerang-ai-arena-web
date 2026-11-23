import {
  ACTION_META,
  ActionBindKey,
  EXPORT_BITRATE_OPTIONS,
  EXPORT_RESOLUTION_OPTIONS,
  EXPORT_SPEED_OPTIONS,
  ExportBitrateOption,
  ExportResolutionOption,
  ExportSpeedOption,
  formatInputCode,
  getSlashJudgmentDesc,
  GRAPHICS_QUALITY_OPTIONS,
  GraphicsQualityOption,
  SettingsStore,
  SLASH_JUDGMENT_OPTIONS,
  SlashJudgmentOption,
} from '../game/settings';

interface CaptureTarget {
  action: ActionBindKey;
  slotIndex: 0 | 1;
}

type SettingsConfirmKind = 'config' | 'ranked';

export class SettingsModal {
  private readonly store: SettingsStore;
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly confirmBackdrop: HTMLDivElement;
  private readonly confirmTitleEl: HTMLElement;
  private readonly confirmDescEl: HTMLElement;
  private readonly confirmOkBtn: HTMLButtonElement;
  private openState = false;
  private capturing: CaptureTarget | null = null;
  private confirmKind: SettingsConfirmKind | null = null;
  private noticeText: string | null = null;
  private noticeTimer: number | null = null;
  private dangerNoticeText: string | null = null;
  private dangerNoticeTimer: number | null = null;
  private onOpenChange?: (open: boolean) => void;
  private onTestSound?: () => void;
  private onResetConfig?: () => void;
  private onResetRanked?: () => void;
  private suppressClickUntil = 0;

  private readonly handleCaptureKeyDown: (e: KeyboardEvent) => void;
  private readonly handleCaptureMouseDown: (e: MouseEvent) => void;
  private readonly handleSuppressClick: (e: MouseEvent) => void;

  constructor(
    store: SettingsStore,
    callbacks: {
      onOpenChange?: (open: boolean) => void;
      onTestSound?: () => void;
      onResetConfig?: () => void;
      onResetRanked?: () => void;
    } = {},
  ) {
    this.store = store;
    this.onOpenChange = callbacks.onOpenChange;
    this.onTestSound = callbacks.onTestSound;
    this.onResetConfig = callbacks.onResetConfig;
    this.onResetRanked = callbacks.onResetRanked;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'settings-backdrop hidden';

    this.card = document.createElement('div');
    this.card.className = 'settings-card';
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', '游戏设置');
    this.card.innerHTML = `
      <div class="settings-head">
        <h2>⚙️ 游戏设置</h2>
        <button type="button" class="settings-close-btn" id="settings-close" data-close-settings="1">完成</button>
      </div>
    `;
    this.body = document.createElement('div');
    this.body.className = 'settings-body';
    this.card.appendChild(this.body);
    this.backdrop.appendChild(this.card);
    document.body.appendChild(this.backdrop);

    // Secondary confirmation modal portal (mounted above Settings backdrop)
    this.confirmBackdrop = document.createElement('div');
    this.confirmBackdrop.className = 'settings-confirm-backdrop hidden';
    this.confirmBackdrop.innerHTML = `
      <div class="settings-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title">
        <div class="sc-icon" aria-hidden="true">⚠️</div>
        <h3 class="sc-title" id="settings-confirm-title"></h3>
        <p class="sc-desc" id="settings-confirm-desc"></p>
        <div class="sc-actions">
          <button type="button" class="sc-cancel-btn" id="settings-confirm-cancel">取消</button>
          <button type="button" class="settings-danger-btn sc-ok-btn" id="settings-confirm-ok">确认</button>
        </div>
      </div>
    `;
    this.confirmTitleEl = this.confirmBackdrop.querySelector<HTMLElement>('#settings-confirm-title')!;
    this.confirmDescEl = this.confirmBackdrop.querySelector<HTMLElement>('#settings-confirm-desc')!;
    this.confirmOkBtn = this.confirmBackdrop.querySelector<HTMLButtonElement>('#settings-confirm-ok')!;
    document.body.appendChild(this.confirmBackdrop);

    this.confirmBackdrop.addEventListener('click', (e) => {
      if (e.target === this.confirmBackdrop) {
        this.closeConfirmDialog();
      }
    });
    this.confirmBackdrop.querySelector('#settings-confirm-cancel')?.addEventListener('click', () => {
      this.closeConfirmDialog();
    });
    this.confirmOkBtn.addEventListener('click', () => {
      this.executeConfirmedReset();
    });

    // Backdrop click & header close button bound ONCE on persistent shell (never flickers!)
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && !this.capturing && !this.confirmKind) {
        this.close();
      }
    });
    this.card.querySelector('#settings-close')?.addEventListener('click', () => {
      this.close();
    });

    this.handleCaptureKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
      if (this.confirmKind) {
        if (e.code === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          this.closeConfirmDialog();
        }
        return;
      }
      if (this.capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.code === 'Escape') {
          this.stopCapture();
          return;
        }
        this.applyCapturedCode(e.code);
        return;
      }
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };

    this.handleCaptureMouseDown = (e: MouseEvent) => {
      if (!this.openState || !this.capturing) return;
      const target = e.target as Element | null;
      this.suppressClickUntil = performance.now() + 300;
      e.preventDefault();
      e.stopPropagation();
      if (target && target.closest('[data-close-settings]')) {
        this.close();
        return;
      }
      if (target && target.closest('[data-cancel-capture]')) {
        this.stopCapture();
        return;
      }
      this.applyCapturedCode(`Mouse${e.button}`);
    };

    this.handleSuppressClick = (e: MouseEvent) => {
      if (performance.now() < this.suppressClickUntil) {
        this.suppressClickUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('keydown', this.handleCaptureKeyDown, { capture: true });
    window.addEventListener('mousedown', this.handleCaptureMouseDown, { capture: true });
    window.addEventListener('click', this.handleSuppressClick, { capture: true });
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open() {
    if (this.openState) return;
    this.openState = true;
    this.capturing = null;
    this.noticeText = null;
    this.dangerNoticeText = null;
    this.closeConfirmDialog();
    this.render();
    this.backdrop.classList.remove('hidden');
    this.body.scrollTop = 0;
    this.onOpenChange?.(true);
  }

  public close() {
    if (!this.openState) return;
    this.openState = false;
    this.capturing = null;
    this.closeConfirmDialog();
    this.backdrop.classList.add('hidden');
    this.onOpenChange?.(false);
  }

  private openConfirmDialog(kind: SettingsConfirmKind) {
    this.confirmKind = kind;
    if (kind === 'config') {
      this.confirmTitleEl.textContent = '确认重置配置？';
      this.confirmDescEl.textContent =
        '将把设置页与主界面中的所有选项恢复为默认值（含音效、画质、辅助功能、键位、导出设置、排位与斗蛐蛐图池、斗蛐蛐分组与自定义阵容），不会清除排位分数、历史最高分及对局历史。';
      this.confirmOkBtn.textContent = '确认重置配置';
    } else {
      this.confirmTitleEl.textContent = '确认重置排位分数？';
      this.confirmDescEl.textContent =
        '将重置 SOLO 与四人混战的当前 ELO 分数（恢复至 500）、清空所有排位统计数据，并清空历史最高 ELO 与最高名次。此操作不可撤销。';
      this.confirmOkBtn.textContent = '确认重置排位分数';
    }
    this.confirmBackdrop.classList.remove('hidden');
  }

  private closeConfirmDialog() {
    this.confirmKind = null;
    this.confirmBackdrop.classList.add('hidden');
  }

  private showDangerNotice(msg: string) {
    this.dangerNoticeText = msg;
    if (this.dangerNoticeTimer !== null) window.clearTimeout(this.dangerNoticeTimer);
    this.dangerNoticeTimer = window.setTimeout(() => {
      this.dangerNoticeText = null;
      this.dangerNoticeTimer = null;
      this.syncDangerNoticeInPlace();
    }, 3600);
    this.syncDangerNoticeInPlace();
  }

  private syncDangerNoticeInPlace() {
    const el = this.body.querySelector<HTMLElement>('#settings-danger-notice');
    if (!el) return;
    if (this.dangerNoticeText) {
      el.textContent = this.dangerNoticeText;
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  private executeConfirmedReset() {
    const kind = this.confirmKind;
    this.closeConfirmDialog();
    if (kind === 'config') {
      this.capturing = null;
      this.store.resetAll();
      this.onResetConfig?.();
      this.render();
      this.showDangerNotice('✅ 已重置主界面与设置页的全部配置');
    } else if (kind === 'ranked') {
      this.onResetRanked?.();
      this.showDangerNotice('✅ 已重置排位 ELO 分数、统计数据与历史最高记录');
    }
  }

  private showNotice(msg: string) {
    this.noticeText = msg;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeText = null;
      if (this.openState) this.render();
    }, 2800);
  }

  private stopCapture() {
    this.capturing = null;
    if (this.openState) this.render();
  }

  private applyCapturedCode(code: string) {
    if (!this.capturing) return;
    const { action, slotIndex } = this.capturing;
    this.capturing = null;
    const res = this.store.setBinding(action, slotIndex, code);
    if (res.clearedFrom) {
      const oldMeta = ACTION_META.find((m) => m.key === res.clearedFrom);
      const newMeta = ACTION_META.find((m) => m.key === action);
      this.showNotice(
        `已将「${formatInputCode(code)}」从「${oldMeta?.label ?? res.clearedFrom}」移至「${newMeta?.label ?? action}」`,
      );
    } else {
      this.noticeText = null;
    }
    this.render();
  }

  private syncControlsInPlace() {
    const s = this.store.get();

    const setSwitch = (selector: string, isOn: boolean, labelText?: string) => {
      const btn = this.body.querySelector<HTMLButtonElement>(selector);
      if (!btn) return;
      btn.classList.toggle('is-on', isOn);
      btn.setAttribute('aria-checked', String(isOn));
      if (labelText !== undefined) {
        const lbl = btn.querySelector<HTMLElement>('.rand-label');
        if (lbl) lbl.textContent = labelText;
      }
    };

    setSwitch('#settings-sound-toggle', s.soundEnabled, s.soundEnabled ? '音效开启' : '已静音');
    const volWrap = this.body.querySelector<HTMLElement>('.settings-vol-wrap');
    volWrap?.classList.toggle('is-dim', !s.soundEnabled);
    const volSlider = this.body.querySelector<HTMLInputElement>('#settings-vol-slider');
    if (volSlider) {
      volSlider.disabled = !s.soundEnabled;
      volSlider.value = String(s.volume);
      volSlider.style.setProperty('--speed-pct', `${s.volume}%`);
    }
    const volVal = this.body.querySelector<HTMLElement>('#settings-vol-val');
    if (volVal) volVal.textContent = `${s.volume}%`;

    this.body.querySelectorAll<HTMLButtonElement>('[data-graphics-quality]').forEach((btn) => {
      const active = btn.dataset.graphicsQuality === s.graphicsQuality;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    setSwitch('#settings-lock-fps-toggle', s.lockFps, s.lockFps ? '显示器帧率' : '无上限');
    setSwitch('#settings-killcam-toggle', s.killCam, s.killCam ? '已开启' : '已关闭');
    setSwitch('#settings-finishercam-toggle', s.finisherCam, s.finisherCam ? '已开启' : '已关闭');
    setSwitch('#settings-winnercam-toggle', s.winnerCam, s.winnerCam ? '已开启' : '已关闭');
    setSwitch('#settings-dash-buffer-toggle', s.dashInputBuffer, s.dashInputBuffer ? '已开启' : '已关闭');
    setSwitch('#settings-cliff-guard-toggle', s.cliffGuard, s.cliffGuard ? '已开启' : '已关闭');
    setSwitch('#settings-dash-guard-toggle', s.dashGuard, s.dashGuard ? '已开启' : '已关闭');

    this.body.querySelectorAll<HTMLButtonElement>('[data-slash-judgment]').forEach((btn) => {
      const active = btn.dataset.slashJudgment === s.slashJudgment;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    const slashDescEl = this.body.querySelector<HTMLElement>('#settings-slash-desc');
    if (slashDescEl) slashDescEl.textContent = getSlashJudgmentDesc(s.slashJudgment);

    this.body.querySelectorAll<HTMLButtonElement>('[data-export-res]').forEach((btn) => {
      const active = btn.dataset.exportRes === s.exportResolution;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-bitrate]').forEach((btn) => {
      const active = Number(btn.dataset.exportBitrate) === s.exportBitrateMbps;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-speed]').forEach((btn) => {
      const active = Number(btn.dataset.exportSpeed) === s.exportSpeed;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }

  private render() {
    const s = this.store.get();

    const renderSlotCell = (action: ActionBindKey, slotIndex: 0 | 1) => {
      const code = s.keybindings[action][slotIndex];
      const isCap = this.capturing?.action === action && this.capturing?.slotIndex === slotIndex;
      if (isCap) {
        return `
          <div class="kb-slot-wrap is-capturing">
            <button type="button" class="kb-slot-btn capturing" data-bind-action="${action}" data-bind-slot="${slotIndex}">
              请按按键或鼠标...
            </button>
            <button type="button" class="kb-cancel-btn" data-cancel-capture="1" title="取消录入 (ESC)">取消</button>
          </div>`;
      }
      return `
        <div class="kb-slot-wrap">
          <button
            type="button"
            class="kb-slot-btn ${code ? 'has-bind' : 'is-empty'}"
            data-bind-action="${action}"
            data-bind-slot="${slotIndex}"
            title="点击修改按键"
          >
            ${formatInputCode(code)}
          </button>
          ${
            code
              ? `<button type="button" class="kb-clear-btn" data-clear-action="${action}" data-clear-slot="${slotIndex}" title="清除此键位">×</button>`
              : ''
          }
        </div>`;
    };

    const prevScrollTop = this.body.scrollTop;
    this.body.innerHTML = `
          <!-- Audio Section -->
          <section class="settings-section">
            <div class="settings-sec-title">🔊 音效</div>
            <div class="settings-audio-row">
              <button
                type="button"
                class="rand-switch ${s.soundEnabled ? 'is-on' : ''}"
                id="settings-sound-toggle"
                role="switch"
                aria-checked="${s.soundEnabled}"
              >
                <span class="rand-track"><span class="rand-thumb"></span></span>
                <span class="rand-label">${s.soundEnabled ? '音效开启' : '已静音'}</span>
              </button>

              <div class="settings-vol-wrap ${s.soundEnabled ? '' : 'is-dim'}">
                <span class="settings-vol-label">音量</span>
                <input
                  type="range"
                  id="settings-vol-slider"
                  class="speed-slider settings-vol-slider"
                  min="0"
                  max="100"
                  step="5"
                  value="${s.volume}"
                  style="--speed-pct:${s.volume}%"
                  ${s.soundEnabled ? '' : 'disabled'}
                />
                <span class="settings-vol-val" id="settings-vol-val">${s.volume}%</span>
              </div>
            </div>
          </section>

          <!-- Graphics & Display Settings Section -->
          <section class="settings-section">
            <div class="settings-sec-title">🎨 画面设置</div>
            <div class="settings-toggle-stack">
              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">画面质量</div>
                </div>
                <div class="settings-seg" role="group" aria-label="画面质量">
                  ${GRAPHICS_QUALITY_OPTIONS.map((opt) => {
                    const active = s.graphicsQuality === opt.value;
                    return `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-graphics-quality="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">锁定帧率上限</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.lockFps ? 'is-on' : ''}"
                  id="settings-lock-fps-toggle"
                  role="switch"
                  aria-checked="${s.lockFps}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.lockFps ? '显示器帧率' : '无上限'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">击杀特写</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.killCam ? 'is-on' : ''}"
                  id="settings-killcam-toggle"
                  role="switch"
                  aria-checked="${s.killCam}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.killCam ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">终结特写</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.finisherCam ? 'is-on' : ''}"
                  id="settings-finishercam-toggle"
                  role="switch"
                  aria-checked="${s.finisherCam}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.finisherCam ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">获胜特写</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.winnerCam ? 'is-on' : ''}"
                  id="settings-winnercam-toggle"
                  role="switch"
                  aria-checked="${s.winnerCam}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.winnerCam ? '已开启' : '已关闭'}</span>
                </button>
              </div>
            </div>
          </section>

          <!-- Accessibility / Assist Section -->
          <section class="settings-section">
            <div class="settings-sec-head">
              <span class="settings-sec-title">🛡️ 辅助功能</span>
              <span class="settings-sec-hint">仅对真人玩家生效，不影响 AI 表现</span>
            </div>
            <div class="settings-toggle-stack">
              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">跌落防护</div>
                  <div class="settings-toggle-desc">防止正常走路坠崖（冲刺、塌陷、被踢不受影响）</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.cliffGuard ? 'is-on' : ''}"
                  id="settings-cliff-guard-toggle"
                  role="switch"
                  aria-checked="${s.cliffGuard}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.cliffGuard ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">冲刺保护</div>
                  <div class="settings-toggle-desc">冲刺尾部坠崖时，若末尾 25% 存在安全落点则停在最远安全点</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.dashGuard ? 'is-on' : ''}"
                  id="settings-dash-guard-toggle"
                  role="switch"
                  aria-checked="${s.dashGuard}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.dashGuard ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">冲刺预输入</div>
                  <div class="settings-toggle-desc">冲刺中按下扔镖或挥砍不打断冲刺，结束即释放</div>
                </div>
                <button
                  type="button"
                  class="rand-switch ${s.dashInputBuffer ? 'is-on' : ''}"
                  id="settings-dash-buffer-toggle"
                  role="switch"
                  aria-checked="${s.dashInputBuffer}"
                >
                  <span class="rand-track"><span class="rand-thumb"></span></span>
                  <span class="rand-label">${s.dashInputBuffer ? '已开启' : '已关闭'}</span>
                </button>
              </div>

              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">挥砍判定</div>
                  <div class="settings-toggle-desc" id="settings-slash-desc">${getSlashJudgmentDesc(s.slashJudgment)}</div>
                </div>
                <div class="settings-seg" role="group" aria-label="挥砍判定">
                  ${SLASH_JUDGMENT_OPTIONS.map((opt) => {
                    const active = s.slashJudgment === opt.value;
                    return `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-slash-judgment="${opt.value}" aria-pressed="${active}" title="${opt.desc}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
            </div>
          </section>

          <!-- Replay MP4 Export Settings Section -->
          <section class="settings-section">
            <div class="settings-sec-head">
              <span class="settings-sec-title">🎬 回放导出 (MP4)</span>
            </div>
            <div class="export-opts-card">
              <div class="export-opt-row">
                <span class="export-opt-label">分辨率</span>
                <div class="settings-seg settings-seg-full" role="group" aria-label="导出分辨率">
                  ${EXPORT_RESOLUTION_OPTIONS.map((opt) => {
                    const active = s.exportResolution === opt.value;
                    return `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-export-res="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
              <div class="export-opt-row">
                <span class="export-opt-label">码率</span>
                <div class="settings-seg settings-seg-full" role="group" aria-label="导出码率">
                  ${EXPORT_BITRATE_OPTIONS.map((opt) => {
                    const active = s.exportBitrateMbps === opt.value;
                    return `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-export-bitrate="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
              <div class="export-opt-row">
                <span class="export-opt-label">播放速度</span>
                <div class="settings-seg settings-seg-full" role="group" aria-label="导出播放速度">
                  ${EXPORT_SPEED_OPTIONS.map((opt) => {
                    const active = s.exportSpeed === opt.value;
                    return `<button type="button" class="settings-seg-btn ${active ? 'active' : ''}" data-export-speed="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
            </div>
          </section>

          <!-- Keybindings Section -->
          <section class="settings-section">
            <div class="settings-sec-head">
              <span class="settings-sec-title">⌨️ 键位设置</span>
              <div class="settings-kb-tools">
                <button type="button" class="settings-reset-kb-btn" id="settings-reset-kb">恢复默认键位</button>
              </div>
            </div>
            ${this.noticeText ? `<div class="settings-notice">${this.noticeText}</div>` : ''}
            <div class="kb-table">
              <div class="kb-header-row">
                <span>操作</span>
                <span>按键 1</span>
                <span>按键 2</span>
              </div>
              ${ACTION_META.map(
                (meta) => `
                <div class="kb-row">
                  <div class="kb-action-cell">
                    <span class="kb-group-chip">${meta.group}</span>
                    <span class="kb-action-label">${meta.label}</span>
                  </div>
                  ${renderSlotCell(meta.key, 0)}
                  ${renderSlotCell(meta.key, 1)}
                </div>`,
              ).join('')}
            </div>
          </section>

          <!-- Danger / Reset Section -->
          <section class="settings-section settings-danger-section">
            <div class="settings-sec-title">⚠️ 重置选项与数据</div>
            <div class="settings-danger-notice ${this.dangerNoticeText ? '' : 'hidden'}" id="settings-danger-notice">${this.dangerNoticeText || ''}</div>
            <div class="settings-toggle-stack">
              <div class="settings-toggle-row settings-danger-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">重置配置</div>
                  <div class="settings-toggle-desc">恢复主界面与设置页中的全部选项（含图池、斗蛐蛐分组、自定义阵容与键位）</div>
                </div>
                <button type="button" class="settings-danger-btn" id="settings-reset-config-btn">重置配置</button>
              </div>

              <div class="settings-toggle-row settings-danger-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">重置排位分数</div>
                  <div class="settings-toggle-desc">重置 ELO 分数与排位统计数据，并清空历史最高分数与名次</div>
                </div>
                <button type="button" class="settings-danger-btn" id="settings-reset-ranked-btn">重置排位分数</button>
              </div>
            </div>
          </section>
    `;
    this.body.scrollTop = prevScrollTop;

    // Sound toggle
    this.body.querySelector('#settings-sound-toggle')?.addEventListener('click', () => {
      const next = !this.store.get().soundEnabled;
      this.store.setSoundEnabled(next);
      if (next) this.onTestSound?.();
      this.syncControlsInPlace();
    });

    // Volume slider
    const volSlider = this.body.querySelector<HTMLInputElement>('#settings-vol-slider');
    const volVal = this.body.querySelector<HTMLElement>('#settings-vol-val');
    volSlider?.addEventListener('input', () => {
      const v = Number(volSlider.value);
      this.store.setVolume(v);
      volSlider.style.setProperty('--speed-pct', `${v}%`);
      if (volVal) volVal.textContent = `${v}%`;
    });
    volSlider?.addEventListener('change', () => {
      if (this.store.get().soundEnabled && this.store.get().volume > 0) {
        this.onTestSound?.();
      }
    });

    // Graphics quality selection
    this.body.querySelectorAll<HTMLButtonElement>('[data-graphics-quality]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setGraphicsQuality(btn.dataset.graphicsQuality as GraphicsQualityOption);
        this.syncControlsInPlace();
      });
    });

    // Lock FPS cap toggle (ON = monitor refresh rate, OFF = uncapped)
    this.body.querySelector('#settings-lock-fps-toggle')?.addEventListener('click', () => {
      this.store.setLockFps(!this.store.get().lockFps);
      this.syncControlsInPlace();
    });

    // Dash pre-input buffer toggle
    this.body.querySelector('#settings-dash-buffer-toggle')?.addEventListener('click', () => {
      this.store.setDashInputBuffer(!this.store.get().dashInputBuffer);
      this.syncControlsInPlace();
    });

    // Accessibility / Assist toggles (cliff guard, dash guard, dash pre-input & slash judgment)
    this.body.querySelector('#settings-cliff-guard-toggle')?.addEventListener('click', () => {
      this.store.setCliffGuard(!this.store.get().cliffGuard);
      this.syncControlsInPlace();
    });
    this.body.querySelector('#settings-dash-guard-toggle')?.addEventListener('click', () => {
      this.store.setDashGuard(!this.store.get().dashGuard);
      this.syncControlsInPlace();
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-slash-judgment]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setSlashJudgment(btn.dataset.slashJudgment as SlashJudgmentOption);
        this.syncControlsInPlace();
      });
    });

    // Cinematic camera toggles (non-final kill, finisher kill, winner close-up)
    this.body.querySelector('#settings-killcam-toggle')?.addEventListener('click', () => {
      this.store.setKillCam(!this.store.get().killCam);
      this.syncControlsInPlace();
    });
    this.body.querySelector('#settings-finishercam-toggle')?.addEventListener('click', () => {
      this.store.setFinisherCam(!this.store.get().finisherCam);
      this.syncControlsInPlace();
    });
    this.body.querySelector('#settings-winnercam-toggle')?.addEventListener('click', () => {
      this.store.setWinnerCam(!this.store.get().winnerCam);
      this.syncControlsInPlace();
    });

    // Export MP4 option selectors
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-res]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportResolution(btn.dataset.exportRes as ExportResolutionOption);
        this.syncControlsInPlace();
      });
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-bitrate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportBitrateMbps(Number(btn.dataset.exportBitrate) as ExportBitrateOption);
        this.syncControlsInPlace();
      });
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportSpeed(Number(btn.dataset.exportSpeed) as ExportSpeedOption);
        this.syncControlsInPlace();
      });
    });

    // Keybinding slot capture
    this.body.querySelectorAll<HTMLButtonElement>('[data-bind-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.bindAction as ActionBindKey;
        const slotIndex = Number(btn.dataset.bindSlot) as 0 | 1;
        this.capturing = { action, slotIndex };
        this.render();
      });
    });

    // Clear individual slot
    this.body.querySelectorAll<HTMLButtonElement>('[data-clear-action]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.clearAction as ActionBindKey;
        const slotIndex = Number(btn.dataset.clearSlot) as 0 | 1;
        this.store.setBinding(action, slotIndex, null);
        this.render();
      });
    });

    // Reset default keybindings
    this.body.querySelector('#settings-reset-kb')?.addEventListener('click', () => {
      this.capturing = null;
      this.store.resetKeybindings();
      this.showNotice('已恢复默认键位');
      this.render();
    });

    // Bottom danger reset buttons (each opens secondary confirmation dialog)
    this.body.querySelector('#settings-reset-config-btn')?.addEventListener('click', () => {
      this.openConfirmDialog('config');
    });
    this.body.querySelector('#settings-reset-ranked-btn')?.addEventListener('click', () => {
      this.openConfirmDialog('ranked');
    });
  }
}
