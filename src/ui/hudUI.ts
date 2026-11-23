import { EloUpdateResult, LadderEntrySnap } from '../game/leaderboard';
import { GifClipExportResult } from '../game/gifExporter';
import { CountdownStage } from '../game/matchController';
import { MatchReplayBundle } from '../game/matchHistory';
import { Mp4ExportResult } from '../game/mp4Exporter';
import { ReplayPlaybackState } from '../game/replayController';
import { formatDashSummary, formatMoveSummary, formatPrimaryBind, SettingsStore } from '../game/settings';
import { CauseType, DState, MatchConfig, MatchMode, PState, RankedMode, SlotConfig, TickSnapshot } from '../game/types';

export interface HudCallbacks {
  onReturnToLobby: (opts?: { openLeaderboard?: boolean; openHistory?: boolean; rankedMode?: RankedMode }) => void;
  onRestartMatch: () => void;
  onOpenSettings: () => void;
  onToggleCliffGuard: () => boolean;
  onRankCue?: (kind: 'up' | 'down') => void;
  onReplayTogglePause?: () => void;
  onReplayRestart?: () => void;
  onReplaySeek?: (tickIndex: number) => void;
  onReplaySpeed?: (speed: number) => void;
  onReplayExportMp4?: (
    bundle: MatchReplayBundle,
    signal: AbortSignal,
    onProgress: (progress01: number, phaseText: string) => void,
  ) => Promise<Mp4ExportResult>;
  onReplayExportGif?: (
    bundle: MatchReplayBundle,
    endTickIndex: number,
    signal: AbortSignal,
    onProgress: (progress01: number, phaseText: string) => void,
  ) => Promise<GifClipExportResult>;
}

function causeLabel(cause: number, killerName?: string): string {
  if (cause === CauseType.DART) return killerName ? `被 ${killerName} 飞镖命中` : '被飞镖命中';
  if (cause === CauseType.SLASH) return killerName ? `被 ${killerName} 挥砍出局` : '被挥砍出局';
  if (cause === CauseType.FALL) return killerName ? `被 ${killerName} 踢入深渊` : '跌落浮岛';
  return '存活';
}

function dartBadge(st: number): { text: string; cls: string } {
  switch (st) {
    case DState.HAND:
      return { text: '持镖', cls: 'st-hand' };
    case DState.OUT:
    case DState.BACK:
    case DState.CALL:
      return { text: '飞行', cls: 'st-fly' };
    case DState.GROUND:
      return { text: '落地', cls: 'st-ground' };
    case DState.RISE:
      return { text: '召回', cls: 'st-recall' };
    default:
      return { text: '无镖', cls: 'st-gone' };
  }
}

export class HudUI {
  private readonly root: HTMLDivElement;
  public readonly nameplateLayer: HTMLDivElement;
  private readonly topBar: HTMLDivElement;
  private readonly bottomBar: HTMLDivElement;
  private readonly eloToastEl: HTMLDivElement;
  private readonly countdownOverlay: HTMLDivElement;
  private readonly resultOverlay: HTMLDivElement;
  private readonly settings: SettingsStore;
  private readonly callbacks: HudCallbacks;

  private slots: SlotConfig[] = [];
  private matchMode: MatchMode = 'custom';
  private humanSeat = -1;
  private isReplayMode = false;
  private replayBundle: MatchReplayBundle | null = null;
  private cliffGuard = true;
  private lastTickState: TickSnapshot | null = null;
  private autoReturnTimer: number | null = null;
  private countdownInterval: number | null = null;
  private eloToastTimer: number | null = null;
  private rankAnimTimers: number[] = [];
  private rankAnimRaf: number | null = null;

  // Cached DOM references for ultra-fast HUD updates (no full innerHTML rebuild per tick!)
  private timerEl: HTMLElement | null = null;
  private collapseEl: HTMLElement | null = null;
  private perfEl: HTMLElement | null = null;
  private cardEls: {
    card: HTMLElement;
    kills: HTMLElement;
    dart: HTMLElement;
    cdBar: HTMLElement;
  }[] = [];
  private humanHintMove: HTMLElement | null = null;
  private humanHintLeft: HTMLElement | null = null;
  private humanHintRight: HTMLElement | null = null;
  private humanHintShift: HTMLElement | null = null;

  // Cached replay controls DOM
  private replayIsLiveAi = false;
  private replayComputing = false;
  private replayPlayBtn: HTMLButtonElement | null = null;
  private replaySlider: HTMLInputElement | null = null;
  private replayMarkersEl: HTMLElement | null = null;
  private replayTimeEl: HTMLElement | null = null;
  private replayBannerEl: HTMLElement | null = null;
  private replaySpeedBtns: HTMLButtonElement[] = [];
  private replayExportBtn: HTMLButtonElement | null = null;
  private replayGifBtn: HTMLButtonElement | null = null;
  private replayExportStatusEl: HTMLElement | null = null;
  private replayExportAbort: AbortController | null = null;
  private replayExportNoticeTimer: number | null = null;
  private replayCurrentTickIndex = 0;

  constructor(parent: HTMLElement, settings: SettingsStore, callbacks: HudCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;

    this.settings.onChange(() => {
      this.refreshKeyHints();
    });

    this.nameplateLayer = document.createElement('div');
    this.nameplateLayer.className = 'nameplate-layer';
    parent.appendChild(this.nameplateLayer);

    this.root = document.createElement('div');
    this.root.className = 'hud-root hidden';
    parent.appendChild(this.root);

    this.topBar = document.createElement('div');
    this.topBar.className = 'hud-top';
    this.root.appendChild(this.topBar);

    this.bottomBar = document.createElement('div');
    this.bottomBar.className = 'hud-bottom';
    this.root.appendChild(this.bottomBar);

    this.eloToastEl = document.createElement('div');
    this.eloToastEl.className = 'hud-elo-toast hidden';
    this.root.appendChild(this.eloToastEl);

    this.countdownOverlay = document.createElement('div');
    this.countdownOverlay.className = 'countdown-overlay hidden';
    this.root.appendChild(this.countdownOverlay);

    this.resultOverlay = document.createElement('div');
    this.resultOverlay.className = 'result-overlay hidden';
    this.root.appendChild(this.resultOverlay);
  }

  public setCountdown(stage: CountdownStage) {
    if (stage === null) {
      this.countdownOverlay.classList.add('hidden');
      this.countdownOverlay.innerHTML = '';
      return;
    }

    if (stage === 'GO') {
      this.countdownOverlay.innerHTML = `
        <div class="cd-stage cd-go">
          <div class="cd-ring cd-ring-go"></div>
          <div class="cd-value">GO!</div>
        </div>
      `;
    } else {
      const humanSlot = this.humanSeat >= 0 ? this.slots[this.humanSeat] : null;
      const accent = humanSlot ? humanSlot.ringAccent || humanSlot.color : '#6bb8ff';
      const subHtml = humanSlot
        ? `<div class="cd-sub"><span class="cd-dot" style="background:${accent}"></span>你在 <strong>P${this.humanSeat + 1}</strong> 位置 · 准备开战</div>`
        : '';
      this.countdownOverlay.innerHTML = `
        <div class="cd-stage cd-num cd-n${stage}">
          <div class="cd-ring"></div>
          <div class="cd-value">${stage}</div>
          ${subHtml}
        </div>
      `;
    }
    this.countdownOverlay.classList.remove('hidden');
  }

  public showMatch(config: MatchConfig, humanSeat: number) {
    this.clearTimers();
    this.isReplayMode = false;
    this.replayBundle = null;
    this.clearReplayRefs();
    this.slots = config.slots;
    this.matchMode = config.matchMode;
    this.humanSeat = humanSeat;
    this.cliffGuard = config.cliffGuard;
    this.setCountdown(null);
    this.resultOverlay.classList.add('hidden');
    this.nameplateLayer.classList.remove('hidden');
    this.root.classList.remove('hidden');

    const mapTag =
      config.matchMode === 'ranked-solo'
        ? `${config.mapMeta.title} · SOLO 排位`
        : config.matchMode === 'ranked-ffa'
          ? `${config.mapMeta.title} · 混战排位`
          : `${config.mapMeta.title}${humanSeat < 0 ? ' · 观战' : ''}${Math.abs((config.speed || 1) - 1) > 0.01 ? ` · ${config.speed.toFixed(1)}x` : ''}`;

    this.topBar.innerHTML = `
      <div class="hud-players">
        ${config.slots
          .map(
            (s, i) => `
          <div class="hud-pcard ${s.kind === 'human' ? 'is-human' : ''}" data-pcard="${i}" style="--pcol:${s.ringAccent || s.color}">
            <img class="hud-avatar" src="${s.avatar || ''}" alt="" />
            <div class="hud-pmeta">
              <div class="hud-pname">${s.displayName}</div>
              <div class="hud-pstats">
                <span class="hud-dart st-hand" data-pdart="${i}">持镖</span>
                <span class="hud-kills" data-pkills="${i}">0 击杀</span>
              </div>
              <div class="hud-cd-track"><div class="hud-cd-fill" data-pcd="${i}"></div></div>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <div class="hud-center-pill">
        <div class="hud-map-label">${mapTag}</div>
        <div class="hud-timer" id="hud-timer">40.0s</div>
        <div class="hud-collapse" id="hud-collapse">塌陷倒计时 12s</div>
      </div>

      <div class="hud-actions">
        <div class="hud-perf" id="hud-perf">20Hz · --Hz</div>
        ${
          humanSeat >= 0
            ? `<button class="hud-btn ${this.cliffGuard ? 'active' : ''}" id="hud-cliff-guard" title="跌落防护：开启时不会走路坠崖；冲刺末尾 25% 若有安全落点会自动停在最远安全点">🛡️ 跌落防护: ${this.cliffGuard ? '开' : '关'}</button>`
            : ''
        }
        <button class="hud-btn" id="hud-settings" title="音效、帧率上限与键位设置">⚙️ 设置</button>
        <button class="hud-btn hud-exit" id="hud-exit">主界面 (ESC)</button>
      </div>
    `;

    this.timerEl = this.topBar.querySelector('#hud-timer');
    this.collapseEl = this.topBar.querySelector('#hud-collapse');
    this.perfEl = this.topBar.querySelector('#hud-perf');
    this.cardEls = config.slots.map((_, i) => ({
      card: this.topBar.querySelector(`[data-pcard="${i}"]`)!,
      kills: this.topBar.querySelector(`[data-pkills="${i}"]`)!,
      dart: this.topBar.querySelector(`[data-pdart="${i}"]`)!,
      cdBar: this.topBar.querySelector(`[data-pcd="${i}"]`)!,
    }));

    this.topBar.querySelector('#hud-exit')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });
    this.topBar.querySelector('#hud-settings')?.addEventListener('click', () => {
      this.callbacks.onOpenSettings();
    });
    this.topBar.querySelector('#hud-cliff-guard')?.addEventListener('click', (e) => {
      this.cliffGuard = this.callbacks.onToggleCliffGuard();
      const btn = e.currentTarget as HTMLButtonElement;
      btn.classList.toggle('active', this.cliffGuard);
      btn.textContent = `🛡️ 跌落防护: ${this.cliffGuard ? '开' : '关'}`;
    });

    this.lastTickState = null;
    this.renderBottomHints(humanSeat);
  }

  private clearReplayRefs() {
    if (this.replayExportAbort) {
      this.replayExportAbort.abort();
      this.replayExportAbort = null;
    }
    if (this.replayExportNoticeTimer !== null) {
      window.clearTimeout(this.replayExportNoticeTimer);
      this.replayExportNoticeTimer = null;
    }
    this.replayIsLiveAi = false;
    this.replayComputing = false;
    this.replayPlayBtn = null;
    this.replaySlider = null;
    this.replayMarkersEl = null;
    this.replayTimeEl = null;
    this.replayBannerEl = null;
    this.replaySpeedBtns = [];
    this.replayExportBtn = null;
    this.replayGifBtn = null;
    this.replayExportStatusEl = null;
    this.replayCurrentTickIndex = 0;
  }

  private renderReplayDeathMarkersHtml(bundle: MatchReplayBundle): string {
    const { summary, replay } = bundle;
    const maxIdx = Math.max(1, replay.ticks.length - 1);
    const out: string[] = [];
    for (let i = 1; i < replay.ticks.length; i++) {
      for (const ev of replay.ticks[i].events) {
        if (ev.name === 'DEATH') {
          const victim = summary.slots[ev.a];
          const pct = (i / maxIdx) * 100;
          const color = victim?.ringAccent || victim?.color || '#ff6b6b';
          const title = `${(replay.ticks[i].t / 20).toFixed(1)}s · ${victim?.displayName || `P${ev.a + 1}`} 出局`;
          out.push(`<span class="replay-marker" style="left:${pct.toFixed(2)}%;background:${color}" title="${title}"></span>`);
        }
      }
    }
    return out.join('');
  }

  private buildReplayEndBannerText(bundle: MatchReplayBundle): string {
    const { summary } = bundle;
    const winnerSlot = summary.winner >= 0 ? summary.slots[summary.winner] : null;
    if (this.replayIsLiveAi) {
      const rst = formatPrimaryBind(this.settings.get().keybindings.quickRestart, 'R');
      return winnerSlot
        ? `🏆 对局结束 · 胜者：${winnerSlot.displayName} · 按 ${rst} 重开或拖动进度条回看`
        : `🤝 对局结束 · 平局 · 按 ${rst} 重开或拖动进度条回看`;
    }
    return summary.earlyExit
      ? '🏁 回放结束（提前结算） · 点击重播或拖动进度条'
      : winnerSlot
        ? `🏆 回放结束 · 胜者：${winnerSlot.displayName}`
        : '🤝 回放结束 · 平局';
  }

  private getExportPresetLabel(): string {
    const s = this.settings.get();
    const spd = s.exportSpeed === 1 ? '1x' : `${s.exportSpeed}x`;
    return `${s.exportResolution} · ${s.exportBitrateMbps} Mbps · ${spd}`;
  }

  public showReplay(
    bundle: MatchReplayBundle,
    playback: ReplayPlaybackState,
    opts?: { liveAiSpectator?: boolean },
  ) {
    this.clearTimers();
    this.isReplayMode = true;
    this.replayIsLiveAi = Boolean(opts?.liveAiSpectator);
    this.replayComputing = Boolean(playback.computing);
    this.replayBundle = bundle;
    const { summary, replay } = bundle;
    this.slots = summary.slots;
    this.matchMode = summary.matchMode;
    this.humanSeat = -1; // Spectator perspective
    this.setCountdown(null);
    this.resultOverlay.classList.add('hidden');
    this.nameplateLayer.classList.remove('hidden');
    this.root.classList.remove('hidden');

    const modeTag =
      summary.matchMode === 'ranked-solo'
        ? 'SOLO 排位'
        : summary.matchMode === 'ranked-ffa'
          ? '混战排位'
          : '自定义';
    const rstKey = formatPrimaryBind(this.settings.get().keybindings.quickRestart, 'R');

    this.topBar.innerHTML = `
      <div class="hud-players">
        ${summary.slots
          .map(
            (s, i) => `
          <div class="hud-pcard ${s.kind === 'human' ? 'is-human' : ''}" data-pcard="${i}" style="--pcol:${s.ringAccent || s.color}">
            <img class="hud-avatar" src="${s.avatar || ''}" alt="" />
            <div class="hud-pmeta">
              <div class="hud-pname">${s.displayName}</div>
              <div class="hud-pstats">
                <span class="hud-dart st-hand" data-pdart="${i}">持镖</span>
                <span class="hud-kills" data-pkills="${i}">0 击杀</span>
              </div>
              <div class="hud-cd-track"><div class="hud-cd-fill" data-pcd="${i}"></div></div>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <div class="hud-center-pill hud-replay-pill">
        <div class="hud-map-label"><span class="hud-replay-tag">${this.replayIsLiveAi ? '🤖 AI 观战' : '🎬 观战回放'}</span> ${summary.mapTitle} · ${modeTag}</div>
        <div class="hud-timer" id="hud-timer">40.0s</div>
        <div class="hud-collapse" id="hud-collapse">塌陷倒计时 12s</div>
      </div>

      <div class="hud-actions">
        <div class="hud-perf" id="hud-perf">${this.replayIsLiveAi ? 'AI 观战' : '回放'} ${playback.speed.toFixed(1)}x</div>
        ${
          this.replayIsLiveAi
            ? `<button class="hud-btn" id="hud-ai-restart" title="使用当前配置重新开局 (${rstKey})">↺ 重开 (${rstKey})</button>`
            : ''
        }
        <button class="hud-btn" id="hud-replay-history" title="返回对局历史列表">📜 对局历史</button>
        <button class="hud-btn" id="hud-settings" title="音效、特写镜头与导出设置">⚙️ 设置</button>
        <button class="hud-btn hud-exit" id="hud-exit">${this.replayIsLiveAi ? '主界面 (ESC)' : '退出回放 (ESC)'}</button>
      </div>
    `;

    this.timerEl = this.topBar.querySelector('#hud-timer');
    this.collapseEl = this.topBar.querySelector('#hud-collapse');
    this.perfEl = this.topBar.querySelector('#hud-perf');
    this.cardEls = summary.slots.map((_, i) => ({
      card: this.topBar.querySelector(`[data-pcard="${i}"]`)!,
      kills: this.topBar.querySelector(`[data-pkills="${i}"]`)!,
      dart: this.topBar.querySelector(`[data-pdart="${i}"]`)!,
      cdBar: this.topBar.querySelector(`[data-pcd="${i}"]`)!,
    }));

    this.topBar.querySelector('#hud-exit')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });
    this.topBar.querySelector('#hud-ai-restart')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onRestartMatch();
    });
    this.topBar.querySelector('#hud-replay-history')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby({ openHistory: true });
    });
    this.topBar.querySelector('#hud-settings')?.addEventListener('click', () => {
      this.callbacks.onOpenSettings();
    });

    const maxTick = replay.ticks[playback.maxIndex]?.t ?? playback.maxIndex;
    const totalSec = (maxTick / 20).toFixed(1);
    const endBannerText = this.buildReplayEndBannerText(bundle);
    const exportPreset = this.getExportPresetLabel();

    this.bottomBar.innerHTML = `
      <div class="replay-dock">
        <div class="replay-export-status hidden" id="replay-export-status"></div>
        <div class="replay-end-banner hidden" id="replay-end-banner">${endBannerText}</div>
        <div class="replay-bar">
          <button type="button" class="replay-ctrl-btn replay-play-btn" id="replay-play-btn" title="播放 / 暂停 (Space)">⏸ 暂停</button>
          <button type="button" class="replay-ctrl-btn" id="replay-restart-btn" title="从头重播">↺ 重播</button>

          <div class="replay-timeline-wrap">
            <div class="replay-markers" id="replay-markers" aria-hidden="true">
              ${this.renderReplayDeathMarkersHtml(bundle)}
            </div>
            <input
              type="range"
              class="replay-slider"
              id="replay-slider"
              min="0"
              max="${playback.maxIndex}"
              step="1"
              value="${playback.tickIndex}"
              style="--rep-pct:0%"
              aria-label="回放进度条"
            />
          </div>

          <span class="replay-time" id="replay-time">0.0s / ${totalSec}s</span>

          <div class="replay-speed-group" role="group" aria-label="回放倍速">
            ${[0.5, 1.0, 1.5, 2.0]
              .map(
                (sp) =>
                  `<button type="button" class="replay-spd-btn ${Math.abs(playback.speed - sp) < 0.01 ? 'active' : ''}" data-replay-speed="${sp}">${sp === 1 ? '1x' : `${sp}x`}</button>`,
              )
              .join('')}
          </div>

          <button
            type="button"
            class="replay-ctrl-btn replay-export-btn"
            id="replay-export-btn"
            title="${this.replayComputing ? '后台对局推演完成后即可导出完整 MP4' : `导出本局观战回放 MP4（当前设置：${exportPreset}）`}"
            ${this.replayComputing ? 'disabled' : ''}
          >${this.replayComputing ? '⏳ 计算中' : '⬇ 导出'}</button>

          <button
            type="button"
            class="replay-ctrl-btn replay-gif-btn"
            id="replay-gif-btn"
            title="截取当前时间点往前最长 10s 画面为 720p 24fps GIF（暂停背景飘云并移除飘落物，保留其他动效）"
          >🎞 10s GIF</button>
        </div>
      </div>
    `;

    this.humanHintMove = null;
    this.humanHintLeft = null;
    this.humanHintRight = null;
    this.humanHintShift = null;

    this.replayPlayBtn = this.bottomBar.querySelector('#replay-play-btn');
    this.replaySlider = this.bottomBar.querySelector('#replay-slider');
    this.replayMarkersEl = this.bottomBar.querySelector('#replay-markers');
    this.replayTimeEl = this.bottomBar.querySelector('#replay-time');
    this.replayBannerEl = this.bottomBar.querySelector('#replay-end-banner');
    this.replaySpeedBtns = Array.from(this.bottomBar.querySelectorAll<HTMLButtonElement>('[data-replay-speed]'));
    this.replayExportBtn = this.bottomBar.querySelector('#replay-export-btn');
    this.replayGifBtn = this.bottomBar.querySelector('#replay-gif-btn');
    this.replayExportStatusEl = this.bottomBar.querySelector('#replay-export-status');

    this.replayPlayBtn?.addEventListener('click', () => {
      this.callbacks.onReplayTogglePause?.();
    });
    this.bottomBar.querySelector('#replay-restart-btn')?.addEventListener('click', () => {
      this.callbacks.onReplayRestart?.();
    });
    this.replaySlider?.addEventListener('input', () => {
      if (!this.replaySlider) return;
      this.callbacks.onReplaySeek?.(Number(this.replaySlider.value));
    });
    for (const btn of this.replaySpeedBtns) {
      btn.addEventListener('click', () => {
        this.callbacks.onReplaySpeed?.(Number(btn.dataset.replaySpeed));
      });
    }
    this.replayExportBtn?.addEventListener('click', () => {
      this.startReplayHudExport();
    });
    this.replayGifBtn?.addEventListener('click', () => {
      this.startReplayGifExport();
    });

    this.lastTickState = null;
    this.updateReplayControls(playback);
  }

  private showReplayExportResultBanner(text: string, isOk: boolean) {
    if (!this.isReplayMode || !this.replayExportStatusEl) return;
    if (this.replayExportNoticeTimer !== null) {
      window.clearTimeout(this.replayExportNoticeTimer);
      this.replayExportNoticeTimer = null;
    }
    this.replayExportStatusEl.className = `replay-export-status ${isOk ? 'is-ok' : 'is-err'}`;
    this.replayExportStatusEl.textContent = text;
    this.replayExportNoticeTimer = window.setTimeout(() => {
      this.replayExportNoticeTimer = null;
      this.replayExportStatusEl?.classList.add('hidden');
    }, 4800);
  }

  private setReplayExportButtonsBusy(activeKind: 'mp4' | 'gif' | null) {
    if (this.replayExportBtn) {
      const mp4WaitingSim = activeKind === null && this.replayComputing;
      this.replayExportBtn.disabled = activeKind !== null || mp4WaitingSim;
      this.replayExportBtn.classList.toggle('is-exporting', activeKind === 'mp4');
      if (activeKind === 'mp4') {
        this.replayExportBtn.textContent = '导出 1%';
      } else if (mp4WaitingSim) {
        this.replayExportBtn.textContent = '⏳ 计算中';
      } else {
        this.replayExportBtn.textContent = '⬇ 导出';
      }
    }
    if (this.replayGifBtn) {
      this.replayGifBtn.disabled = activeKind !== null;
      this.replayGifBtn.classList.toggle('is-exporting', activeKind === 'gif');
      if (activeKind === 'gif') {
        this.replayGifBtn.textContent = 'GIF 1%';
      } else {
        this.replayGifBtn.textContent = '🎞 10s GIF';
      }
    }
  }

  private startReplayHudExport() {
    if (
      !this.isReplayMode ||
      !this.replayBundle ||
      this.replayComputing ||
      this.replayExportAbort ||
      !this.callbacks.onReplayExportMp4
    ) {
      return;
    }
    const bundle = this.replayBundle;
    const preset = this.getExportPresetLabel();
    const abortCtrl = new AbortController();
    this.replayExportAbort = abortCtrl;

    if (this.replayExportNoticeTimer !== null) {
      window.clearTimeout(this.replayExportNoticeTimer);
      this.replayExportNoticeTimer = null;
    }

    this.setReplayExportButtonsBusy('mp4');

    if (this.replayExportStatusEl) {
      this.replayExportStatusEl.className = 'replay-export-status';
      this.replayExportStatusEl.innerHTML = `
        <div class="res-row">
          <span class="res-text" id="res-text">🎬 正在导出 MP4 (${preset}) · 准备中...</span>
          <span class="res-pct" id="res-pct">1%</span>
          <button type="button" class="heb-cancel-btn" id="res-cancel">取消</button>
        </div>
        <div class="heb-track"><div class="heb-fill" id="res-fill" style="width:1%"></div></div>
      `;
      this.replayExportStatusEl.querySelector('#res-cancel')?.addEventListener('click', () => {
        this.replayExportAbort?.abort();
      });
    }

    void this.callbacks
      .onReplayExportMp4(bundle, abortCtrl.signal, (p01, phaseText) => {
        if (this.replayExportAbort !== abortCtrl) return;
        const pct = Math.max(0, Math.min(100, Math.round(p01 * 100)));
        if (this.replayExportBtn) this.replayExportBtn.textContent = `导出 ${pct}%`;
        const txt = this.replayExportStatusEl?.querySelector('#res-text');
        const pctEl = this.replayExportStatusEl?.querySelector('#res-pct');
        const fill = this.replayExportStatusEl?.querySelector<HTMLElement>('#res-fill');
        if (txt) txt.textContent = `🎬 正在导出 MP4 (${preset}) · ${phaseText}`;
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (fill) fill.style.width = `${pct}%`;
      })
      .then((res) => {
        if (this.replayExportAbort !== abortCtrl) return;
        this.replayExportAbort = null;
        this.setReplayExportButtonsBusy(null);
        const mb = res.sizeBytes < 1024 * 1024 ? `${(res.sizeBytes / 1024).toFixed(0)} KB` : `${(res.sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
        this.showReplayExportResultBanner(`✅ 已下载 ${res.filename}（${mb} · ${res.width}×${res.height} · ${res.hasAudio ? '含音效' : '无音轨'}）`, true);
      })
      .catch((err) => {
        if (this.replayExportAbort !== abortCtrl) return;
        this.replayExportAbort = null;
        this.setReplayExportButtonsBusy(null);
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.showReplayExportResultBanner('已取消 MP4 导出', false);
        } else {
          this.showReplayExportResultBanner(`导出失败：${err instanceof Error ? err.message : String(err)}`, false);
        }
      });
  }

  private startReplayGifExport() {
    if (!this.isReplayMode || !this.replayBundle || this.replayExportAbort || !this.callbacks.onReplayExportGif) {
      return;
    }
    const bundle = this.replayBundle;
    const endTickIndex = this.replayCurrentTickIndex;
    if (endTickIndex < 2) {
      this.showReplayExportResultBanner('当前处于回放起点，请先播放一段后再截取 10s GIF', false);
      return;
    }

    const endSec = endTickIndex / 20;
    const atEnd = endTickIndex >= bundle.replay.ticks.length - 1;
    const startSec = Math.max(0, endSec + (atEnd ? 0.85 : 0) - 10);
    const rangeLabel = `${startSec.toFixed(1)}s–${endSec.toFixed(1)}s · 720p 24fps`;
    const abortCtrl = new AbortController();
    this.replayExportAbort = abortCtrl;

    if (this.replayExportNoticeTimer !== null) {
      window.clearTimeout(this.replayExportNoticeTimer);
      this.replayExportNoticeTimer = null;
    }

    this.setReplayExportButtonsBusy('gif');

    if (this.replayExportStatusEl) {
      this.replayExportStatusEl.className = 'replay-export-status';
      this.replayExportStatusEl.innerHTML = `
        <div class="res-row">
          <span class="res-text" id="res-text">🎞 正在导出 GIF (${rangeLabel}) · 准备中...</span>
          <span class="res-pct" id="res-pct">1%</span>
          <button type="button" class="heb-cancel-btn" id="res-cancel">取消</button>
        </div>
        <div class="heb-track"><div class="heb-fill" id="res-fill" style="width:1%"></div></div>
      `;
      this.replayExportStatusEl.querySelector('#res-cancel')?.addEventListener('click', () => {
        this.replayExportAbort?.abort();
      });
    }

    void this.callbacks
      .onReplayExportGif(bundle, endTickIndex, abortCtrl.signal, (p01, phaseText) => {
        if (this.replayExportAbort !== abortCtrl) return;
        const pct = Math.max(0, Math.min(100, Math.round(p01 * 100)));
        if (this.replayGifBtn) this.replayGifBtn.textContent = `GIF ${pct}%`;
        const txt = this.replayExportStatusEl?.querySelector('#res-text');
        const pctEl = this.replayExportStatusEl?.querySelector('#res-pct');
        const fill = this.replayExportStatusEl?.querySelector<HTMLElement>('#res-fill');
        if (txt) txt.textContent = `🎞 正在导出 GIF (${rangeLabel}) · ${phaseText}`;
        if (pctEl) pctEl.textContent = `${pct}%`;
        if (fill) fill.style.width = `${pct}%`;
      })
      .then((res) => {
        if (this.replayExportAbort !== abortCtrl) return;
        this.replayExportAbort = null;
        this.setReplayExportButtonsBusy(null);
        const mb = res.sizeBytes < 1024 * 1024 ? `${(res.sizeBytes / 1024).toFixed(0)} KB` : `${(res.sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
        this.showReplayExportResultBanner(
          `✅ 已下载 ${res.filename}（${mb} · ${res.durationSec.toFixed(1)}s · ${res.width}×${res.height} @ ${res.fps}fps）`,
          true,
        );
      })
      .catch((err) => {
        if (this.replayExportAbort !== abortCtrl) return;
        this.replayExportAbort = null;
        this.setReplayExportButtonsBusy(null);
        if (err instanceof DOMException && err.name === 'AbortError') {
          this.showReplayExportResultBanner('已取消 GIF 导出', false);
        } else {
          this.showReplayExportResultBanner(`GIF 导出失败：${err instanceof Error ? err.message : String(err)}`, false);
        }
      });
  }

  /**
   * Called in real time as background AI simulation appends new ticks:
   * dynamically expands timeline slider max, updates death markers, and unlocks MP4 export on completion.
   */
  public updateReplayTimeline(bundle: MatchReplayBundle, playback: ReplayPlaybackState) {
    if (!this.isReplayMode) return;
    this.replayBundle = bundle;
    const wasComputing = this.replayComputing;
    this.replayComputing = Boolean(playback.computing);

    if (this.replayMarkersEl) {
      this.replayMarkersEl.innerHTML = this.renderReplayDeathMarkersHtml(bundle);
    }
    if (this.replayBannerEl && !this.replayComputing) {
      this.replayBannerEl.textContent = this.buildReplayEndBannerText(bundle);
    }
    if (wasComputing && !this.replayComputing && !this.replayExportAbort && this.replayExportBtn) {
      this.replayExportBtn.disabled = false;
      this.replayExportBtn.textContent = '⬇ 导出';
      this.replayExportBtn.title = `导出本局观战回放 MP4（当前设置：${this.getExportPresetLabel()}）`;
    }
    this.updateReplayControls(playback);
  }

  public updateReplayControls(playback: ReplayPlaybackState) {
    if (!this.isReplayMode) return;
    this.replayCurrentTickIndex = playback.tickIndex;
    this.replayComputing = Boolean(playback.computing);
    const pct = playback.maxIndex > 0 ? (playback.tickIndex / playback.maxIndex) * 100 : 100;
    if (this.replaySlider) {
      this.replaySlider.max = String(playback.maxIndex);
      this.replaySlider.value = String(playback.tickIndex);
      this.replaySlider.style.setProperty('--rep-pct', `${pct.toFixed(2)}%`);
    }
    if (this.replayTimeEl && this.replayBundle) {
      const curTick = this.replayBundle.replay.ticks[playback.tickIndex]?.t ?? playback.tickIndex;
      const maxTick = this.replayBundle.replay.ticks[playback.maxIndex]?.t ?? playback.maxIndex;
      const timeStr = `${(curTick / 20).toFixed(1)}s / ${(maxTick / 20).toFixed(1)}s`;
      if (playback.computing) {
        this.replayTimeEl.innerHTML = `${timeStr} <span class="replay-sim-badge" title="后台高速推演中">⚡</span>`;
      } else {
        this.replayTimeEl.textContent = timeStr;
      }
    }
    if (this.replayPlayBtn) {
      if (playback.finished) {
        this.replayPlayBtn.textContent = '↺ 重播';
        this.replayPlayBtn.classList.add('is-paused');
      } else if (playback.paused) {
        this.replayPlayBtn.textContent = '▶ 播放';
        this.replayPlayBtn.classList.add('is-paused');
      } else {
        this.replayPlayBtn.textContent = '⏸ 暂停';
        this.replayPlayBtn.classList.remove('is-paused');
      }
    }
    if (this.replayBannerEl) {
      this.replayBannerEl.classList.toggle('hidden', !playback.finished);
    }
    for (const btn of this.replaySpeedBtns) {
      const sp = Number(btn.dataset.replaySpeed);
      btn.classList.toggle('active', Math.abs(sp - playback.speed) < 0.01);
    }
  }

  public updateReplayTelemetry(
    renderHz: number,
    frameWorkMs: number,
    speed: number,
    paused: boolean,
    computing = false,
  ) {
    if (!this.perfEl || !this.isReplayMode) return;
    const prefix = this.replayIsLiveAi ? 'AI 观战' : '观战回放';
    const spdStr = paused ? '已暂停' : `${speed === 1 ? '1.0' : speed}x`;
    const simTag = computing ? ' · 推演中' : '';
    this.perfEl.textContent = `${prefix} ${spdStr}${simTag} · 渲染 ${Math.round(renderHz)}Hz (${frameWorkMs.toFixed(1)}ms)`;
  }

  private renderBottomHints(humanSeat: number) {
    const kb = this.settings.get().keybindings;
    const mv = formatMoveSummary(kb);
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    const rst = formatPrimaryBind(kb.quickRestart);

    if (humanSeat >= 0) {
      this.bottomBar.innerHTML = `
        <div class="action-pill" id="hint-move"><kbd>${mv}</kbd> 移动</div>
        <div class="action-pill" id="hint-left"><kbd>${thr}</kbd> 向鼠标扔镖</div>
        <div class="action-pill" id="hint-right"><kbd>${mel}</kbd> 挥砍 / 挡镖</div>
        <div class="action-pill" id="hint-shift"><kbd>${dsh}</kbd> 冲刺就绪</div>
      `;
      this.humanHintMove = this.bottomBar.querySelector('#hint-move');
      this.humanHintLeft = this.bottomBar.querySelector('#hint-left');
      this.humanHintRight = this.bottomBar.querySelector('#hint-right');
      this.humanHintShift = this.bottomBar.querySelector('#hint-shift');
    } else {
      this.bottomBar.innerHTML = `<div class="action-pill spectate-pill">AI 观战模式 · 按 <kbd>${rst}</kbd> 立即原配置重开</div>`;
      this.humanHintMove = null;
      this.humanHintLeft = null;
      this.humanHintRight = null;
      this.humanHintShift = null;
    }
  }

  public refreshKeyHints() {
    if (this.root.classList.contains('hidden')) return;
    if (this.isReplayMode) {
      if (this.replayExportBtn) {
        this.replayExportBtn.title = `导出本局观战回放 MP4（当前设置：${this.getExportPresetLabel()}）`;
      }
      return;
    }
    this.renderBottomHints(this.humanSeat);
    if (this.lastTickState) {
      this.updateHumanActionHints(this.lastTickState);
    }
    // Also refresh shortcut keycap on open result overlay if present
    const rst = formatPrimaryBind(this.settings.get().keybindings.quickRestart);
    const kbdEl = this.resultOverlay.querySelector<HTMLElement>('.rr-btn-kbd');
    if (kbdEl) kbdEl.textContent = rst;
    const customRstBtn = this.resultOverlay.querySelector<HTMLElement>('#btn-result-restart');
    if (customRstBtn) customRstBtn.textContent = `↻ 重开 (${rst})`;
  }

  public updateTick(state: TickSnapshot, colStart = 240, colEvery = 30) {
    this.lastTickState = state;
    const remSec = Math.max(0, (800 - state.t) / 20);
    if (this.timerEl) {
      this.timerEl.textContent = `${remSec.toFixed(1)}s`;
      this.timerEl.classList.toggle('urgent', remSec < 10);
    }

    if (this.collapseEl) {
      if (state.warn >= 0) {
        this.collapseEl.textContent = `⚠ 第 ${state.warn + 1} 波即将塌陷!`;
        this.collapseEl.classList.add('warn');
      } else if (state.t < colStart) {
        const s = Math.ceil((colStart - state.t) / 20);
        this.collapseEl.textContent = `塌陷倒计时 ${s}s`;
        this.collapseEl.classList.remove('warn');
      } else {
        this.collapseEl.textContent = `已塌陷 ${state.fallen} 波`;
        this.collapseEl.classList.remove('warn');
      }
      void colEvery;
    }

    for (let i = 0; i < state.n && i < this.cardEls.length; i++) {
      const p = state.players[i];
      const d = state.darts[i];
      const el = this.cardEls[i];
      el.card.classList.toggle('is-dead', !p.alive);
      el.kills.textContent = `${p.kills} 击杀`;
      const db = dartBadge(d.st);
      el.dart.textContent = p.alive ? db.text : '出局';
      el.dart.className = `hud-dart ${p.alive ? db.cls : 'st-dead'}`;
      const readyPct = p.alive ? Math.max(0, Math.min(100, (1 - p.cd / 20) * 100)) : 0;
      el.cdBar.style.width = `${readyPct}%`;
    }

    this.updateHumanActionHints(state);
  }

  private updateHumanActionHints(state: TickSnapshot) {
    if (this.humanSeat < 0 || !state.players[this.humanSeat]) return;
    const kb = this.settings.get().keybindings;
    const thr = formatPrimaryBind(kb.throwRecall);
    const mel = formatPrimaryBind(kb.melee);
    const dsh = formatDashSummary(kb);
    const rst = formatPrimaryBind(kb.quickRestart);

    const me = state.players[this.humanSeat];
    const md = state.darts[this.humanSeat];
    if (!me.alive) {
      if (this.humanHintMove) this.humanHintMove.style.display = 'none';
      if (this.humanHintLeft) {
        this.humanHintLeft.innerHTML =
          this.matchMode !== 'custom'
            ? `已出局观战中 · 按 <kbd>${rst}</kbd> 重新匹配下一局`
            : `已出局观战中 · 按 <kbd>${rst}</kbd> 立即原配置重开`;
        this.humanHintLeft.classList.add('spectate-pill');
      }
      if (this.humanHintRight) this.humanHintRight.style.display = 'none';
      if (this.humanHintShift) this.humanHintShift.style.display = 'none';
    } else {
      if (this.humanHintMove) this.humanHintMove.style.display = '';
      if (this.humanHintLeft) this.humanHintLeft.classList.remove('spectate-pill');
      if (this.humanHintRight) this.humanHintRight.style.display = '';
      if (this.humanHintShift) this.humanHintShift.style.display = '';
      if (this.humanHintLeft) {
        if (md.st === DState.HAND) this.humanHintLeft.innerHTML = `<kbd>${thr}</kbd> 向鼠标扔镖`;
        else if (md.st === DState.GROUND) this.humanHintLeft.innerHTML = `<kbd>长按 ${thr}</kbd> 召回落地镖`;
        else if (md.st === DState.RISE) this.humanHintLeft.innerHTML = `<kbd>按住中</kbd> 召回引导 ${Math.round((1 - me.timer / 12) * 100)}%`;
        else this.humanHintLeft.innerHTML = `<kbd>${thr}</kbd> 飞镖飞行中`;
      }
      if (this.humanHintRight) {
        this.humanHintRight.innerHTML =
          md.st === DState.HAND ? `<kbd>${mel}</kbd> 挥砍 / 挡镖` : `<kbd>${mel}</kbd> 踢人击退`;
      }
      if (this.humanHintShift) {
        this.humanHintShift.innerHTML =
          me.cd === 0
            ? `<kbd>${dsh}</kbd> 冲刺就绪`
            : `<kbd>${dsh}</kbd> 冷却 ${(me.cd / 20).toFixed(1)}s`;
        this.humanHintShift.classList.toggle('ready', me.cd === 0);
      }
    }
  }

  public updateTelemetry(logicHz: number, renderHz: number, frameWorkMs: number, botMaxMs: number, speed = 1.0) {
    if (!this.perfEl) return;
    const capHz = frameWorkMs > 0.05 ? Math.min(999, Math.round(1000 / frameWorkMs)) : 999;
    const logicStr = logicHz < 10 ? logicHz.toFixed(1) : logicHz.toFixed(0);
    const spdTag = Math.abs(speed - 1) > 0.01 ? ` (${speed.toFixed(1)}x)` : '';
    this.perfEl.textContent = `逻辑 ${logicStr}Hz${spdTag} · 渲染 ${Math.round(renderHz)}Hz (${frameWorkMs.toFixed(1)}ms, 峰值~${capHz}Hz · AI ${botMaxMs.toFixed(1)}ms)`;
  }

  public showMatchResult(finalState: TickSnapshot, eloResult: EloUpdateResult | null = null) {
    this.clearTimers();
    const isRanked = this.matchMode !== 'custom';
    if (isRanked && eloResult) {
      this.showRankedMatchResult(finalState, eloResult);
      return;
    }

    const winner = finalState.winner >= 0 ? this.slots[finalState.winner] : null;
    const rows = finalState.players
      .map((p, idx) => ({
        idx,
        slot: this.slots[idx],
        p,
      }))
      .sort((a, b) => a.p.rank - b.p.rank || b.p.kills - a.p.kills);

    const canRestart = this.humanSeat < 0 || !(finalState.players[this.humanSeat]?.alive);
    const rstKey = formatPrimaryBind(this.settings.get().keybindings.quickRestart);

    let remainSec = 4;
    this.resultOverlay.innerHTML = `
      <div class="result-card">
        <div class="result-kicker">${winner ? '本局胜者' : '平局结束'}</div>
        ${
          winner
            ? `<div class="result-winner">
                <img src="${winner.avatar || ''}" class="result-avatar" alt="" />
                <div class="result-wname" style="color:${winner.ringAccent || winner.color}">${winner.displayName}</div>
              </div>`
            : `<div class="result-wname">平局 (Draw)</div>`
        }
        <div class="result-table">
          ${rows
            .map(({ slot, p }) => {
              const killerName = p.killer >= 0 && this.slots[p.killer] ? this.slots[p.killer].displayName : undefined;
              return `
              <div class="result-row ${p.rank === 1 && winner ? 'is-first' : ''}">
                <span class="r-rank">#${p.rank}</span>
                <img class="r-av" src="${slot.avatar || ''}" alt="" />
                <span class="r-name">${slot.displayName}</span>
                <span class="r-kills">${p.kills} 击杀</span>
                <span class="r-cause">${p.alive ? '存活至终场' : causeLabel(p.cause, killerName)}</span>
              </div>`;
            })
            .join('')}
        </div>
        <div class="result-btn-row">
          ${canRestart ? `<button class="result-restart-btn" id="btn-result-restart">↻ 重开 (${rstKey})</button>` : ''}
          <button class="start-btn result-back-btn" id="btn-result-back">返回主界面 (${remainSec}s)</button>
        </div>
      </div>
    `;
    this.nameplateLayer.classList.add('hidden');
    this.resultOverlay.classList.remove('hidden');

    const backBtn = this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-back');
    backBtn?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });

    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-restart')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onRestartMatch();
    });

    this.countdownInterval = window.setInterval(() => {
      remainSec--;
      if (backBtn && remainSec > 0) {
        backBtn.textContent = `返回主界面 (${remainSec}s)`;
      }
    }, 1000);

    this.autoReturnTimer = window.setTimeout(() => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    }, 4000);
  }

  private showRankedMatchResult(finalState: TickSnapshot, elo: EloUpdateResult) {
    const modeLabel = elo.mode === 'solo' ? 'SOLO 排位' : '四人混战排位';
    const humanP = this.humanSeat >= 0 ? finalState.players[this.humanSeat] : null;
    const humanWon = finalState.winner >= 0 && finalState.winner === this.humanSeat;
    const isDraw = finalState.winner === -1 && humanP?.rank === 1;

    const outcomeText = humanWon
      ? '🏆 本局胜利'
      : isDraw
        ? '🤝 平局'
        : humanP
          ? `第 #${humanP.rank} 名`
          : '对局结束';
    const outcomeCls = humanWon ? 'is-win' : isDraw ? 'is-draw' : 'is-loss';

    const matchRows = finalState.players
      .map((p, idx) => ({ idx, slot: this.slots[idx], p }))
      .sort((a, b) => a.p.rank - b.p.rank || b.p.kills - a.p.kills);

    // Build focused animated mini-ladder slice around oldRank & newRank
    const total = elo.afterLadder.length;
    const oldIdx = Math.max(0, elo.oldRank - 1);
    const newIdx = Math.max(0, elo.newRank - 1);
    const minIdx = Math.min(oldIdx, newIdx);
    const maxIdx = Math.max(oldIdx, newIdx);
    let winStart = Math.max(0, minIdx - 1);
    let winEnd = Math.min(total - 1, maxIdx + 1);
    while (winEnd - winStart + 1 < 4 && (winStart > 0 || winEnd < total - 1)) {
      if (winStart > 0) winStart--;
      if (winEnd - winStart + 1 < 4 && winEnd < total - 1) winEnd++;
    }
    const visibleCount = winEnd - winStart + 1;
    const ROW_STRIDE = 48; // 42px row + 6px gap
    const viewportHeight = visibleCount * ROW_STRIDE - 6;

    const beforePos = new Map(elo.beforeLadder.map((e, i) => [e.id, i]));
    const afterPos = new Map(elo.afterLadder.map((e, i) => [e.id, i]));
    const afterById = new Map(elo.afterLadder.map((e) => [e.id, e]));
    const beforeById = new Map(elo.beforeLadder.map((e) => [e.id, e]));

    const involvedIds = new Set<string>();
    for (let i = winStart; i <= winEnd; i++) {
      if (elo.beforeLadder[i]) involvedIds.add(elo.beforeLadder[i].id);
      if (elo.afterLadder[i]) involvedIds.add(elo.afterLadder[i].id);
    }

    const overtookIds = new Set(elo.overtook.map((e) => e.id));
    const overtakenByIds = new Set(elo.overtakenBy.map((e) => e.id));

    interface AnimRowSpec {
      id: string;
      entry: LadderEntrySnap;
      startSlot: number;
      endSlot: number;
      beforeRank: number;
      afterRank: number;
    }

    const animRows: AnimRowSpec[] = [];
    for (const id of involvedIds) {
      const bEntry = beforeById.get(id);
      const aEntry = afterById.get(id);
      if (!bEntry || !aEntry) continue;
      const bIdx = beforePos.get(id) ?? 0;
      const aIdx = afterPos.get(id) ?? 0;
      // Clamp offscreen entry/exit distance to 1 row outside viewport for clean slide-in/out
      const startSlot = Math.max(-1, Math.min(visibleCount, bIdx - winStart));
      const endSlot = Math.max(-1, Math.min(visibleCount, aIdx - winStart));
      animRows.push({
        id,
        entry: aEntry,
        startSlot,
        endSlot,
        beforeRank: bEntry.rank,
        afterRank: aEntry.rank,
      });
    }

    const renderMiniChips = (list: LadderEntrySnap[]) =>
      list
        .map(
          (e) => `
        <span class="rr-pass-chip">
          <img src="${e.avatar || ''}" alt="" />
          <span>${e.shortName}</span>
          <em>${e.rating}</em>
        </span>`,
        )
        .join('');

    let passBannerCls = 'is-flat';
    let passBannerHtml = '';
    if (elo.overtook.length > 0) {
      passBannerCls = 'is-up';
      passBannerHtml = `<span class="rr-pass-tag">🚀 超过了</span><span class="rr-pass-chips">${renderMiniChips(elo.overtook)}</span>`;
    } else if (elo.overtakenBy.length > 0) {
      passBannerCls = 'is-down';
      passBannerHtml = `<span class="rr-pass-tag">⚠️ 被</span><span class="rr-pass-chips">${renderMiniChips(elo.overtakenBy)}</span><span class="rr-pass-tag">超过</span>`;
    } else if (elo.newRank === 1) {
      passBannerCls = 'is-top';
      passBannerHtml = `<span class="rr-pass-tag">👑 稳居榜首！</span>`;
    } else {
      const above = elo.afterLadder[newIdx - 1];
      if (above) {
        const gap = Math.max(0, above.rating - elo.newRating);
        passBannerHtml = `<span class="rr-pass-tag">距离超越</span><span class="rr-pass-chips">${renderMiniChips([above])}</span><span class="rr-pass-tag">还差 <strong>${gap}</strong> 分</span>`;
      }
    }

    const deltaSign = elo.delta > 0 ? `+${elo.delta}` : `${elo.delta}`;
    const deltaCls = elo.delta > 0 ? 'elo-up' : elo.delta < 0 ? 'elo-down' : 'elo-flat';
    const rankDiff = elo.oldRank - elo.newRank; // > 0 means climbed up
    const rankDeltaText =
      rankDiff > 0 ? `▲ 上升 ${rankDiff} 名` : rankDiff < 0 ? `▼ 下降 ${Math.abs(rankDiff)} 名` : '名次不变';
    const rankDeltaCls = rankDiff > 0 ? 'rk-up' : rankDiff < 0 ? 'rk-down' : 'rk-flat';

    this.resultOverlay.innerHTML = `
      <div class="result-card ranked-result-card">
        <div class="rr-head">
          <div class="rr-head-left">
            <span class="rr-mode-pill">${modeLabel}</span>
            <span class="rr-outcome ${outcomeCls}">${outcomeText}</span>
          </div>
          <button type="button" class="rr-lb-mini-btn" id="btn-result-lb">🏆 完整榜单</button>
        </div>

        <div class="rr-hero">
          <div class="rr-hero-block">
            <div class="rr-hero-label">ELO 分数</div>
            <div class="rr-elo-line">
              <span class="rr-elo-num ${deltaCls}" id="rr-elo-num">${elo.oldRating}</span>
              <span class="rr-delta-pill ${deltaCls}" id="rr-delta-pill">${deltaSign}</span>
            </div>
          </div>
          <div class="rr-hero-sep"></div>
          <div class="rr-hero-block">
            <div class="rr-hero-label">当前排名</div>
            <div class="rr-rank-line">
              <span class="rr-rank-num" id="rr-rank-num">#${elo.oldRank}</span>
              <span class="rr-rank-total">/ ${elo.totalRanked}</span>
            </div>
            <div class="rr-rank-delta ${rankDeltaCls}" id="rr-rank-delta">${rankDeltaText}</div>
          </div>
        </div>

        <div class="rr-ladder-wrap">
          <div class="rr-ladder-viewport" style="height:${viewportHeight}px">
            ${animRows
              .map((r) => {
                const startVisible = r.startSlot >= 0 && r.startSlot < visibleCount;
                const initY = r.startSlot * ROW_STRIDE;
                const initScore = r.entry.isHuman ? elo.oldRating : r.entry.rating;
                return `
                <div
                  class="rr-lrow ${r.entry.isHuman ? 'is-human' : ''}"
                  data-lrow-id="${r.id}"
                  style="transform:translate3d(0, ${initY}px, 0); opacity:${startVisible ? 1 : 0};"
                >
                  <span class="rr-lr-rank" data-lrow-rank="${r.id}">#${r.beforeRank}</span>
                  <img class="rr-lr-av" src="${r.entry.avatar || ''}" alt="" />
                  <span class="rr-lr-name">${r.entry.name}</span>
                  <span class="rr-lr-score" ${r.entry.isHuman ? 'id="rr-human-row-elo"' : ''}>${initScore}</span>
                </div>`;
              })
              .join('')}
          </div>
        </div>

        <div class="rr-pass-banner ${passBannerCls}" id="rr-pass-banner">
          ${passBannerHtml}
        </div>

        <div class="result-table rr-match-table">
          ${matchRows
            .map(({ slot, p }) => {
              const killerName = p.killer >= 0 && this.slots[p.killer] ? this.slots[p.killer].displayName : undefined;
              return `
              <div class="result-row ${slot.kind === 'human' ? 'is-human-row' : ''} ${p.rank === 1 && finalState.winner >= 0 ? 'is-first' : ''}">
                <span class="r-rank">#${p.rank}</span>
                <img class="r-av" src="${slot.avatar || ''}" alt="" />
                <span class="r-name">${slot.displayName}</span>
                <span class="r-kills">${p.kills} 击杀</span>
                <span class="r-cause">${p.alive ? '存活至终场' : causeLabel(p.cause, killerName)}</span>
              </div>`;
            })
            .join('')}
        </div>

        <div class="rr-btn-row">
          <button type="button" class="rr-back-btn" id="btn-result-back">返回主界面</button>
          <button type="button" class="start-btn rr-primary-btn" id="btn-result-new-match">⚔️ 重新匹配 <kbd class="rr-btn-kbd">${formatPrimaryBind(this.settings.get().keybindings.quickRestart)}</kbd></button>
        </div>
      </div>
    `;

    this.nameplateLayer.classList.add('hidden');
    this.resultOverlay.classList.remove('hidden');

    // Bind buttons
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-back')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby();
    });
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-new-match')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onRestartMatch();
    });
    this.resultOverlay.querySelector<HTMLButtonElement>('#btn-result-lb')?.addEventListener('click', () => {
      this.clearTimers();
      this.callbacks.onReturnToLobby({ openLeaderboard: true, rankedMode: elo.mode });
    });

    // Choreographed score count-up + ladder row-swap + overtake reveal animation
    const eloNumEl = this.resultOverlay.querySelector<HTMLElement>('#rr-elo-num');
    const humanRowEloEl = this.resultOverlay.querySelector<HTMLElement>('#rr-human-row-elo');
    const deltaPillEl = this.resultOverlay.querySelector<HTMLElement>('#rr-delta-pill');
    const rankNumEl = this.resultOverlay.querySelector<HTMLElement>('#rr-rank-num');
    const rankDeltaEl = this.resultOverlay.querySelector<HTMLElement>('#rr-rank-delta');
    const passBannerEl = this.resultOverlay.querySelector<HTMLElement>('#rr-pass-banner');

    const scheduleAnim = (delayMs: number, fn: () => void) => {
      const h = window.setTimeout(fn, delayMs);
      this.rankAnimTimers.push(h);
    };

    // Beat 1 -> Beat 2: Smoothly roll ELO score and glide ladder rows
    scheduleAnim(260, () => {
      deltaPillEl?.classList.add('is-shown');

      const durMs = elo.delta === 0 ? 220 : 820;
      const tStart = performance.now();
      const stepNum = (now: number) => {
        const u = Math.min(1, (now - tStart) / durMs);
        const eased = 1 - Math.pow(1 - u, 3);
        const cur = Math.round(elo.oldRating + (elo.newRating - elo.oldRating) * eased);
        if (eloNumEl) eloNumEl.textContent = String(cur);
        if (humanRowEloEl) humanRowEloEl.textContent = String(cur);
        if (u < 1) {
          this.rankAnimRaf = requestAnimationFrame(stepNum);
        } else {
          this.rankAnimRaf = null;
        }
      };
      this.rankAnimRaf = requestAnimationFrame(stepNum);
    });

    // Beat 2: Swap ladder rows smoothly
    scheduleAnim(360, () => {
      for (const r of animRows) {
        const rowEl = this.resultOverlay.querySelector<HTMLElement>(`[data-lrow-id="${r.id}"]`);
        const rkEl = this.resultOverlay.querySelector<HTMLElement>(`[data-lrow-rank="${r.id}"]`);
        if (!rowEl) continue;
        const endVisible = r.endSlot >= 0 && r.endSlot < visibleCount;
        const endY = r.endSlot * ROW_STRIDE;
        if (r.entry.isHuman) {
          rowEl.classList.add(rankDiff > 0 ? 'is-climbing' : rankDiff < 0 ? 'is-dropping' : 'is-pulsing');
        } else if (overtookIds.has(r.id)) {
          rowEl.classList.add('is-overtaken');
        } else if (overtakenByIds.has(r.id)) {
          rowEl.classList.add('is-overtaking');
        }
        rowEl.style.transform = `translate3d(0, ${endY}px, 0)`;
        rowEl.style.opacity = endVisible ? '1' : '0';
        if (rkEl) rkEl.textContent = `#${r.afterRank}`;
      }
    });

    // Beat 3: Pop new rank, reveal "超过了 XXX / 被 XXX 超过" banner, and trigger audio cue
    scheduleAnim(880, () => {
      if (rankNumEl) {
        rankNumEl.textContent = `#${elo.newRank}`;
        if (rankDiff !== 0) {
          rankNumEl.classList.add(rankDiff > 0 ? 'pop-up' : 'pop-down');
        }
      }
      rankDeltaEl?.classList.add('is-shown');
      passBannerEl?.classList.add('is-shown');
      if (elo.overtook.length > 0) {
        this.callbacks.onRankCue?.('up');
      } else if (elo.overtakenBy.length > 0) {
        this.callbacks.onRankCue?.('down');
      }
    });

    // Settle human row lift after glide finishes
    scheduleAnim(1220, () => {
      const humanEl = this.resultOverlay.querySelector<HTMLElement>('.rr-lrow.is-human');
      humanEl?.classList.remove('is-climbing', 'is-dropping', 'is-pulsing');
    });
  }

  public showEloToast(rank: number, eloResult: EloUpdateResult, outcome: 'win' | 'draw' | 'loss' = 'loss') {
    if (this.eloToastTimer !== null) {
      window.clearTimeout(this.eloToastTimer);
      this.eloToastTimer = null;
    }
    const modeLabel = eloResult.mode === 'solo' ? 'SOLO' : '混战';
    const deltaStr = `${eloResult.delta >= 0 ? '+' : ''}${eloResult.delta}`;
    const cls = eloResult.delta > 0 ? 'elo-up' : eloResult.delta < 0 ? 'elo-down' : '';
    const outcomeHtml =
      outcome === 'win'
        ? '上局 <strong>🏆 胜利</strong>'
        : outcome === 'draw'
          ? '上局 <strong>🤝 平局</strong>'
          : `上局第 <strong>#${rank}</strong> 名`;
    this.eloToastEl.className = 'hud-elo-toast hidden';
    void this.eloToastEl.offsetWidth;
    this.eloToastEl.className = `hud-elo-toast ${cls}`;
    this.eloToastEl.innerHTML = `${outcomeHtml} · ${modeLabel} ELO ${eloResult.oldRating} → <strong>${eloResult.newRating}</strong> <span class="het-delta">(${deltaStr})</span>`;
    this.eloToastTimer = window.setTimeout(() => {
      this.eloToastTimer = null;
      this.eloToastEl.classList.add('hidden');
    }, 3000);
  }

  public cancelResultOverlay(restarting = false, isRanked = false) {
    this.clearTimers();
    this.setCountdown(null);
    this.resultOverlay.classList.add('hidden');
    this.nameplateLayer.classList.remove('hidden');
    if (restarting) {
      this.bottomBar.innerHTML = `<div class="action-pill spectate-pill">${isRanked ? '正在按最新 ELO 重新匹配对手与地图...' : '正在按原配置与站位重开...'}</div>`;
    }
  }

  public hide() {
    this.clearTimers();
    this.isReplayMode = false;
    this.replayBundle = null;
    this.clearReplayRefs();
    if (this.eloToastTimer !== null) {
      window.clearTimeout(this.eloToastTimer);
      this.eloToastTimer = null;
    }
    this.eloToastEl.classList.add('hidden');
    this.setCountdown(null);
    this.root.classList.add('hidden');
    this.resultOverlay.classList.add('hidden');
  }

  private clearTimers() {
    if (this.autoReturnTimer !== null) {
      window.clearTimeout(this.autoReturnTimer);
      this.autoReturnTimer = null;
    }
    if (this.countdownInterval !== null) {
      window.clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    for (const h of this.rankAnimTimers) {
      window.clearTimeout(h);
    }
    this.rankAnimTimers = [];
    if (this.rankAnimRaf !== null) {
      cancelAnimationFrame(this.rankAnimRaf);
      this.rankAnimRaf = null;
    }
  }
}
