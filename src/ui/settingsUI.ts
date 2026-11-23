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
  FPS_CAP_OPTIONS,
  FpsCapOption,
  getExportResolutionSpec,
  SettingsStore,
} from '../game/settings';

interface CaptureTarget {
  action: ActionBindKey;
  slotIndex: 0 | 1;
}

export class SettingsModal {
  private readonly store: SettingsStore;
  private readonly backdrop: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private openState = false;
  private capturing: CaptureTarget | null = null;
  private noticeText: string | null = null;
  private noticeTimer: number | null = null;
  private onOpenChange?: (open: boolean) => void;
  private onTestSound?: () => void;
  private suppressClickUntil = 0;

  private readonly handleCaptureKeyDown: (e: KeyboardEvent) => void;
  private readonly handleCaptureMouseDown: (e: MouseEvent) => void;
  private readonly handleSuppressClick: (e: MouseEvent) => void;

  constructor(
    store: SettingsStore,
    callbacks: {
      onOpenChange?: (open: boolean) => void;
      onTestSound?: () => void;
    } = {},
  ) {
    this.store = store;
    this.onOpenChange = callbacks.onOpenChange;
    this.onTestSound = callbacks.onTestSound;

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

    // Backdrop click & header close button bound ONCE on persistent shell (never flickers!)
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop && !this.capturing) {
        this.close();
      }
    });
    this.card.querySelector('#settings-close')?.addEventListener('click', () => {
      this.close();
    });

    this.handleCaptureKeyDown = (e: KeyboardEvent) => {
      if (!this.openState) return;
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
    this.render();
    this.backdrop.classList.remove('hidden');
    this.body.scrollTop = 0;
    this.onOpenChange?.(true);
  }

  public close() {
    if (!this.openState) return;
    this.openState = false;
    this.capturing = null;
    this.backdrop.classList.add('hidden');
    this.onOpenChange?.(false);
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

          <!-- FPS Cap Section -->
          <section class="settings-section">
            <div class="settings-sec-head">
              <span class="settings-sec-title">⚡ 帧率上限</span>
              <span class="settings-sec-hint" id="settings-fps-desc">
                ${FPS_CAP_OPTIONS.find((o) => o.value === s.fpsCap)?.desc || ''}
              </span>
            </div>
            <div class="fps-grid">
              ${FPS_CAP_OPTIONS.map((opt) => {
                const active = s.fpsCap === opt.value;
                return `
                  <button
                    type="button"
                    class="fps-btn ${active ? 'active' : ''}"
                    data-fps-cap="${String(opt.value)}"
                    aria-pressed="${active}"
                  >
                    ${opt.label}
                  </button>`;
              }).join('')}
            </div>
          </section>

          <!-- Combat Input Buffer Section -->
          <section class="settings-section">
            <div class="settings-sec-title">🎮 预输入机制</div>
            <div class="settings-toggle-row">
              <div class="settings-toggle-meta">
                <div class="settings-toggle-title">冲刺过程中可以预输入指令</div>
                <div class="settings-toggle-desc">
                  开启后，冲刺中按下的扔镖/挥砍不会打断冲刺，在冲刺结束后首个可操作帧释放（多次输入仅保留最后一个）
                </div>
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
          </section>

          <!-- Cinematic Camera Toggles Section -->
          <section class="settings-section">
            <div class="settings-sec-title">🎥 特写镜头</div>
            <div class="settings-toggle-stack">
              <div class="settings-toggle-row">
                <div class="settings-toggle-meta">
                  <div class="settings-toggle-title">击杀特写</div>
                  <div class="settings-toggle-desc">
                    控制非最后一个击杀：击杀前 0.5s 减速至 0.5x 并平滑切至平视镜头，结束后过渡回常规视角（回放 / 纯 AI 观战 / 导出）
                  </div>
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
                  <div class="settings-toggle-desc">
                    控制最后一个击杀：击杀前 0.5s 减速至 0.25x 并平滑切至平视镜头（回放 / 纯 AI 观战 / 导出）
                  </div>
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
                  <div class="settings-toggle-desc">
                    决出胜者后恢复原速并平滑切至获胜者正面平视特写，同时胜利角色周期性向四周洒出彩带（所有模式及导出均生效）
                  </div>
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

          <!-- Replay MP4 Export Settings Section -->
          <section class="settings-section">
            <div class="settings-sec-head">
              <span class="settings-sec-title">🎬 回放导出 (MP4)</span>
              <span class="settings-sec-hint">
                ${getExportResolutionSpec(s.exportResolution).desc} · ${s.exportBitrateMbps} Mbps · ${s.exportSpeed === 1 ? '1x' : `${s.exportSpeed}x`} · 60fps
              </span>
            </div>
            <div class="export-opts-card">
              <div class="export-opt-row">
                <span class="export-opt-label">分辨率</span>
                <div class="export-opt-grid">
                  ${EXPORT_RESOLUTION_OPTIONS.map((opt) => {
                    const active = s.exportResolution === opt.value;
                    return `<button type="button" class="fps-btn export-opt-btn ${active ? 'active' : ''}" data-export-res="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
              <div class="export-opt-row">
                <span class="export-opt-label">码率</span>
                <div class="export-opt-grid">
                  ${EXPORT_BITRATE_OPTIONS.map((opt) => {
                    const active = s.exportBitrateMbps === opt.value;
                    return `<button type="button" class="fps-btn export-opt-btn ${active ? 'active' : ''}" data-export-bitrate="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
                  }).join('')}
                </div>
              </div>
              <div class="export-opt-row">
                <span class="export-opt-label">播放速度</span>
                <div class="export-opt-grid">
                  ${EXPORT_SPEED_OPTIONS.map((opt) => {
                    const active = s.exportSpeed === opt.value;
                    return `<button type="button" class="fps-btn export-opt-btn ${active ? 'active' : ''}" data-export-speed="${opt.value}" aria-pressed="${active}">${opt.label}</button>`;
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
                <span class="settings-sec-hint">支持键盘与鼠标键 · 每个操作可设 2 个按键</span>
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
    `;
    this.body.scrollTop = prevScrollTop;

    // Sound toggle
    this.body.querySelector('#settings-sound-toggle')?.addEventListener('click', () => {
      const next = !this.store.get().soundEnabled;
      this.store.setSoundEnabled(next);
      if (next) this.onTestSound?.();
      this.render();
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

    // FPS cap selection
    this.body.querySelectorAll<HTMLButtonElement>('[data-fps-cap]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.fpsCap!;
        const parsed: FpsCapOption =
          raw === 'vsync' || raw === 'uncapped' ? raw : (Number(raw) as FpsCapOption);
        this.store.setFpsCap(parsed);
        this.render();
      });
    });

    // Dash pre-input buffer toggle
    this.body.querySelector('#settings-dash-buffer-toggle')?.addEventListener('click', () => {
      this.store.setDashInputBuffer(!this.store.get().dashInputBuffer);
      this.render();
    });

    // Cinematic camera toggles (non-final kill, finisher kill, winner close-up)
    this.body.querySelector('#settings-killcam-toggle')?.addEventListener('click', () => {
      this.store.setKillCam(!this.store.get().killCam);
      this.render();
    });
    this.body.querySelector('#settings-finishercam-toggle')?.addEventListener('click', () => {
      this.store.setFinisherCam(!this.store.get().finisherCam);
      this.render();
    });
    this.body.querySelector('#settings-winnercam-toggle')?.addEventListener('click', () => {
      this.store.setWinnerCam(!this.store.get().winnerCam);
      this.render();
    });

    // Export MP4 option selectors
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-res]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportResolution(btn.dataset.exportRes as ExportResolutionOption);
        this.render();
      });
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-bitrate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportBitrateMbps(Number(btn.dataset.exportBitrate) as ExportBitrateOption);
        this.render();
      });
    });
    this.body.querySelectorAll<HTMLButtonElement>('[data-export-speed]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.store.setExportSpeed(Number(btn.dataset.exportSpeed) as ExportSpeedOption);
        this.render();
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
  }
}
