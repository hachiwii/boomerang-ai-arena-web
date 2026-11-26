import './style.css';
import { BgmManager, generateBgmSeed } from './audio/bgm';
import { SoundFX } from './audio/sfx';
import { runCricketBatch } from './game/cricketBatchRunner';
import { CricketStore } from './game/cricketStore';
import { HumanInputController } from './game/humanInput';
import { CinematicDirector } from './game/killCamDirector';
import { EloUpdateResult, LeaderboardStore } from './game/leaderboard';
import { CountdownStage, MatchController, type MatchCallbacks } from './game/matchController';
import { buildPvpMatchConfig } from './game/pvpConfig';
import { PvpMatchController } from './game/pvpMatchController';
import { getPvpLobbyClient, getPvpMatchLink } from './net/pvpLobbyClient';
import type { PvpRematchState, PvpSeriesStats } from './net/pvpTypes';
import { exportReplayClipToGif, triggerGifDownload } from './game/gifExporter';
import { buildMatchHistoryBundle, MatchHistoryStore, MatchReplayBundle } from './game/matchHistory';
import { exportReplayToMp4, triggerMp4Download } from './game/mp4Exporter';
import { PlatformManager } from './game/platform';
import { ReplayController } from './game/replayController';
import { createTrainingConfig } from './game/training';
import {
  formatExportPresetLabel,
  formatPrimaryBind,
  getCinematicOptions,
  getSlashJudgmentTicks,
  GraphicsQualityOption,
  isBoundToAction,
  isKillFxEffective,
  matchesActionKeyEvent,
  SettingsStore,
  shortcutAction,
  shortcutBind,
} from './game/settings';
import {
  CellType,
  EngineMapData,
  generateSpawnSeed,
  isRankedMatchMode,
  MapMeta,
  MatchConfig,
  RankedMode,
  RosterEntry,
  type TickSnapshot,
} from './game/types';
import { BotCompiler } from './game/customBots/botCompiler';
import { CustomBotStore, customBotRosterEntry } from './game/customBots/customBotStore';
import { GameRenderer } from './render/renderer';
import { BotManagerModal } from './ui/botManagerUI';
import { CricketBatchModal } from './ui/cricketBatchModal';
import { HistoryModal } from './ui/historyUI';
import { HudUI, ReplayPlaylistState } from './ui/hudUI';
import { AutoFitter } from './ui/autoFit';
import { showLaunchScreen } from './ui/launchScreen';
import { showControlSchemeChooser } from './ui/controlSchemeChooser';
import { LobbyUI, makeHoodieAvatarDataUrl, resolveSlots } from './ui/lobbyUI';
import { MobileControls, MobileLayoutEditor } from './ui/mobileControls';
import { MobileExportModal } from './ui/mobileExportModal';
import { SettingsModal } from './ui/settingsUI';
import { TrainingPanel } from './ui/trainingUI';
import { startAnalytics, trackMatchEnd, trackMatchStart } from './net/analytics';

function parseQuickPreviewMap(map: MapMeta): EngineMapData {
  const cells: number[] = [];
  const waves: number[] = [];
  const grid = map.previewGrid;
  for (let y = 0; y < map.ny; y++) {
    const row = grid[y] || '';
    for (let x = 0; x < map.nx; x++) {
      const ch = row[x] || '~';
      if (ch === '.') cells.push(CellType.FLOOR);
      else if (ch === '#') cells.push(CellType.WALL);
      else if (ch === '"') cells.push(CellType.GRASS);
      else cells.push(CellType.PIT);
      waves.push(-1);
    }
  }
  return {
    name: map.id,
    nx: map.nx,
    ny: map.ny,
    cell: 500,
    nwave: 0,
    colStart: 240,
    colEvery: 30,
    colWarn: 30,
    steps: 800,
    bodyR: 400,
    dartR: 320,
    range: 7200,
    slashReach: 1500,
    dashCd: 20,
    recallPre: 12,
    cells,
    waves,
    waveSteps: [],
    spawns: [],
  };
}

async function bootstrap() {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
  const uiRoot = document.getElementById('ui-root') as HTMLDivElement;

  const [mapsResp, rosterResp] = await Promise.all([
    fetch(`/assets/maps/manifest.json?v=${__BUILD_ID__}`),
    fetch(`/assets/chars/roster.json?v=${__BUILD_ID__}`),
  ]);
  const maps = (await mapsResp.json()) as MapMeta[];
  const pvpLobby = getPvpLobbyClient();
  const roster = (await rosterResp.json()) as RosterEntry[];
  // Enabled custom bots (compiled in the browser) join the shared roster; it's mutated in place when they change
  const customBots = new CustomBotStore();
  const syncCustomRoster = () => {
    for (let i = roster.length - 1; i >= 0; i--) {
      if (roster[i].category === 'custom') roster.splice(i, 1);
    }
    roster.push(...customBots.listEnabled().map(customBotRosterEntry));
  };
  syncCustomRoster();

  const settings = new SettingsStore();
  const platform = new PlatformManager(settings);
  // Touch devices open on a launch page: 移动端 = landscape + fullscreen in one tap, or 桌面端
  if (!platform.isLaunchDone()) {
    showLaunchScreen({
      fullscreenSupported: platform.isFullscreenSupported() || platform.isStandaloneApp(),
      onChoose: (choice) => platform.launch(choice),
    });
  }
  const sfx = new SoundFX();
  sfx.applySettings(settings.get().soundEnabled, settings.get().volume);
  const bgm = new BgmManager();
  bgm.applySettings(
    settings.get().bgmEnabled,
    settings.get().bgmVolume,
    settings.get().bossMusicEnabled,
  );
  bgm.enterLobby();
  const syncPageVisibilityAudio = () => {
    const hidden = document.hidden;
    bgm.setPageHidden(hidden);
    sfx.setPageHidden(hidden);
  };
  syncPageVisibilityAudio();
  document.addEventListener('visibilitychange', syncPageVisibilityAudio);
  (window as unknown as { __getBgmState?: () => ReturnType<BgmManager['getDebugState']> }).__getBgmState = () =>
    bgm.getDebugState();

  const input = new HumanInputController(canvas, settings);
  const renderer = new GameRenderer(
    canvas,
    sfx,
    undefined,
    undefined,
    settings.get().graphicsQuality,
    settings.get().edgeBeautify,
    settings.get().dartOutline,
  );
  renderer.setKillFxEnabled(isKillFxEffective(settings.get()));
  input.setAimProjector((cx, cy) => renderer.projectClientToWorldMm(cx, cy));
  input.setMoveMarkerListener((x, y) => renderer.showMoveMarker(x, y));
  input.setTouchMode(platform.isMobile());
  renderer.setMobileView(platform.isMobile());
  const leaderboard = new LeaderboardStore(roster, makeHoodieAvatarDataUrl('#3B78F0', '#262A33'));
  const cricketStore = new CricketStore(
    maps,
    roster,
    customBots.list().map((b) => b.id),
  );
  const botManager = new BotManagerModal(customBots, new BotCompiler());
  customBots.onChange(() => {
    syncCustomRoster();
    cricketStore.syncRoster(customBots.list().map((b) => b.id));
    lobbyUI.handleRosterChanged();
  });
  const matchHistory = new MatchHistoryStore();

  let mode: 'lobby' | 'playing' | 'replay' = 'lobby';
  let replayIsLiveAi = false;
  let activeConfig: MatchConfig | null = null;
  let activeMapData: EngineMapData | null = null;
  let replayMapData: EngineMapData | null = null;
  let lastFinishedBundle: MatchReplayBundle | null = null;
  let matchOverTimer: number | null = null;
  let matchOverDeadlineMs = 0;
  let matchOverRemainingMs = 0;
  let matchOverCallback: (() => void) | null = null;
  let matchRecorded = false;
  let historyRecorded = false;
  let pendingMatchElo: { rank: number; outcome: 'win' | 'draw' | 'loss'; elo: EloUpdateResult } | null = null;
  let resultOverlayShown = false;
  let restarting = false;

  // Frame-rate lock driven directly by SettingsStore (true = monitor refresh rate, false = uncapped)
  let activeLockFps = settings.get().lockFps;
  let activeGraphicsQuality: GraphicsQualityOption = settings.get().graphicsQuality;
  let activeEdgeBeautify = settings.get().edgeBeautify;
  let activeDartOutline = settings.get().dartOutline;
  let rafId = 0;
  let uncapChannel: MessageChannel | null = null;
  let uncapRunning = false;
  let lastTelemetryUpdateMs = 0;

  let lobbyUI: LobbyUI;
  let hudUI: HudUI;
  let trainingPanel: TrainingPanel;
  let controller: MatchController;
  let pvpController: PvpMatchController | null = null;
  let pvpRematchState: PvpRematchState | null = null;
  const liveController = () => pvpController ?? controller;
  let replayController: ReplayController;
  let historyModal: HistoryModal;
  let replayPlaylist: string[] = [];
  let replayPlaylistIndex = -1;
  let replaySwitchSeq = 0;
  let replaySwitching = false;

  const getReplayPlaylistState = (): ReplayPlaylistState | null => {
    if (replayIsLiveAi || replayPlaylist.length === 0 || replayPlaylistIndex < 0) return null;
    return {
      index: replayPlaylistIndex,
      total: replayPlaylist.length,
      loading: replaySwitching,
    };
  };

  const clearReplayPlaylist = () => {
    replaySwitchSeq++;
    replaySwitching = false;
    replayPlaylist = [];
    replayPlaylistIndex = -1;
  };

  const clearMatchOverTimer = () => {
    if (matchOverTimer !== null) {
      window.clearTimeout(matchOverTimer);
      matchOverTimer = null;
    }
    matchOverDeadlineMs = 0;
    matchOverRemainingMs = 0;
    matchOverCallback = null;
  };

  const scheduleMatchOverTimer = (delayMs: number, cb: () => void) => {
    clearMatchOverTimer();
    matchOverCallback = cb;
    matchOverRemainingMs = Math.max(0, delayMs);
    if (externalPaused && !pvpController) return;
    matchOverDeadlineMs = performance.now() + matchOverRemainingMs;
    matchOverTimer = window.setTimeout(() => {
      const fn = matchOverCallback;
      clearMatchOverTimer();
      fn?.();
    }, matchOverRemainingMs);
  };

  const pauseMatchOverTimer = () => {
    if (matchOverTimer !== null) {
      matchOverRemainingMs = Math.max(0, matchOverDeadlineMs - performance.now());
      window.clearTimeout(matchOverTimer);
      matchOverTimer = null;
    }
  };

  const resumeMatchOverTimer = () => {
    if (matchOverTimer === null && matchOverCallback) {
      matchOverDeadlineMs = performance.now() + matchOverRemainingMs;
      matchOverTimer = window.setTimeout(() => {
        const fn = matchOverCallback;
        clearMatchOverTimer();
        fn?.();
      }, matchOverRemainingMs);
    }
  };

  // External pause reasons: Settings modal or Mobile Export modal open
  let settingsOpen = false;
  let mobileExportOpen = false;
  let externalPaused = false;
  let resumeAutoFullscreenTimer: number | null = null;
  const syncExternalPause = () => {
    const want = settingsOpen || mobileExportOpen;
    if (want === externalPaused) return;
    externalPaused = want;
    input.setPaused(want);
    renderer.setCursorSuppressed(want);
    if (want) mobileControls?.cancelAll();
    if (mode === 'playing' && !pvpController) {
      controller.setPaused(want);
      renderer.setPlaybackPaused(want);
      if (want) pauseMatchOverTimer();
      else resumeMatchOverTimer();
    } else if (mode === 'replay') {
      replayController.setExternalPaused(want);
    }
  };

  const mobileExportModal = new MobileExportModal({
    onOpenChange: (open) => {
      mobileExportOpen = open;
      if (resumeAutoFullscreenTimer !== null) {
        window.clearTimeout(resumeAutoFullscreenTimer);
        resumeAutoFullscreenTimer = null;
      }
      if (open) {
        platform.setAutoFullscreenSuspended(true);
      } else {
        // Delay re-enabling auto-fullscreen briefly so the Close tap itself never snaps back to fullscreen
        resumeAutoFullscreenTimer = window.setTimeout(() => {
          resumeAutoFullscreenTimer = null;
          if (!mobileExportOpen) platform.setAutoFullscreenSuspended(false);
        }, 180);
      }
      syncExternalPause();
    },
  });

  const renderMp4ForBundle = (
    bundle: MatchReplayBundle,
    signal: AbortSignal,
    onProgress: (progress01: number, phaseText: string) => void,
  ) => {
    const s = settings.get();
    return exportReplayToMp4(bundle, {
      resolution: s.exportResolution,
      bitrateMbps: s.exportBitrateMbps,
      speed: s.exportSpeed,
      soundEnabled: s.exportSoundEnabled,
      volumePct: 100,
      bgmEnabled: s.exportBgmEnabled,
      bgmVolumePct: 70,
      bossMusicEnabled: s.bossMusicEnabled,
      loadBgmBuffer: (trackId, ctx) => bgm.decodeTrackForContext(trackId, ctx),
      graphicsQuality: s.graphicsQuality,
      edgeBeautify: s.edgeBeautify,
      dartOutline: s.dartOutline,
      cinematic: getCinematicOptions(s),
      sharedCharModelCache: renderer.getCharModelCache(),
      signal,
      onProgress,
    });
  };

  const renderGifForBundle = (
    bundle: MatchReplayBundle,
    endTickIndex: number,
    signal: AbortSignal,
    onProgress: (progress01: number, phaseText: string) => void,
  ) => {
    const s = settings.get();
    const frozenBundle: MatchReplayBundle = {
      ...bundle,
      replay: { ...bundle.replay, ticks: bundle.replay.ticks.slice() },
    };
    return exportReplayClipToGif(frozenBundle, {
      endTickIndex,
      maxDurationSec: 10.0,
      graphicsQuality: s.graphicsQuality,
      edgeBeautify: s.edgeBeautify,
      dartOutline: s.dartOutline,
      cinematic: getCinematicOptions(s),
      sharedCharModelCache: renderer.getCharModelCache(),
      signal,
      onProgress,
    });
  };

  const runMobileMp4Export = async (bundle: MatchReplayBundle) => {
    if (mobileExportModal.isExporting()) return;
    const abortCtrl = new AbortController();
    const presetLabel = formatExportPresetLabel(settings.get());
    platform.setAutoFullscreenSuspended(true);
    const seq = mobileExportModal.openProgress({
      kind: 'mp4',
      subtitle: `《${bundle.summary.mapTitle}》 · ${presetLabel}`,
      abortController: abortCtrl,
    });
    await platform.exitFullscreenTemporarily();
    lobbyUI.refreshPlatformButtons();
    if (abortCtrl.signal.aborted) {
      mobileExportModal.close();
      return;
    }

    try {
      const res = await renderMp4ForBundle(bundle, abortCtrl.signal, (p01, phaseText) => {
        mobileExportModal.updateProgress(seq, p01, phaseText);
      });
      const audioTag =
        res.hasSfx && res.hasBgm
          ? '含音效与 BGM'
          : res.hasBgm
            ? '含 BGM'
            : res.hasSfx
              ? '含音效'
              : '无音轨';
      mobileExportModal.showReady(seq, {
        kind: 'mp4',
        blob: res.blob,
        filename: res.filename,
        metaText: `${res.width}×${res.height} · ${audioTag}`,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        mobileExportModal.close();
      } else {
        mobileExportModal.showError(seq, err instanceof Error ? err.message : String(err));
      }
    }
  };

  const runMobileMp4ExportById = async (matchId: string) => {
    if (mobileExportModal.isExporting()) return;
    const bundle = await matchHistory.getReplayBundle(matchId);
    if (!bundle) {
      alert('未找到该场对局的回放数据（可能已被清理）。');
      return;
    }
    await runMobileMp4Export(bundle);
  };

  const runMobileGifExport = async (bundle: MatchReplayBundle, endTickIndex: number) => {
    if (mobileExportModal.isExporting()) return;
    const abortCtrl = new AbortController();
    const endSec = endTickIndex / 20;
    const startSec = Math.max(0, endSec - 10);
    const rangeLabel = `${startSec.toFixed(1)}s–${endSec.toFixed(1)}s · 24fps GIF`;
    platform.setAutoFullscreenSuspended(true);
    const seq = mobileExportModal.openProgress({
      kind: 'gif',
      subtitle: `《${bundle.summary.mapTitle}》 · ${rangeLabel}`,
      abortController: abortCtrl,
    });
    await platform.exitFullscreenTemporarily();
    lobbyUI.refreshPlatformButtons();
    if (abortCtrl.signal.aborted) {
      mobileExportModal.close();
      return;
    }

    try {
      const res = await renderGifForBundle(bundle, endTickIndex, abortCtrl.signal, (p01, phaseText) => {
        mobileExportModal.updateProgress(seq, p01, phaseText);
      });
      mobileExportModal.showReady(seq, {
        kind: 'gif',
        blob: res.blob,
        filename: res.filename,
        metaText: `${res.durationSec.toFixed(1)}s · ${res.width}×${res.height} @ ${res.fps}fps`,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        mobileExportModal.close();
      } else {
        mobileExportModal.showError(seq, err instanceof Error ? err.message : String(err));
      }
    }
  };

  const cricketBatchModal = new CricketBatchModal({
    onOpenCricketHistory: () => {
      void historyModal.open({ filter: 'cricket', resetFilters: true });
    },
  });

  const startCricketBatchRun = async (count: number) => {
    if (mode !== 'lobby' || cricketBatchModal.isRunning()) return;
    if (!cricketStore.canStartMatch().ok) return;

    const abortController = new AbortController();
    const format = cricketStore.getFormat();
    const mapPoolCount = cricketStore.getMapPoolMetas().length;
    cricketBatchModal.openRunning({
      total: count,
      format,
      mapPoolCount,
      abortController,
    });

    const SAVE_CHUNK_SIZE = 10;
    let pendingBundles: MatchReplayBundle[] = [];
    let saveQueue: Promise<void> = Promise.resolve();

    const flushPendingBundles = (force: boolean) => {
      if (pendingBundles.length === 0) return;
      if (!force && pendingBundles.length < SAVE_CHUNK_SIZE) return;
      const chunk = pendingBundles;
      pendingBundles = [];
      saveQueue = saveQueue
        .then(() => matchHistory.saveBundlesBatch(chunk))
        .catch((err) => {
          console.error('Failed to save Cricket batch history chunk:', err);
        });
    };

    trackMatchStart('cricket-batch');
    try {
      const result = await runCricketBatch({
        totalMatches: count,
        format,
        mapPoolCount,
        createConfig: () => lobbyUI.createCricketMatchConfig(),
        signal: abortController.signal,
        onMatchComplete: (bundle) => {
          const finalSum = bundle.summary;
          cricketStore.recordMatchResult(
            finalSum.players.map((p) => ({
              botId: p.botId,
              kills: p.kills,
              alive: p.alive,
              won: finalSum.winner >= 0 && finalSum.winner === p.seat,
            })),
          );
          pendingBundles.push(bundle);
          flushPendingBundles(false);
        },
        onProgress: (p) => {
          cricketBatchModal.updateProgress(p);
        },
      });
      flushPendingBundles(true);
      await saveQueue;
      lobbyUI.refreshFromStores();
      if (result.cancelled && result.completedMatches === 0) {
        cricketBatchModal.close();
      } else {
        trackMatchEnd('cricket-batch');
        cricketBatchModal.showResult(result);
      }
    } catch (err) {
      flushPendingBundles(true);
      await saveQueue;
      lobbyUI.refreshFromStores();
      console.error('Cricket batch simulation error:', err);
      cricketBatchModal.showError(err instanceof Error ? err.message : String(err));
    }
  };

  let mobileControls: MobileControls | null = null;
  const layoutEditor = new MobileLayoutEditor(settings);

  const settingsModal = new SettingsModal(settings, {
    onOpenChange: (open) => {
      settingsOpen = open;
      if (!open && layoutEditor.isOpen()) layoutEditor.close(false);
      syncExternalPause();
    },
    isMobile: () => platform.isMobile(),
    onEditMobileLayout: () => {
      layoutEditor.open();
    },
    onTestSound: () => {
      sfx.playCatch();
    },
    onResetConfig: () => {
      lobbyUI.resetLobbyConfig();
    },
    onResetRanked: () => {
      leaderboard.resetRankedAll();
      lobbyUI.refreshFromStores();
    },
  });

  let uiHidden = false;
  let uiHiddenToastTimer: number | null = null;
  const uiHiddenToast = document.createElement('div');
  uiHiddenToast.id = 'ui-hidden-toast';
  uiHiddenToast.className = 'ui-hidden-toast';
  uiHiddenToast.setAttribute('role', 'status');
  uiHiddenToast.setAttribute('aria-live', 'polite');
  document.body.appendChild(uiHiddenToast);

  const setUiHidden = (hidden: boolean, showHint = false) => {
    uiHidden = hidden;
    document.body.classList.toggle('ui-hidden', hidden);
    if (uiHiddenToastTimer !== null) {
      window.clearTimeout(uiHiddenToastTimer);
      uiHiddenToastTimer = null;
    }
    if (hidden && showHint) {
      const keyLabel = formatPrimaryBind(shortcutBind(settings.get(), 'toggleHideUi'), 'Shift+F');
      uiHiddenToast.textContent = `已隐藏界面 · 按 ${keyLabel} 恢复显示`;
      uiHiddenToast.classList.add('is-visible');
      uiHiddenToastTimer = window.setTimeout(() => {
        uiHiddenToastTimer = null;
        uiHiddenToast.classList.remove('is-visible');
      }, 1800);
    } else {
      uiHiddenToast.classList.remove('is-visible');
    }
  };

  const pvpNotice = document.createElement('div');
  pvpNotice.className = 'ui-hidden-toast platform-toast';
  pvpNotice.setAttribute('role', 'status');
  document.body.appendChild(pvpNotice);
  let pvpNoticeTimer = 0;
  const showPvpNotice = (message: string) => {
    pvpNotice.textContent = message;
    pvpNotice.classList.add('is-visible');
    window.clearTimeout(pvpNoticeTimer);
    pvpNoticeTimer = window.setTimeout(() => pvpNotice.classList.remove('is-visible'), 3500);
  };

  const isTextEditableTarget = (target: EventTarget | null): boolean => {
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      const t = (target.type || 'text').toLowerCase();
      return t !== 'range' && t !== 'checkbox' && t !== 'radio' && t !== 'button' && t !== 'submit' && t !== 'reset';
    }
    return target instanceof HTMLElement && target.isContentEditable;
  };

  let pendingHistorySave: Promise<void> | null = null;
  let favoriteWriteQueue: Promise<void> = Promise.resolve();

  const toggleBundleFavorite = (bundle: MatchReplayBundle, nextFavorite: boolean): Promise<void> => {
    bundle.summary.favorite = nextFavorite;
    const task = favoriteWriteQueue.then(async () => {
      if (pendingHistorySave) {
        await pendingHistorySave;
      }
      const updated = await matchHistory.setFavorite(bundle.summary.id, nextFavorite);
      if (!updated && !(mode === 'replay' && replayController.getState().computing) && bundle.replay.ticks.length > 0) {
        await matchHistory.saveBundle(bundle);
      }
    });
    favoriteWriteQueue = task.catch(() => undefined);
    return task;
  };

  const enqueueHistorySave = (bundle: MatchReplayBundle) => {
    const p = matchHistory.saveBundle(bundle).catch((err) => {
      console.error('Failed to save match history bundle:', err);
    });
    pendingHistorySave = p;
    void p.finally(() => {
      if (pendingHistorySave === p) pendingHistorySave = null;
    });
  };

  const persistCurrentMatchHistory = (
    eloResult: EloUpdateResult | null,
    earlyExit: boolean,
    finalState?: TickSnapshot,
  ) => {
    if (historyRecorded || !activeConfig || !activeMapData) return;
    const ticks = liveController().getRecordedTicks().slice();
    if (ticks.length === 0) return;
    historyRecorded = true;
    const bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, eloResult, earlyExit);
    if (activeConfig.pvp && finalState) {
      // The relay may award a forfeit without changing the final engine tick.
      bundle.summary.humanSeat = activeConfig.pvp.mySeat;
      bundle.summary.winner = finalState.winner;
      bundle.summary.players.forEach((player, seat) => { player.rank = finalState.players[seat].rank; });
    }
    lastFinishedBundle = bundle;
    enqueueHistorySave(bundle);
  };

  /** Training ground chrome: hides the match timer / collapse pill and the scarecrows' HUD cards (CSS), shows the status pill. */
  const setTrainingChrome = (on: boolean) => {
    document.body.classList.toggle('training-mode', on);
    if (on) trainingPanel.show(platform.isMobile());
    else trainingPanel.hide();
  };

  const disposePvpMatch = () => {
    if (!pvpController) return;
    pvpController.stop();
    pvpController = null;
    pvpRematchState = null;
    hudUI.setPvpRematchState(null);
    hudUI.setNetStats(null);
    mobileControls?.setBulletTimeAllowed(true);
  };

  const returnToLobby = (opts?: { openLeaderboard?: boolean; openHistory?: boolean; rankedMode?: RankedMode }) => {
    if (pvpController && !pvpController.isFinished()) {
      pvpController.requestQuit();
      return;
    }
    const wasPvp = activeConfig?.matchMode === 'pvp';
    if (wasPvp) pvpLobby.leaveRematch();
    disposePvpMatch();
    setUiHidden(false);
    setTrainingChrome(false);
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    clearReplayPlaylist();
    controller.stop();
    replayController.stop();
    input.setEnabled(false);
    mobileControls?.hide();
    hudUI.hide();
    mode = 'lobby';
    activeConfig = null;
    activeMapData = null;
    replayMapData = null;
    lastFinishedBundle = null;
    bgm.enterLobby();
    lobbyUI.show(wasPvp ? 'pvp' : opts?.openLeaderboard ? 'ranked' : undefined, opts);
    const m = lobbyUI.getSelectedMap();
    void renderer.loadPreviewMap(parseQuickPreviewMap(m), m.theme);
    if (opts?.openHistory) {
      void historyModal.open();
    }
  };

  const startCustomAiSpectator = (cfg: MatchConfig): Promise<void> => {
    let spectatorCounted = false; // site analytics: one 'end' per spectated match
    setTrainingChrome(false);
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    clearReplayPlaylist();
    controller.stop();
    replayController.stop();
    renderer.resetCameraToOverview();
    input.setEnabled(false);
    mobileControls?.hide();
    historyModal.close();
    activeConfig = cfg;
    activeMapData = null;
    replayMapData = null;
    replayIsLiveAi = true;
    bgm.prepareMatchLaunch({ matchMode: cfg.matchMode, bgmSeed: cfg.bgmSeed ?? cfg.seed, slots: cfg.slots });

    let liveBundle: MatchReplayBundle | null = null;
    let liveMapData: EngineMapData | null = null;
    let savedHistory = false;

    const persistCompleteBundle = () => {
      if (savedHistory || !liveBundle) return;
      savedHistory = true;
      historyRecorded = true;
      if (cfg.matchMode === 'cricket') {
        const finalSum = liveBundle.summary;
        cricketStore.recordMatchResult(
          finalSum.players.map((p, seat) => ({
            botId: p.botId,
            kills: p.kills,
            alive: p.alive,
            won: finalSum.winner >= 0 && finalSum.winner === seat,
          })),
        );
      }
      enqueueHistorySave(liveBundle);
    };

    lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
    return controller.startStreamingAiSim(cfg, {
      onStatus: (msg) => {
        if (mode === 'lobby') lobbyUI.setLoading(msg);
      },
      onInit: async (mapData, ticks, simComplete) => {
        if (activeConfig !== cfg) return;
        liveMapData = mapData;
        activeMapData = mapData;
        replayMapData = mapData;
        liveBundle = buildMatchHistoryBundle(cfg, mapData, ticks, null, false);
        lobbyUI.setLoading(null);
        lobbyUI.hide();
        mode = 'replay';
        await replayController.start(
          liveBundle,
          cfg.speed,
          getCinematicOptions(settings.get()),
          simComplete,
          { countdown: true },
        );
        if (simComplete && activeConfig === cfg) {
          persistCompleteBundle();
        }
      },
      onProgress: (ticks, simComplete) => {
        if (activeConfig !== cfg || !liveBundle || !liveMapData) return;
        if (simComplete) {
          if (!spectatorCounted) {
            spectatorCounted = true;
            trackMatchEnd(cfg.matchMode);
          }
          const rebuilt = buildMatchHistoryBundle(cfg, liveMapData, ticks, null, false);
          liveBundle.summary = {
            ...rebuilt.summary,
            id: liveBundle.summary.id,
            playedAt: liveBundle.summary.playedAt,
            favorite: liveBundle.summary.favorite,
          };
          persistCompleteBundle();
        } else {
          liveBundle.summary.durationTicks = ticks[ticks.length - 1]?.t ?? Math.max(0, ticks.length - 1);
        }
        replayController.notifyTicksExtended(simComplete);
      },
      onError: (err) => {
        console.error('Streaming AI match error:', err);
        lobbyUI.setLoading(null);
        alert(`AI 对局推演出错：${err}`);
        returnToLobby();
      },
    });
  };

  const startReplayBundle = async (
    bundle: MatchReplayBundle,
    fallbackOpenHistory = false,
    opts?: { keepPlaylist?: boolean; speed?: number },
  ) => {
    if (pvpController && !pvpController.isFinished()) return;
    if (pvpController) pvpLobby.leaveRematch();
    disposePvpMatch();
    setTrainingChrome(false);
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    if (!opts?.keepPlaylist) {
      clearReplayPlaylist();
    }
    controller.stop();
    replayController.stop();
    renderer.resetCameraToOverview();
    input.setEnabled(false);
    mobileControls?.hide();
    activeConfig = null;
    activeMapData = null;
    replayMapData = bundle.replay.mapData;
    lastFinishedBundle = null;
    bgm.prepareMatchLaunch({
      matchMode: bundle.summary.matchMode,
      bgmSeed: bundle.summary.bgmSeed ?? bundle.summary.seed,
      slots: bundle.summary.slots,
    });
    hudUI.cancelResultOverlay(false, false);
    historyModal.close();
    lobbyUI.hide();
    mode = 'replay';
    const speed = opts?.speed ?? 1.0;
    trackMatchStart('replay');
    try {
      await replayController.start(bundle, speed, getCinematicOptions(settings.get()), true);
    } catch (err) {
      console.error('Failed to start replay:', err);
      alert(`回放加载失败：${err instanceof Error ? err.message : String(err)}`);
      returnToLobby(fallbackOpenHistory ? { openHistory: true } : undefined);
    }
  };

  /** Training ground: endless, invincible player, scarecrow dummies (see src/game/training.ts). Exit with ESC / 主界面. */
  const startTraining = () => {
    const s = settings.get();
    const cfg = createTrainingConfig(resolveSlots([{ kind: 'human', botId: '' }], roster)[0]);
    cfg.cliffGuard = s.cliffGuard;
    cfg.dashGuard = s.dashGuard;
    cfg.meleeAssist = s.meleeAssist;
    cfg.humanSlashTicks = getSlashJudgmentTicks(s.slashJudgment);
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    clearReplayPlaylist();
    lastFinishedBundle = null;
    replayController.stop();
    renderer.resetCameraToOverview();
    historyModal.close();
    activeConfig = cfg;
    bgm.prepareMatchLaunch({ matchMode: cfg.matchMode, bgmSeed: cfg.seed, slots: cfg.slots });
    lobbyUI.setLoading('进入训练场...');
    void controller.start(cfg, { cinematic: getCinematicOptions(settings.get()) }).catch((err) => {
      console.error(err);
      lobbyUI.setLoading(null);
      alert(`训练场启动失败：${err instanceof Error ? err.message : String(err)}`);
      returnToLobby();
    });
  };

  const startReplayById = async (matchId: string, playlistIds?: string[]) => {
    const bundle = await matchHistory.getReplayBundle(matchId);
    if (!bundle) {
      alert('未找到该场对局的回放数据（可能已被清理）。');
      return;
    }
    if (playlistIds && playlistIds.length > 0) {
      const idx = playlistIds.indexOf(matchId);
      if (idx >= 0) {
        replayPlaylist = playlistIds.slice();
        replayPlaylistIndex = idx;
      } else {
        replayPlaylist = [matchId];
        replayPlaylistIndex = 0;
      }
      replaySwitchSeq++;
      replaySwitching = false;
    } else {
      clearReplayPlaylist();
    }
    await startReplayBundle(bundle, true, { keepPlaylist: true });
  };

  const switchReplayPlaylist = async (delta: -1 | 1) => {
    if (mode !== 'replay' || replayIsLiveAi || replaySwitching || replayPlaylist.length === 0) return;
    let targetIdx = replayPlaylistIndex + delta;
    if (targetIdx < 0 || targetIdx >= replayPlaylist.length) return;

    const mySeq = ++replaySwitchSeq;
    replaySwitching = true;
    hudUI.setReplayPlaylist(getReplayPlaylistState());

    try {
      let bundle: MatchReplayBundle | null = null;
      while (targetIdx >= 0 && targetIdx < replayPlaylist.length) {
        const candidateId = replayPlaylist[targetIdx];
        const loaded = await matchHistory.getReplayBundle(candidateId);
        if (mySeq !== replaySwitchSeq || mode !== 'replay') return;
        if (loaded) {
          bundle = loaded;
          break;
        }
        // Drop stale/deleted record from playlist and continue walking in the same direction
        replayPlaylist.splice(targetIdx, 1);
        if (delta < 0) targetIdx--;
        if (replayPlaylistIndex >= replayPlaylist.length) {
          replayPlaylistIndex = replayPlaylist.length - 1;
        }
      }

      if (!bundle) {
        replaySwitching = false;
        hudUI.setReplayPlaylist(getReplayPlaylistState());
        return;
      }

      const curSpeed = replayController.getState().speed || 1.0;
      replayPlaylistIndex = targetIdx;
      replaySwitching = false;
      await startReplayBundle(bundle, true, { keepPlaylist: true, speed: curSpeed });
    } catch (err) {
      console.error('Failed to switch replay playlist item:', err);
      if (mySeq === replaySwitchSeq) {
        replaySwitching = false;
        hudUI.setReplayPlaylist(getReplayPlaylistState());
      }
    }
  };

  const canQuickRestart = (): boolean => {
    if (!activeConfig || restarting || pvpController) return false;
    if (mode === 'replay' && replayIsLiveAi) return true;
    if (mode !== 'playing') return false;
    const hSeat = controller.getHumanSeat();
    // Pure AI spectator match
    if (hSeat < 0) return true;
    const st = controller.getCurrentState();
    if (!st) return false;
    // Once a ranked match is finished (result screen), R can also launch New Match
    if (st.over && isRankedMatchMode(activeConfig.matchMode)) return true;
    // During live match, only allowed once human is eliminated (spectating)
    const me = st.players[hSeat];
    return !!me && !me.alive;
  };

  const restartCurrentMatch = () => {
    if (!activeConfig || restarting || pvpController) return;
    restarting = true;
    clearMatchOverTimer();
    mobileControls?.hide();

    if (activeConfig.matchMode === 'cricket') {
      const freshCfg = lobbyUI.createCricketMatchConfig();
      if (!freshCfg) {
        restarting = false;
        returnToLobby();
        return;
      }
      void startCustomAiSpectator(freshCfg)
        .catch((err) => {
          console.error(err);
          alert(`重抽失败：${err instanceof Error ? err.message : String(err)}`);
          returnToLobby();
        })
        .finally(() => {
          restarting = false;
        });
      return;
    }

    const isPureCustomAi =
      activeConfig.matchMode === 'custom' && activeConfig.slots.every((s) => s.kind === 'bot');
    if (isPureCustomAi) {
      const freshCfg: MatchConfig = {
        ...activeConfig,
        seed: (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0,
        spawnSeed: generateSpawnSeed(),
        bgmSeed: generateBgmSeed(),
        slots: activeConfig.slots.map((s) => ({ ...s })),
      };
      void startCustomAiSpectator(freshCfg)
        .catch((err) => {
          console.error(err);
          alert(`重开失败：${err instanceof Error ? err.message : String(err)}`);
          returnToLobby();
        })
        .finally(() => {
          restarting = false;
        });
      return;
    }

    // If an eliminated human restarts before remaining bots finish, settle Ranked Elo by current rank first!
    if (!matchRecorded) {
      const hSeat = controller.getHumanSeat();
      const st = controller.getCurrentState();
      if (hSeat >= 0 && st && st.players[hSeat] && !st.players[hSeat].alive) {
        matchRecorded = true;
        const eloResult = leaderboard.recordHumanEarlyExit(activeConfig, st);
        if (eloResult) {
          hudUI.showEloToast(st.players[hSeat].rank, eloResult, 'loss');
          persistCurrentMatchHistory(eloResult, true);
        }
      }
    } else if (!resultOverlayShown && pendingMatchElo) {
      // Match already ended (e.g. SOLO win/loss/draw or FFA finish) and player pressed R early
      // before the 1.6s result card popped up -> show the Elo settlement toast!
      hudUI.showEloToast(pendingMatchElo.rank, pendingMatchElo.elo, pendingMatchElo.outcome);
    }

    const isRanked = isRankedMatchMode(activeConfig.matchMode);
    hudUI.cancelResultOverlay(true, isRanked);
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    lastFinishedBundle = null;

    let cfg: MatchConfig;
    if (isRanked) {
      // Ranked R restart: re-matchmake using the NEW updated Elo score (fresh map + fresh opponents!)
      const rankedMode: RankedMode = activeConfig.matchMode === 'ranked-solo' ? 'solo' : 'ffa';
      const prevBotIds = activeConfig.slots
        .filter((s) => s.kind === 'bot' && Boolean(s.botId))
        .map((s) => s.botId!);
      cfg = lobbyUI.createRankedMatchConfig(rankedMode, prevBotIds);
    } else {
      // Custom R restart: exact same map, contestants, spawn order, legacy seed, and speed;
      // re-roll independent spawnSeed & bgmSeed so spawns and special BGM roll freshly on each match.
      const s = settings.get();
      cfg = {
        ...activeConfig,
        spawnSeed: generateSpawnSeed(),
        bgmSeed: generateBgmSeed(),
        slots: activeConfig.slots.map((s) => ({ ...s })),
        cliffGuard: s.cliffGuard,
        dashGuard: s.dashGuard,
        meleeAssist: s.meleeAssist,
        humanSlashTicks: getSlashJudgmentTicks(s.slashJudgment),
      };
    }

    activeConfig = cfg;
    bgm.prepareMatchLaunch({ matchMode: cfg.matchMode, bgmSeed: cfg.bgmSeed ?? cfg.seed, slots: cfg.slots });
    renderer.resetCameraToOverview();
    void controller
      .start(cfg, { cinematic: getCinematicOptions(settings.get()) })
      .catch((err) => {
        console.error(err);
        alert(`重开失败：${err instanceof Error ? err.message : String(err)}`);
        returnToLobby();
      })
      .finally(() => {
        restarting = false;
      });
  };

  const startRenderLoop = () => {
    stopRenderLoop();
    const tickRender = () => {
      platform.setAutoSwitchAllowed(mode === 'lobby' && !settingsOpen && !cricketBatchModal.isOpen() && !mobileExportOpen);
      renderer.renderFrame(input);
      const now = performance.now();
      if (mode === 'playing' && now - lastTelemetryUpdateMs >= 200) {
        lastTelemetryUpdateMs = now;
        hudUI.updateTelemetry(
          pvpController ? 20 : controller.actualLogicHz,
          renderer.renderHz,
          renderer.avgFrameWorkMs,
          pvpController ? 0 : controller.lastBotMaxMs,
          activeConfig?.speed ?? 1.0,
        );
      } else if (mode === 'replay' && now - lastTelemetryUpdateMs >= 200) {
        lastTelemetryUpdateMs = now;
        const rs = replayController.getState();
        hudUI.updateReplayTelemetry(renderer.renderHz, renderer.avgFrameWorkMs, rs.speed, rs.paused, rs.computing);
      }
    };

    if (activeLockFps) {
      const loop = () => {
        tickRender();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      // Uncapped render loop via MessageChannel macrotask (pauses automatically when tab hidden)
      uncapRunning = true;
      uncapChannel = new MessageChannel();
      const step = () => {
        if (!uncapRunning) return;
        if (document.hidden) {
          window.setTimeout(() => uncapChannel?.port2.postMessage(null), 50);
          return;
        }
        tickRender();
        uncapChannel?.port2.postMessage(null);
      };
      uncapChannel.port1.onmessage = step;
      uncapChannel.port2.postMessage(null);
    }
  };

  const stopRenderLoop = () => {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    uncapRunning = false;
    if (uncapChannel) {
      uncapChannel.port1.onmessage = null;
      uncapChannel.port1.close();
      uncapChannel.port2.close();
      uncapChannel = null;
    }
  };

  settings.onChange((s) => {
    sfx.applySettings(s.soundEnabled, s.volume);
    bgm.applySettings(s.bgmEnabled, s.bgmVolume, s.bossMusicEnabled);
    if (!pvpController) {
      controller.setCliffGuard(s.cliffGuard);
      controller.setDashGuard(s.dashGuard);
      controller.setMeleeAssist(s.meleeAssist);
      controller.setHumanSlashTicks(getSlashJudgmentTicks(s.slashJudgment));
    }
    if (s.lockFps !== activeLockFps) {
      activeLockFps = s.lockFps;
      startRenderLoop();
    }
    if (s.graphicsQuality !== activeGraphicsQuality) {
      activeGraphicsQuality = s.graphicsQuality;
      renderer.setGraphicsQuality(s.graphicsQuality);
    }
    if (s.edgeBeautify !== activeEdgeBeautify) {
      activeEdgeBeautify = s.edgeBeautify;
      renderer.setEdgeBeautify(s.edgeBeautify);
    }
    if (s.dartOutline !== activeDartOutline) {
      activeDartOutline = s.dartOutline;
      renderer.setDartOutline(s.dartOutline);
    }
    const cinematic = getCinematicOptions(s);
    renderer.setKillFxEnabled(cinematic.killFx);
    controller.setKillFxEnabled(cinematic.killFx);
    if (mode === 'replay') {
      replayController.setCinematicOptions(cinematic);
    } else if (mode === 'playing' && !pvpController) {
      const updatedDir = controller.setCinematicOptions(cinematic);
      if (updatedDir) {
        renderer.setCinematicDirector(updatedDir);
        renderer.setPlaybackSpeed(activeConfig?.speed ?? 1.0);
      } else {
        const curSt = controller.getCurrentState();
        if (curSt?.over && activeMapData) {
          const hSeat = controller.getHumanSeat();
          const recorded = controller.getRecordedTicks();
          const prevSt = recorded.length >= 2 ? recorded[recorded.length - 2] : null;
          const spectatingFinal = hSeat < 0 || Boolean(prevSt && prevSt.players[hSeat]?.alive === 0);
          renderer.setCinematicDirector(
            CinematicDirector.createWinnerCloseupOnly(
              curSt,
              activeMapData,
              s.winnerCam,
              spectatingFinal && cinematic.killFx,
            ),
          );
        }
      }
    }
  });

  hudUI = new HudUI(uiRoot, settings, {
    onReturnToLobby: returnToLobby,
    onPvpRematch: () => {
      if (pvpController?.isFinished() && resultOverlayShown) pvpLobby.requestRematch();
    },
    onPvpExit: () => returnToLobby(),
    onRestartMatch: restartCurrentMatch,
    canQuickRestart: () => canQuickRestart(),
    onWatchCurrentReplay: () => {
      let bundle = lastFinishedBundle;
      if (!bundle && activeConfig && activeMapData) {
        const ticks = liveController().getRecordedTicks().slice();
        if (ticks.length > 0) {
          bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, null, false);
        }
      }
      if (!bundle) return;
      void startReplayBundle(bundle, false);
    },
    onToggleCurrentFavorite: (nextFavorite) => {
      let bundle = lastFinishedBundle;
      if (!bundle && activeConfig && activeMapData) {
        const ticks = liveController().getRecordedTicks().slice();
        if (ticks.length > 0) {
          bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, pendingMatchElo?.elo ?? null, false);
          lastFinishedBundle = bundle;
        }
      }
      if (!bundle) return;
      return toggleBundleFavorite(bundle, nextFavorite);
    },
    onOpenSettings: () => {
      settingsModal.open();
    },
    onRankCue: (kind) => {
      if (kind === 'up') sfx.playRankUp();
      else sfx.playRankDown();
    },
    onReplayTogglePause: () => {
      replayController.togglePause();
    },
    onReplayRestart: () => {
      replayController.restart();
    },
    onReplayPrev: () => {
      void switchReplayPlaylist(-1);
    },
    onReplayNext: () => {
      void switchReplayPlaylist(1);
    },
    onReplaySeek: (tickIdx) => {
      replayController.seekTo(tickIdx);
    },
    onReplaySpeed: (spd) => {
      replayController.setSpeed(spd);
    },
    onReplayToggleFavorite: (bundle, nextFavorite) => toggleBundleFavorite(bundle, nextFavorite),
    onReplayExportMp4: async (bundle, signal, onProgress) => {
      const result = await renderMp4ForBundle(bundle, signal, onProgress);
      triggerMp4Download(result.blob, result.filename);
      return result;
    },
    onReplayExportGif: async (bundle, endTickIndex, signal, onProgress) => {
      const result = await renderGifForBundle(bundle, endTickIndex, signal, onProgress);
      triggerGifDownload(result.blob, result.filename);
      return result;
    },
    onMobileReplayExportMp4: (bundle) => {
      void runMobileMp4Export(bundle);
    },
    onMobileReplayExportGif: (bundle, endTickIndex) => {
      void runMobileGifExport(bundle, endTickIndex);
    },
  });
  renderer.setNameplateLayer(hudUI.nameplateLayer);
  hudUI.setMobile(platform.isMobile());
  trainingPanel = new TrainingPanel(uiRoot);

  mobileControls = new MobileControls(uiRoot, input, settings, {
    onAimSlowmo: (active) => {
      if (mode !== 'playing' || pvpController) return;
      // Aim slow-mo pins the live clock to 0.1x regardless of the configured match speed
      const eff = controller.setSpeedOverride(active ? 0.1 : null);
      renderer.setPlaybackSpeed(eff);
      document.body.classList.toggle('m-aim-slowmo', active);
    },
    onAimIndicator: (dir, cancel) => {
      renderer.setAimIndicator(dir, Boolean(cancel));
    },
  });

  const handleCountdown = (stage: CountdownStage) => {
    hudUI.setCountdown(stage);
    renderer.setCountdownStage(stage);
    if (stage === 3 || stage === 2 || stage === 1) {
      sfx.playCountdownTick(stage);
    } else if (stage === 'GO') {
      sfx.playCountdownGo();
    }
  };

  replayController = new ReplayController(renderer, {
    onLoaded: (bundle, state) => {
      bgm.beginMatch(
        {
          matchMode: bundle.summary.matchMode,
          bgmSeed: bundle.summary.bgmSeed ?? bundle.summary.seed,
          slots: bundle.summary.slots,
        },
        bundle.replay.ticks[0],
      );
      hudUI.showReplay(bundle, state, {
        liveAiSpectator: replayIsLiveAi,
        playlist: getReplayPlaylistState(),
      });
      hudUI.updateTick(
        bundle.replay.ticks[0],
        bundle.replay.mapData.colStart,
        bundle.replay.mapData.colEvery,
      );
    },
    onTick: (snapshot, state) => {
      bgm.updateMatchTick(snapshot);
      hudUI.updateTick(snapshot, replayMapData?.colStart, replayMapData?.colEvery);
      hudUI.updateReplayControls(state);
    },
    onSeek: (bundle, tickIndex) => {
      bgm.syncReplaySeek(bundle.replay.ticks, tickIndex);
    },
    onRestart: (bundle) => {
      bgm.restartReplay(bundle.replay.ticks);
    },
    onStateChange: (state) => {
      hudUI.updateReplayControls(state);
    },
    onTimelineExtended: (bundle, state) => {
      hudUI.updateReplayTimeline(bundle, state);
    },
    onCountdown: handleCountdown,
  });

  historyModal = new HistoryModal(matchHistory, settings, {
    onReplay: startReplayById,
    onExportMp4: async (matchId, signal, onProgress) => {
      const bundle = await matchHistory.getReplayBundle(matchId);
      if (!bundle) {
        throw new Error('未找到该场对局的回放数据');
      }
      const result = await renderMp4ForBundle(bundle, signal, onProgress);
      triggerMp4Download(result.blob, result.filename);
      return result;
    },
    onMobileExportMp4: (matchId) => {
      void runMobileMp4ExportById(matchId);
    },
    onOpenSettings: () => {
      settingsModal.open();
    },
    isMobile: () => platform.isMobile(),
  });

  const matchCallbacks: MatchCallbacks = {
    onStatus: (msg) => {
      if (mode === 'lobby') lobbyUI.setLoading(msg);
    },
    onCountdown: handleCountdown,
    onMapLoaded: async (mapData, initialState, director) => {
      if (!activeConfig) return;
      activeMapData = mapData;
      const cfg = activeConfig;
      const hSeat = liveController().getHumanSeat();
      await renderer.setupMatch(mapData, cfg.mapMeta.theme, cfg.slots, initialState, hSeat, cfg.speed);
      if (activeConfig !== cfg) return;
      renderer.setCinematicDirector(director ?? null);
      const isTraining = cfg.matchMode === 'training';
      renderer.setTrainingMode(isTraining);
      renderer.setWorldLabels([]);
      mode = 'playing';
      lobbyUI.hide();
      bgm.beginMatch({ matchMode: cfg.matchMode, bgmSeed: cfg.bgmSeed ?? cfg.seed, slots: cfg.slots }, initialState);
      hudUI.showMatch(cfg, hSeat);
      setTrainingChrome(isTraining);
      hudUI.updateTick(initialState, mapData.colStart, mapData.colEvery);
      document.body.classList.remove('m-aim-slowmo');
      if (platform.isMobile() && hSeat >= 0) {
        mobileControls?.show(hSeat, mapData);
        mobileControls?.onTick(initialState, liveController().getTickIntervalMs());
      } else {
        mobileControls?.hide();
      }
    },
    onTick: (prev, next, tickDurationMs, pvpRollback) => {
      renderer.pushTick(prev, next, tickDurationMs, pvpRollback);
      bgm.updateMatchTick(next);
      hudUI.updateTick(next, activeMapData?.colStart, activeMapData?.colEvery);
      mobileControls?.onTick(next, tickDurationMs);
      if (!pvpController && controller.isTraining()) trainingPanel.onTick(next, controller.getHumanSeat());
    },
    onMatchOver: (finalState, director) => {
      if (activeConfig && !matchRecorded) trackMatchEnd(activeConfig.matchMode);
      mobileControls?.hide();
      document.body.classList.remove('m-aim-slowmo');
      bgm.updateMatchTick(finalState);
      hudUI.updateTick(finalState, activeMapData?.colStart, activeMapData?.colEvery);
      let eloResult: EloUpdateResult | null = null;
      if (activeConfig && !matchRecorded) {
        matchRecorded = true;
        if (isRankedMatchMode(activeConfig.matchMode)) {
          eloResult = leaderboard.recordMatch(activeConfig, finalState);
        }
        if (eloResult) {
          const hSeat = liveController().getHumanSeat();
          const hp = hSeat >= 0 ? finalState.players[hSeat] : null;
          const outcome: 'win' | 'draw' | 'loss' =
            finalState.winner >= 0 && finalState.winner === hSeat
              ? 'win'
              : finalState.winner === -1 && hp?.rank === 1
                ? 'draw'
                : 'loss';
          pendingMatchElo = {
            rank: hp?.rank ?? activeConfig.slots.length,
            outcome,
            elo: eloResult,
          };
        }
      }
      persistCurrentMatchHistory(eloResult, false, finalState);
      if (pvpController?.isQuitting()) {
        returnToLobby();
        return;
      }
      // Live human matches (and live AI matches with only winnerCam) glide smoothly to the winner front close-up;
      // if already spectating (4P eliminated human), also run upstream final-kill hit-stop + punch when killFx is ON!
      let activeDirector = director ?? null;
      if (!activeDirector && activeMapData) {
        const curSettings = settings.get();
        const hSeat = liveController().getHumanSeat();
        const recorded = liveController().getRecordedTicks();
        const prevSt = recorded.length >= 2 ? recorded[recorded.length - 2] : null;
        const spectatingFinal = hSeat < 0 || Boolean(prevSt && prevSt.players[hSeat]?.alive === 0);
        const wantFinalKillFx = spectatingFinal && isKillFxEffective(curSettings);
        if (curSettings.winnerCam || wantFinalKillFx) {
          activeDirector = CinematicDirector.createWinnerCloseupOnly(
            finalState,
            activeMapData,
            curSettings.winnerCam,
            wantFinalKillFx,
          );
          if (activeDirector) {
            renderer.setCinematicDirector(activeDirector);
          }
        }
      }

      // Wait for victory celebration at 1.0x (post-match playback smoothly transitions to 1.0x regardless of gameSpeed)
      const celebrateMs =
        activeDirector && activeDirector.isEnabled()
          ? Math.round(activeDirector.getRecommendedOutroRealSec(1.6) * 1000)
          : 1600;
      const note = pvpController?.getResultNote();
      const isPvp = activeConfig?.matchMode === 'pvp';
      const series = isPvp ? countPvpSeriesGame(finalState) : undefined;
      scheduleMatchOverTimer(celebrateMs, () => {
        if (mode === 'playing') {
          resultOverlayShown = true;
          pendingMatchElo = null;
          const favorite = Boolean(lastFinishedBundle?.summary.favorite);
          if (isPvp) {
            hudUI.showMatchResult(finalState, null, favorite, { note, pvpRematch: true, pvpSeries: series });
            hudUI.setPvpRematchState(pvpRematchState);
          } else {
            hudUI.showMatchResult(finalState, eloResult, favorite);
          }
        }
      });
    },
    onError: (err) => {
      console.error('Match error:', err);
      lobbyUI.setLoading(null);
      alert(`对局启动出错：${err}`);
      returnToLobby();
    },
  };
  controller = new MatchController(input, matchCallbacks);

  const startInteractiveMatch = (config: MatchConfig) => {
    if (pvpController) return;
    const pvp = config.pvp;
    const link = pvp ? getPvpMatchLink(pvp.matchId) : null;
    if (pvp && !link) return;
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    clearReplayPlaylist();
    lastFinishedBundle = null;
    replayController.stop();
    renderer.resetCameraToOverview();
    historyModal.close();
    activeMapData = null;
    activeConfig = config;
    bgm.prepareMatchLaunch({
      matchMode: config.matchMode,
      bgmSeed: config.bgmSeed ?? config.seed,
      slots: config.slots,
    });

    if (pvp && link) {
      controller.stop();
      pvpLobby.leave();
      // A challenge starts the match with no confirmation: drop any modal left open over the PvP tab
      if (settingsModal.isOpen()) settingsModal.close();
      if (botManager.isOpen()) botManager.close();
      if (cricketBatchModal.isOpen()) cricketBatchModal.close();
      if (mobileExportModal.isOpen()) mobileExportModal.close();
      pvpController = new PvpMatchController(input, config, pvp.mySeat, link, {
        ...matchCallbacks,
        onNotice: showPvpNotice,
        onCancelled: () => {
          disposePvpMatch();
          returnToLobby();
        },
        onError: (err) => {
          disposePvpMatch();
          matchCallbacks.onError?.(err);
        },
      });
      mobileControls.setBulletTimeAllowed(false);
      hudUI.setNetStats(pvpLobby.getStats());
      renderer.setPlaybackPaused(false);
      void pvpController.start();
      return;
    }

    lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
    void controller.start(config, { cinematic: getCinematicOptions(settings.get()) }).catch((err) => {
      console.error(err);
      lobbyUI.setLoading(null);
      alert(`启动失败：${err instanceof Error ? err.message : String(err)}`);
    });
  };

  startAnalytics(); // site analytics heartbeat (no-op when PvP is off, e.g. the mirror build)
  lobbyUI = new LobbyUI(uiRoot, maps, roster, leaderboard, cricketStore, settings, {
    onSelectMap: (map) => {
      if (mode === 'lobby') {
        void renderer.loadPreviewMap(parseQuickPreviewMap(map), map.theme);
      }
    },
    onStartMatch: (config) => {
      const isPureAiSpectator =
        (config.matchMode === 'custom' || config.matchMode === 'cricket') &&
        config.slots.every((s) => s.kind === 'bot');
      if (isPureAiSpectator) {
        void startCustomAiSpectator(config).catch((err) => {
          console.error(err);
          lobbyUI.setLoading(null);
          alert(`启动失败：${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }

      startInteractiveMatch(config);
    },
    onStartCricketBatch: (count) => {
      void startCricketBatchRun(count);
    },
    onOpenHistory: () => {
      void historyModal.open();
    },
    onOpenSettings: () => {
      settingsModal.open();
    },
    onStartTraining: () => {
      if (mode === 'lobby') startTraining();
    },
    onOpenBotManager: () => {
      if (!platform.isMobile()) botManager.open();
    },
    getPlatformState: () => ({
      mobile: platform.isMobile(),
      fullscreen: platform.isFullscreen(),
      fullscreenSupported: platform.isFullscreenSupported(),
    }),
    onTogglePlatform: () => {
      platform.toggle();
    },
    onToggleFullscreen: () => {
      if (platform.isFullscreen() && !platform.isStandaloneApp()) {
        void platform.exitImmersive().finally(() => lobbyUI.refreshPlatformButtons());
      } else if (!platform.isFullscreenSupported()) {
        showPlatformToast('当前浏览器不支持网页全屏 · 请使用「分享 → 添加到主屏幕」以全屏横屏启动');
      } else {
        void platform.enterImmersive().finally(() => lobbyUI.refreshPlatformButtons());
      }
    },
  });

  // Rematch chain with the same opponent: counted per finished match id; a fresh challenge starts a new series
  let pvpSeries: { counted: Set<string>; stats: PvpSeriesStats } | null = null;
  const countPvpSeriesGame = (finalState: TickSnapshot): PvpSeriesStats | undefined => {
    const matchId = activeConfig?.pvp?.matchId;
    if (!matchId) return undefined;
    if (!pvpSeries) pvpSeries = { counted: new Set(), stats: { games: 0, wins: [0, 0], draws: 0 } };
    if (!pvpSeries.counted.has(matchId)) {
      pvpSeries.counted.add(matchId);
      const s = pvpSeries.stats;
      s.games += 1;
      // winner is the canonical result (forfeits included); anything but a seat is a draw / no winner
      if (finalState.winner === 0 || finalState.winner === 1) s.wins[finalState.winner] += 1;
      else s.draws += 1;
    }
    const { games, wins, draws } = pvpSeries.stats;
    return { games, wins: [wins[0], wins[1]], draws };
  };

  pvpLobby.on('matchStart', (info) => {
    if (activeConfig?.pvp?.matchId === info.matchId) return;
    const map = maps.find((entry) => entry.id === info.mapId);
    const rematching = mode === 'playing' && resultOverlayShown && pvpController?.isFinished() &&
      info.rematchOf !== undefined && info.rematchOf === activeConfig?.pvp?.matchId;
    if (map && rematching) {
      hudUI.cancelResultOverlay();
      disposePvpMatch();
      startInteractiveMatch(buildPvpMatchConfig(info, map));
    } else if (map && mode === 'lobby' && !pvpController && !info.rematchOf) {
      pvpSeries = null; // a new challenge (even against the same player) starts a new series
      startInteractiveMatch(buildPvpMatchConfig(info, map));
    } else {
      getPvpMatchLink(info.matchId)?.quit();
    }
  });
  pvpLobby.on('rematch', (state) => {
    if (activeConfig?.pvp?.matchId !== state.matchId) return;
    pvpRematchState = state;
    if (resultOverlayShown) hudUI.setPvpRematchState(state);
  });
  pvpLobby.on('stats', (stats) => {
    if (pvpController) hudUI.setNetStats(stats);
  });
  pvpLobby.on('notice', (message) => {
    if (pvpController) showPvpNotice(message);
  });

  // ---------- PC / mobile presentation switching ----------
  const platformToast = document.createElement('div');
  platformToast.className = 'ui-hidden-toast platform-toast';
  platformToast.setAttribute('role', 'status');
  document.body.appendChild(platformToast);
  let platformToastTimer: number | null = null;
  const showPlatformToast = (text: string) => {
    platformToast.textContent = text;
    platformToast.classList.add('is-visible');
    if (platformToastTimer !== null) window.clearTimeout(platformToastTimer);
    platformToastTimer = window.setTimeout(() => {
      platformToastTimer = null;
      platformToast.classList.remove('is-visible');
    }, 2600);
  };


  platform.onChange((isMobile) => {
    input.setTouchMode(isMobile);
    renderer.setMobileView(isMobile);
    hudUI.setMobile(isMobile);
    trainingPanel.setMobile(isMobile);
    if (!isMobile) layoutEditor.close(false);
    if (isMobile) botManager.close(); // desktop-only panel
    lobbyUI.refreshPlatformButtons();
    if (mode === 'lobby') {
      showPlatformToast(isMobile ? '已切换到移动端 · 触屏操作 · 横屏全屏' : '已切换到桌面端 · 键鼠操作');
    }
  });
  document.addEventListener('fullscreenchange', () => lobbyUI.refreshPlatformButtons());

  // PC players who never picked a control scheme choose one once (标准 / MOBA); touch devices never ask
  const askControlScheme = () => {
    if (platform.isMobile() || settings.get().controlScheme !== null || mode !== 'lobby') return;
    showControlSchemeChooser(settings);
  };
  platform.onChange(() => askControlScheme());
  askControlScheme();
  document.addEventListener('webkitfullscreenchange', () => lobbyUI.refreshPlatformButtons());

  // Mobile browsers: block pinch-zoom / double-tap zoom gestures over the game
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener(
    'dblclick',
    (e) => {
      if (platform.isMobile()) e.preventDefault();
    },
    { passive: false },
  );

  // Disable native browser right-click context menu everywhere inside the page
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Match & Replay keyboard/mouse shortcuts
  window.addEventListener('keydown', (e) => {
    if (settingsModal.isOpen() || historyModal.isOpen() || botManager.isOpen() || cricketBatchModal.isOpen() || mobileExportModal.isOpen()) return;
    if (!e.repeat && !isTextEditableTarget(e.target) && matchesActionKeyEvent(settings.get().keybindings, shortcutAction(settings.get(), 'toggleHideUi'), e)) {
      e.preventDefault();
      setUiHidden(!uiHidden, true);
      return;
    }
    if (e.code === 'Escape') {
      if (mode === 'playing' || mode === 'replay' || pvpController) {
        returnToLobby();
        return;
      }
      if (mode === 'lobby' && uiHidden) {
        setUiHidden(false);
        return;
      }
    }
    if (mode === 'replay') {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        replayController.togglePause();
        return;
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const st = replayController.getState();
        replayController.seekTo(st.tickIndex - 40);
        return;
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault();
        const st = replayController.getState();
        replayController.seekTo(st.tickIndex + 40);
        return;
      }
      if (
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isTextEditableTarget(e.target) &&
        isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'quickRestart'), e.code) &&
        canQuickRestart()
      ) {
        e.preventDefault();
        restartCurrentMatch();
      }
      return;
    }
    if (
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !isTextEditableTarget(e.target) &&
      isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'quickRestart'), e.code) &&
      hudUI.isPvpRematchOpen()
    ) {
      // PvP result card: the quick-restart key (R by default) = 再来一局
      e.preventDefault();
      hudUI.triggerPvpRematch();
      return;
    }
    if (
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !isTextEditableTarget(e.target) &&
      isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'quickRestart'), e.code) &&
      canQuickRestart()
    ) {
      e.preventDefault();
      restartCurrentMatch();
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (settingsModal.isOpen() || historyModal.isOpen() || botManager.isOpen() || cricketBatchModal.isOpen() || mobileExportModal.isOpen()) return;
    const code = `Mouse${e.button}`;
    if (isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'toggleHideUi'), code)) {
      e.preventDefault();
      setUiHidden(!uiHidden, true);
      return;
    }
    if (mode !== 'playing') return;
    if (isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'quickRestart'), code) && hudUI.isPvpRematchOpen()) {
      e.preventDefault();
      hudUI.triggerPvpRematch();
      return;
    }
    if (isBoundToAction(settings.get().keybindings, shortcutAction(settings.get(), 'quickRestart'), code) && canQuickRestart()) {
      e.preventDefault();
      restartCurrentMatch();
    }
  });

  // ---------- Mobile: every screen fits a landscape phone without vertical scrolling ----------
  const autoFit = new AutoFitter(() => platform.isMobile());
  const q = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel);
  const lobbyRoot = q('.lobby-overlay');
  if (lobbyRoot) {
    autoFit.add({
      root: lobbyRoot,
      scroll: () => q('.lobby-card', lobbyRoot),
      targets: () => Array.from(lobbyRoot.querySelectorAll<HTMLElement>('.lobby-card > :not(.lobby-header)')),
      minZoom: 0.55,
    });
  }
  const settingsRoot = q('.settings-backdrop');
  if (settingsRoot) {
    autoFit.add({
      root: settingsRoot,
      scroll: () => q('.settings-body', settingsRoot),
      targets: () => Array.from(settingsRoot.querySelectorAll<HTMLElement>('.settings-body > section')),
      minZoom: 0.6,
    });
  }
  const historyRoot = q('.history-backdrop');
  if (historyRoot) {
    autoFit.add({
      root: historyRoot,
      scroll: () => q('.history-body', historyRoot),
      targets: () => Array.from(historyRoot.querySelectorAll<HTMLElement>('.history-body > *')),
      minZoom: 0.6,
    });
  }
  const mapPoolRoot = q('.mappool-backdrop');
  if (mapPoolRoot) {
    autoFit.add({
      root: mapPoolRoot,
      scroll: () => q('.mappool-card', mapPoolRoot),
      targets: () => Array.from(mapPoolRoot.querySelectorAll<HTMLElement>('.mappool-card')),
      minZoom: 0.55,
    });
  }
  const resultRoot = q('.result-overlay');
  if (resultRoot) {
    autoFit.add({
      root: resultRoot,
      scroll: () => q('.result-card', resultRoot),
      targets: () => Array.from(resultRoot.querySelectorAll<HTMLElement>('.result-card')),
      minZoom: 0.5,
    });
  }
  platform.onChange(() => autoFit.schedule());

  // Load initial 3D island preview behind the lobby
  const firstMap = lobbyUI.getSelectedMap();
  await renderer.loadPreviewMap(parseQuickPreviewMap(firstMap), firstMap.theme);

  // Start high-refresh render loop!
  startRenderLoop();
}

void bootstrap();
