import './style.css';
import { SoundFX } from './audio/sfx';
import { HumanInputController } from './game/humanInput';
import { EloUpdateResult, LeaderboardStore } from './game/leaderboard';
import { MatchController } from './game/matchController';
import { buildMatchHistoryBundle, MatchHistoryStore } from './game/matchHistory';
import { ReplayController } from './game/replayController';
import { FpsCapOption, isBoundToAction, SettingsStore } from './game/settings';
import { CellType, EngineMapData, MapMeta, MatchConfig, RankedMode, RosterEntry } from './game/types';
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

  const input = new HumanInputController(canvas, settings);
  const renderer = new GameRenderer(canvas, sfx);
  input.setAimProjector((cx, cy) => renderer.projectClientToWorldMm(cx, cy));
  const leaderboard = new LeaderboardStore(roster, makeHoodieAvatarDataUrl('#3B78F0', '#262A33'));
  const matchHistory = new MatchHistoryStore();

  let mode: 'lobby' | 'playing' | 'replay' = 'lobby';
  let activeConfig: MatchConfig | null = null;
  let activeMapData: EngineMapData | null = null;
  let replayMapData: EngineMapData | null = null;
  let matchOverTimer: number | null = null;
  let matchRecorded = false;
  let historyRecorded = false;
  let restarting = false;

  // Frame-rate cap driven directly by SettingsStore ('vsync' | 60..360 | 'uncapped')
  let activeFpsCap: FpsCapOption = settings.get().fpsCap;
  let rafId = 0;
  let uncapChannel: MessageChannel | null = null;
  let uncapRunning = false;
  let lastUncapRenderMs = 0;
  let lastTelemetryUpdateMs = 0;

  let lobbyUI: LobbyUI;
  let hudUI: HudUI;
  let controller: MatchController;
  let replayController: ReplayController;
  let historyModal: HistoryModal;

  const settingsModal = new SettingsModal(settings, {
    onOpenChange: (open) => {
      input.setPaused(open);
      renderer.setCursorSuppressed(open);
    },
    onTestSound: () => {
      sfx.playCatch();
    },
  });

  const clearMatchOverTimer = () => {
    if (matchOverTimer !== null) {
      window.clearTimeout(matchOverTimer);
      matchOverTimer = null;
    }
  };

  const persistCurrentMatchHistory = (eloResult: EloUpdateResult | null, earlyExit: boolean) => {
    if (historyRecorded || !activeConfig || !activeMapData) return;
    const ticks = controller.getRecordedTicks().slice();
    if (ticks.length === 0) return;
    historyRecorded = true;
    const bundle = buildMatchHistoryBundle(activeConfig, activeMapData, ticks, eloResult, earlyExit);
    void matchHistory.saveBundle(bundle);
  };

  const returnToLobby = (opts?: { openLeaderboard?: boolean; openHistory?: boolean; rankedMode?: RankedMode }) => {
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    restarting = false;
    controller.stop();
    replayController.stop();
    input.setEnabled(false);
    hudUI.hide();
    mode = 'lobby';
    activeConfig = null;
    activeMapData = null;
    replayMapData = null;
    lobbyUI.show(opts?.openLeaderboard ? 'ranked' : undefined, opts);
    const m = lobbyUI.getSelectedMap();
    void renderer.loadPreviewMap(parseQuickPreviewMap(m), m.theme);
    if (opts?.openHistory) {
      void historyModal.open();
    }
  };

  const startReplayById = async (matchId: string) => {
    const bundle = await matchHistory.getReplayBundle(matchId);
    if (!bundle) {
      alert('未找到该场对局的回放数据（可能已被清理）。');
      return;
    }
    clearMatchOverTimer();
    matchRecorded = false;
    historyRecorded = false;
    restarting = false;
    controller.stop();
    replayController.stop();
    input.setEnabled(false);
    activeConfig = null;
    activeMapData = null;
    replayMapData = bundle.replay.mapData;
    historyModal.close();
    lobbyUI.hide();
    mode = 'replay';
    try {
      await replayController.start(bundle, 1.0);
    } catch (err) {
      console.error('Failed to start replay:', err);
      alert(`回放加载失败：${err instanceof Error ? err.message : String(err)}`);
      returnToLobby({ openHistory: true });
    }
  };

  const canQuickRestart = (): boolean => {
    if (mode !== 'playing' || !activeConfig || restarting) return false;
    const hSeat = controller.getHumanSeat();
    // Pure AI spectator match
    if (hSeat < 0) return true;
    const st = controller.getCurrentState();
    if (!st) return false;
    // Once a ranked match is finished (result screen), R can also launch New Match
    if (st.over && activeConfig.matchMode !== 'custom') return true;
    // During live match, only allowed once human is eliminated (spectating)
    const me = st.players[hSeat];
    return !!me && !me.alive;
  };

  const restartCurrentMatch = () => {
    if (!activeConfig || restarting) return;
    restarting = true;
    clearMatchOverTimer();

    // If an eliminated human restarts before remaining bots finish, settle Ranked Elo by current rank first!
    if (!matchRecorded) {
      const hSeat = controller.getHumanSeat();
      const st = controller.getCurrentState();
      if (hSeat >= 0 && st && st.players[hSeat] && !st.players[hSeat].alive) {
        matchRecorded = true;
        const eloResult = leaderboard.recordHumanEarlyExit(activeConfig, st);
        if (eloResult) {
          hudUI.showEloToast(st.players[hSeat].rank, eloResult);
          persistCurrentMatchHistory(eloResult, true);
        }
      }
    }

    const isRanked = activeConfig.matchMode !== 'custom';
    hudUI.cancelResultOverlay(true, isRanked);
    matchRecorded = false;
    historyRecorded = false;
    lobbyUI.setCliffGuard(input.isCliffGuard());

    let cfg: MatchConfig;
    if (isRanked) {
      // Ranked R restart: re-matchmake using the NEW updated Elo score (fresh map + fresh opponents!)
      const rankedMode: RankedMode = activeConfig.matchMode === 'ranked-solo' ? 'solo' : 'ffa';
      const prevBotIds = activeConfig.slots
        .filter((s) => s.kind === 'bot' && Boolean(s.botId))
        .map((s) => s.botId!);
      cfg = lobbyUI.createRankedMatchConfig(rankedMode, prevBotIds);
    } else {
      // Custom R restart: exact same map, contestants, spawn order, seed, and speed
      cfg = {
        ...activeConfig,
        slots: activeConfig.slots.map((s) => ({ ...s })),
        cliffGuard: input.isCliffGuard(),
      };
    }

    activeConfig = cfg;
    void controller
      .start(cfg)
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
        hudUI.updateReplayTelemetry(renderer.renderHz, renderer.avgFrameWorkMs, rs.speed, rs.paused);
      }
    };

    if (activeFpsCap === 'vsync') {
      const loop = () => {
        tickRender();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      // Custom FPS cap or 240Hz+ uncapped pacer (hybrid setTimeout + MessageChannel avoids busy-spinning 100% CPU!)
      const targetHz = activeFpsCap === 'uncapped' ? 260 : activeFpsCap;
      uncapRunning = true;
      uncapChannel = new MessageChannel();
      lastUncapRenderMs = performance.now();
      const targetIntervalMs = 1000 / targetHz;
      const step = () => {
        if (!uncapRunning) return;
        const now = performance.now();
        const rem = targetIntervalMs - (now - lastUncapRenderMs);
        if (rem <= 0.25) {
          lastUncapRenderMs = now;
          tickRender();
          const sleepMs = Math.max(1, Math.floor(targetIntervalMs - 2));
          window.setTimeout(() => uncapChannel?.port2.postMessage(null), sleepMs);
        } else if (rem > 2.0) {
          window.setTimeout(() => uncapChannel?.port2.postMessage(null), Math.max(1, Math.floor(rem - 1.5)));
        } else {
          uncapChannel?.port2.postMessage(null);
        }
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
    if (s.fpsCap !== activeFpsCap) {
      activeFpsCap = s.fpsCap;
      startRenderLoop();
    }
  });

  hudUI = new HudUI(uiRoot, settings, {
    onReturnToLobby: returnToLobby,
    onRestartMatch: restartCurrentMatch,
    onOpenSettings: () => {
      settingsModal.open();
    },
    onToggleCliffGuard: () => {
      const next = !input.isCliffGuard();
      controller.setCliffGuard(next);
      lobbyUI.setCliffGuard(next);
      return next;
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
  });
  renderer.setNameplateLayer(hudUI.nameplateLayer);

  replayController = new ReplayController(renderer, {
    onLoaded: (bundle, state) => {
      hudUI.showReplay(bundle, state);
      hudUI.updateTick(
        bundle.replay.ticks[0],
        bundle.replay.mapData.colStart,
        bundle.replay.mapData.colEvery,
      );
    },
    onTick: (snapshot, state) => {
      hudUI.updateTick(snapshot, replayMapData?.colStart, replayMapData?.colEvery);
      hudUI.updateReplayControls(state);
    },
    onStateChange: (state) => {
      hudUI.updateReplayControls(state);
    },
  });

  historyModal = new HistoryModal(matchHistory, {
    onReplay: startReplayById,
  });

  controller = new MatchController(input, {
    onStatus: (msg) => {
      if (mode === 'lobby') lobbyUI.setLoading(msg);
    },
    onCountdown: (stage) => {
      hudUI.setCountdown(stage);
      renderer.setCountdownStage(stage);
      if (stage === 3 || stage === 2 || stage === 1) {
        sfx.playCountdownTick(stage);
      } else if (stage === 'GO') {
        sfx.playCountdownGo();
      }
    },
    onMapLoaded: async (mapData, initialState) => {
      if (!activeConfig) return;
      activeMapData = mapData;
      const cfg = activeConfig;
      const hSeat = controller.getHumanSeat();
      await renderer.setupMatch(mapData, cfg.mapMeta.theme, cfg.slots, initialState, hSeat, cfg.speed);
      if (activeConfig !== cfg) return;
      mode = 'playing';
      lobbyUI.hide();
      hudUI.showMatch(cfg, hSeat);
      hudUI.updateTick(initialState, mapData.colStart, mapData.colEvery);
    },
    onTick: (prev, next) => {
      renderer.pushTick(prev, next);
      hudUI.updateTick(next, activeMapData?.colStart, activeMapData?.colEvery);
    },
    onMatchOver: (finalState) => {
      hudUI.updateTick(finalState, activeMapData?.colStart, activeMapData?.colEvery);
      let eloResult: EloUpdateResult | null = null;
      if (activeConfig && !matchRecorded) {
        matchRecorded = true;
        eloResult = leaderboard.recordMatch(activeConfig, finalState);
      }
      persistCurrentMatchHistory(eloResult, false);
      // Wait 1.6s so players see the victory celebration & confetti, then show result card + auto return!
      clearMatchOverTimer();
      matchOverTimer = window.setTimeout(() => {
        matchOverTimer = null;
        if (mode === 'playing') {
          hudUI.showMatchResult(finalState, eloResult);
        }
      }, 1600);
    },
    onError: (err) => {
      console.error('Match error:', err);
      lobbyUI.setLoading(null);
      alert(`对局启动出错：${err}`);
      returnToLobby();
    },
  });

  lobbyUI = new LobbyUI(uiRoot, maps, roster, leaderboard, settings, {
    onSelectMap: (map) => {
      if (mode === 'lobby') {
        void renderer.loadPreviewMap(parseQuickPreviewMap(map), map.theme);
      }
    },
    onStartMatch: (config) => {
      clearMatchOverTimer();
      matchRecorded = false;
      historyRecorded = false;
      restarting = false;
      replayController.stop();
      historyModal.close();
      activeConfig = config;
      lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
      void controller.start(config).catch((err) => {
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
    if (e.code === 'Escape' && (mode === 'playing' || mode === 'replay')) {
      returnToLobby();
      return;
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
      return;
    }
    if (
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) &&
      isBoundToAction(settings.get().keybindings, 'quickRestart', e.code) &&
      canQuickRestart()
    ) {
      e.preventDefault();
      restartCurrentMatch();
    }
  });

  window.addEventListener('mousedown', (e) => {
    if (settingsModal.isOpen() || historyModal.isOpen() || mode !== 'playing') return;
    const code = `Mouse${e.button}`;
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
