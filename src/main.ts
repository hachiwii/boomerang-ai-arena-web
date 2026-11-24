import './style.css';
import { BgmManager, generateBgmSeed } from './audio/bgm';
import { SoundFX } from './audio/sfx';
import { CricketStore } from './game/cricketStore';
import { HumanInputController } from './game/humanInput';
import { CinematicDirector } from './game/killCamDirector';
import { EloUpdateResult, LeaderboardStore } from './game/leaderboard';
import { CountdownStage, MatchController } from './game/matchController';
import { exportReplayClipToGif, triggerGifDownload } from './game/gifExporter';
import { buildMatchHistoryBundle, MatchHistoryStore, MatchReplayBundle } from './game/matchHistory';
import { exportReplayToMp4, triggerMp4Download } from './game/mp4Exporter';
import { ReplayController } from './game/replayController';
import {
  formatPrimaryBind,
  getCinematicOptions,
  getSlashJudgmentTicks,
  GraphicsQualityOption,
  isBoundToAction,
  matchesActionKeyEvent,
  SettingsStore,
} from './game/settings';
import { CellType, EngineMapData, isRankedMatchMode, MapMeta, MatchConfig, RankedMode, RosterEntry } from './game/types';
import { GameRenderer } from './render/renderer';
import { HistoryModal } from './ui/historyUI';
import { HudUI } from './ui/hudUI';
import { LobbyUI, makeHoodieAvatarDataUrl } from './ui/lobbyUI';
import { SettingsModal } from './ui/settingsUI';

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
  const roster = (await rosterResp.json()) as RosterEntry[];

  const settings = new SettingsStore();
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
  const renderer = new GameRenderer(canvas, sfx, undefined, undefined, settings.get().graphicsQuality);
  input.setAimProjector((cx, cy) => renderer.projectClientToWorldMm(cx, cy));
  const leaderboard = new LeaderboardStore(roster, makeHoodieAvatarDataUrl('#3B78F0', '#262A33'));
  const cricketStore = new CricketStore(maps, roster);
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
  let rafId = 0;
  let uncapChannel: MessageChannel | null = null;
  let uncapRunning = false;
  let lastTelemetryUpdateMs = 0;

  let lobbyUI: LobbyUI;
  let hudUI: HudUI;
  let controller: MatchController;
  let replayController: ReplayController;
  let historyModal: HistoryModal;

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
    if (settingsModal.isOpen()) return;
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

  const settingsModal = new SettingsModal(settings, {
    onOpenChange: (open) => {
      input.setPaused(open);
      renderer.setCursorSuppressed(open);
      if (mode === 'playing') {
        controller.setPaused(open);
        renderer.setPlaybackPaused(open);
        if (open) pauseMatchOverTimer();
        else resumeMatchOverTimer();
      } else if (mode === 'replay') {
        replayController.setExternalPaused(open);
      }
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
      const keyLabel = formatPrimaryBind(settings.get().keybindings.toggleHideUi, 'Shift+F');
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

  const enqueueHistorySave = (bundle: MatchReplayBundle) => {
    const p = matchHistory.saveBundle(bundle).catch((err) => {
      console.error('Failed to save match history bundle:', err);
    });
    pendingHistorySave = p;
    void p.finally(() => {
      if (pendingHistorySave === p) pendingHistorySave = null;
    });
  };

  const persistCurrentMatchHistory = (eloResult: EloUpdateResult | null, earlyExit: boolean) => {
    if (historyRecorded || !activeConfig || !activeMapData) return;
    const ticks = controller.getRecordedTicks().slice();
    if (ticks.length === 0) return;
    historyRecorded = true;
    const bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, eloResult, earlyExit);
    lastFinishedBundle = bundle;
    enqueueHistorySave(bundle);
  };

  const returnToLobby = (opts?: { openLeaderboard?: boolean; openHistory?: boolean; rankedMode?: RankedMode }) => {
    setUiHidden(false);
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    controller.stop();
    replayController.stop();
    input.setEnabled(false);
    hudUI.hide();
    mode = 'lobby';
    activeConfig = null;
    activeMapData = null;
    replayMapData = null;
    lastFinishedBundle = null;
    bgm.enterLobby();
    lobbyUI.show(opts?.openLeaderboard ? 'ranked' : undefined, opts);
    const m = lobbyUI.getSelectedMap();
    void renderer.loadPreviewMap(parseQuickPreviewMap(m), m.theme);
    if (opts?.openHistory) {
      void historyModal.open();
    }
  };

  const startCustomAiSpectator = (cfg: MatchConfig): Promise<void> => {
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    controller.stop();
    replayController.stop();
    renderer.resetCameraToOverview();
    input.setEnabled(false);
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

  const startReplayBundle = async (bundle: MatchReplayBundle, fallbackOpenHistory = false) => {
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    pendingMatchElo = null;
    resultOverlayShown = false;
    restarting = false;
    replayIsLiveAi = false;
    controller.stop();
    replayController.stop();
    renderer.resetCameraToOverview();
    input.setEnabled(false);
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
    try {
      await replayController.start(bundle, 1.0, getCinematicOptions(settings.get()), true);
    } catch (err) {
      console.error('Failed to start replay:', err);
      alert(`回放加载失败：${err instanceof Error ? err.message : String(err)}`);
      returnToLobby(fallbackOpenHistory ? { openHistory: true } : undefined);
    }
  };

  const startReplayById = async (matchId: string) => {
    const bundle = await matchHistory.getReplayBundle(matchId);
    if (!bundle) {
      alert('未找到该场对局的回放数据（可能已被清理）。');
      return;
    }
    await startReplayBundle(bundle, true);
  };

  const canQuickRestart = (): boolean => {
    if (!activeConfig || restarting) return false;
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
    if (!activeConfig || restarting) return;
    restarting = true;
    clearMatchOverTimer();

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
      // Custom R restart: exact same map, contestants, spawn order, gameplay seed, and speed;
      // re-roll independent bgmSeed so special BGM rolls freshly on each restart.
      const s = settings.get();
      cfg = {
        ...activeConfig,
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
      renderer.renderFrame(input);
      const now = performance.now();
      if (mode === 'playing' && now - lastTelemetryUpdateMs >= 200) {
        lastTelemetryUpdateMs = now;
        hudUI.updateTelemetry(
          controller.actualLogicHz,
          renderer.renderHz,
          renderer.avgFrameWorkMs,
          controller.lastBotMaxMs,
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
    controller.setCliffGuard(s.cliffGuard);
    controller.setDashGuard(s.dashGuard);
    controller.setMeleeAssist(s.meleeAssist);
    controller.setHumanSlashTicks(getSlashJudgmentTicks(s.slashJudgment));
    if (s.lockFps !== activeLockFps) {
      activeLockFps = s.lockFps;
      startRenderLoop();
    }
    if (s.graphicsQuality !== activeGraphicsQuality) {
      activeGraphicsQuality = s.graphicsQuality;
      renderer.setGraphicsQuality(s.graphicsQuality);
    }
    const cinematic = getCinematicOptions(s);
    if (mode === 'replay') {
      replayController.setCinematicOptions(cinematic);
    } else if (mode === 'playing') {
      const updatedDir = controller.setCinematicOptions(cinematic);
      if (updatedDir) {
        renderer.setCinematicDirector(updatedDir);
        renderer.setPlaybackSpeed(activeConfig?.speed ?? 1.0);
      } else {
        const curSt = controller.getCurrentState();
        if (curSt?.over && activeMapData) {
          renderer.setCinematicDirector(
            CinematicDirector.createWinnerCloseupOnly(curSt, activeMapData, s.winnerCam),
          );
        }
      }
    }
  });

  hudUI = new HudUI(uiRoot, settings, {
    onReturnToLobby: returnToLobby,
    onRestartMatch: restartCurrentMatch,
    onWatchCurrentReplay: () => {
      let bundle = lastFinishedBundle;
      if (!bundle && activeConfig && activeMapData) {
        const ticks = controller.getRecordedTicks().slice();
        if (ticks.length > 0) {
          bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, null, false);
        }
      }
      if (!bundle) return;
      void startReplayBundle(bundle, false);
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
    onReplaySeek: (tickIdx) => {
      replayController.seekTo(tickIdx);
    },
    onReplaySpeed: (spd) => {
      replayController.setSpeed(spd);
    },
    onReplayToggleFavorite: (bundle, nextFavorite) => {
      bundle.summary.favorite = nextFavorite;
      const task = favoriteWriteQueue.then(async () => {
        if (pendingHistorySave) {
          await pendingHistorySave;
        }
        const updated = await matchHistory.setFavorite(bundle.summary.id, nextFavorite);
        if (!updated && !replayController.getState().computing && bundle.replay.ticks.length > 0) {
          await matchHistory.saveBundle(bundle);
        }
      });
      favoriteWriteQueue = task.catch(() => undefined);
      return task;
    },
    onReplayExportMp4: async (bundle, signal, onProgress) => {
      const s = settings.get();
      const result = await exportReplayToMp4(bundle, {
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
        cinematic: getCinematicOptions(s),
        sharedCharModelCache: renderer.getCharModelCache(),
        signal,
        onProgress,
      });
      triggerMp4Download(result.blob, result.filename);
      return result;
    },
    onReplayExportGif: async (bundle, endTickIndex, signal, onProgress) => {
      const s = settings.get();
      const frozenBundle: MatchReplayBundle = {
        ...bundle,
        replay: { ...bundle.replay, ticks: bundle.replay.ticks.slice() },
      };
      const result = await exportReplayClipToGif(frozenBundle, {
        endTickIndex,
        maxDurationSec: 10.0,
        graphicsQuality: s.graphicsQuality,
        cinematic: getCinematicOptions(s),
        sharedCharModelCache: renderer.getCharModelCache(),
        signal,
        onProgress,
      });
      triggerGifDownload(result.blob, result.filename);
      return result;
    },
  });
  renderer.setNameplateLayer(hudUI.nameplateLayer);

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
      hudUI.showReplay(bundle, state, { liveAiSpectator: replayIsLiveAi });
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
      const s = settings.get();
      const result = await exportReplayToMp4(bundle, {
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
        cinematic: getCinematicOptions(s),
        sharedCharModelCache: renderer.getCharModelCache(),
        signal,
        onProgress,
      });
      triggerMp4Download(result.blob, result.filename);
      return result;
    },
    onOpenSettings: () => {
      settingsModal.open();
    },
  });

  controller = new MatchController(input, {
    onStatus: (msg) => {
      if (mode === 'lobby') lobbyUI.setLoading(msg);
    },
    onCountdown: handleCountdown,
    onMapLoaded: async (mapData, initialState, director) => {
      if (!activeConfig) return;
      activeMapData = mapData;
      const cfg = activeConfig;
      const hSeat = controller.getHumanSeat();
      await renderer.setupMatch(mapData, cfg.mapMeta.theme, cfg.slots, initialState, hSeat, cfg.speed);
      if (activeConfig !== cfg) return;
      renderer.setCinematicDirector(director ?? null);
      mode = 'playing';
      lobbyUI.hide();
      bgm.beginMatch({ matchMode: cfg.matchMode, bgmSeed: cfg.bgmSeed ?? cfg.seed, slots: cfg.slots }, initialState);
      hudUI.showMatch(cfg, hSeat);
      hudUI.updateTick(initialState, mapData.colStart, mapData.colEvery);
    },
    onTick: (prev, next, tickDurationMs) => {
      renderer.pushTick(prev, next, tickDurationMs);
      bgm.updateMatchTick(next);
      hudUI.updateTick(next, activeMapData?.colStart, activeMapData?.colEvery);
    },
    onMatchOver: (finalState, director) => {
      bgm.updateMatchTick(finalState);
      hudUI.updateTick(finalState, activeMapData?.colStart, activeMapData?.colEvery);
      let eloResult: EloUpdateResult | null = null;
      if (activeConfig && !matchRecorded) {
        matchRecorded = true;
        eloResult = leaderboard.recordMatch(activeConfig, finalState);
        if (eloResult) {
          const hSeat = controller.getHumanSeat();
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
      persistCurrentMatchHistory(eloResult, false);
      // Live human matches (and live AI matches with only winnerCam) glide smoothly to the winner front close-up!
      let activeDirector = director ?? null;
      if (!activeDirector && activeMapData && settings.get().winnerCam) {
        activeDirector = CinematicDirector.createWinnerCloseupOnly(finalState, activeMapData, true);
        if (activeDirector) {
          renderer.setCinematicDirector(activeDirector);
        }
      }

      // Wait for victory celebration at 1.0x (post-match playback smoothly transitions to 1.0x regardless of gameSpeed)
      const celebrateMs =
        activeDirector && activeDirector.isEnabled()
          ? Math.round(activeDirector.getRecommendedOutroRealSec(1.6) * 1000)
          : 1600;
      scheduleMatchOverTimer(celebrateMs, () => {
        if (mode === 'playing') {
          resultOverlayShown = true;
          pendingMatchElo = null;
          hudUI.showMatchResult(finalState, eloResult);
        }
      });
    },
    onError: (err) => {
      console.error('Match error:', err);
      lobbyUI.setLoading(null);
      alert(`对局启动出错：${err}`);
      returnToLobby();
    },
  });

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

      clearMatchOverTimer();
      matchRecorded = false;
      historyRecorded = false;
      pendingMatchElo = null;
      resultOverlayShown = false;
      restarting = false;
      replayIsLiveAi = false;
      lastFinishedBundle = null;
      replayController.stop();
      renderer.resetCameraToOverview();
      historyModal.close();
      activeConfig = config;
      bgm.prepareMatchLaunch({
        matchMode: config.matchMode,
        bgmSeed: config.bgmSeed ?? config.seed,
        slots: config.slots,
      });
      lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
      void controller.start(config, { cinematic: getCinematicOptions(settings.get()) }).catch((err) => {
        console.error(err);
        lobbyUI.setLoading(null);
        alert(`启动失败：${err instanceof Error ? err.message : String(err)}`);
      });
    },
    onOpenHistory: () => {
      void historyModal.open();
    },
    onOpenSettings: () => {
      settingsModal.open();
    },
  });

  // Disable native browser right-click context menu everywhere inside the page
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Match & Replay keyboard/mouse shortcuts
  window.addEventListener('keydown', (e) => {
    if (settingsModal.isOpen() || historyModal.isOpen()) return;
    if (!e.repeat && !isTextEditableTarget(e.target) && matchesActionKeyEvent(settings.get().keybindings, 'toggleHideUi', e)) {
      e.preventDefault();
      setUiHidden(!uiHidden, true);
      return;
    }
    if (e.code === 'Escape') {
      if (mode === 'playing' || mode === 'replay') {
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
        isBoundToAction(settings.get().keybindings, 'quickRestart', e.code) &&
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
      isBoundToAction(settings.get().keybindings, 'quickRestart', e.code) &&
      canQuickRestart()
    ) {
      e.preventDefault();
      restartCurrentMatch();
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (settingsModal.isOpen() || historyModal.isOpen()) return;
    const code = `Mouse${e.button}`;
    if (isBoundToAction(settings.get().keybindings, 'toggleHideUi', code)) {
      e.preventDefault();
      setUiHidden(!uiHidden, true);
      return;
    }
    if (mode !== 'playing') return;
    if (isBoundToAction(settings.get().keybindings, 'quickRestart', code) && canQuickRestart()) {
      e.preventDefault();
      restartCurrentMatch();
    }
  });

  // Load initial 3D island preview behind the lobby
  const firstMap = lobbyUI.getSelectedMap();
  await renderer.loadPreviewMap(parseQuickPreviewMap(firstMap), firstMap.theme);

  // Start high-refresh render loop!
  startRenderLoop();
}

void bootstrap();
