import './style.css';
import { SoundFX } from './audio/sfx';
import { HumanInputController } from './game/humanInput';
import { LeaderboardStore } from './game/leaderboard';
import { MatchController } from './game/matchController';
import { CellType, EngineMapData, MapMeta, MatchConfig, RosterEntry } from './game/types';
import { GameRenderer } from './render/renderer';
import { HudUI } from './ui/hudUI';
import { LobbyUI, makeHoodieAvatarDataUrl } from './ui/lobbyUI';

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
    fetch('/assets/maps/manifest.json'),
    fetch('/assets/chars/roster.json'),
  ]);
  const maps = (await mapsResp.json()) as MapMeta[];
  const roster = (await rosterResp.json()) as RosterEntry[];

  const sfx = new SoundFX();
  const input = new HumanInputController(canvas);
  const renderer = new GameRenderer(canvas, sfx);
  const leaderboard = new LeaderboardStore(roster, makeHoodieAvatarDataUrl('#3B78F0', '#262A33'));

  let mode: 'lobby' | 'playing' = 'lobby';
  let activeConfig: MatchConfig | null = null;
  let activeMapData: EngineMapData | null = null;
  let matchOverTimer: number | null = null;
  let matchRecorded = false;
  let restarting = false;

  // Default to 240Hz+ uncapped smooth render loop (toggleable to VSync in HUD anytime)
  let uncappedRender = true;
  let rafId = 0;
  let uncapChannel: MessageChannel | null = null;
  let uncapRunning = false;
  let lastUncapRenderMs = 0;
  let lastTelemetryUpdateMs = 0;

  let lobbyUI: LobbyUI;
  let hudUI: HudUI;
  let controller: MatchController;

  const clearMatchOverTimer = () => {
    if (matchOverTimer !== null) {
      window.clearTimeout(matchOverTimer);
      matchOverTimer = null;
    }
  };

  const returnToLobby = (tab: 'play' | 'leaderboard' = 'play') => {
    clearMatchOverTimer();
    restarting = false;
    controller.stop();
    input.setEnabled(false);
    hudUI.hide();
    mode = 'lobby';
    activeConfig = null;
    activeMapData = null;
    lobbyUI.show(tab);
    const m = lobbyUI.getSelectedMap();
    void renderer.loadPreviewMap(parseQuickPreviewMap(m), m.theme);
  };

  const canQuickRestart = (): boolean => {
    if (mode !== 'playing' || !activeConfig || restarting) return false;
    const hSeat = controller.getHumanSeat();
    // Pure AI spectator match
    if (hSeat < 0) return true;
    // Human match: only allowed once human is eliminated (spectating)
    const st = controller.getCurrentState();
    if (!st) return false;
    const me = st.players[hSeat];
    return !!me && !me.alive;
  };

  const restartCurrentMatch = () => {
    if (!activeConfig || restarting) return;
    restarting = true;
    clearMatchOverTimer();

    // If an eliminated human restarts before the remaining bots finish, settle human's Elo by current rank!
    if (!matchRecorded) {
      const hSeat = controller.getHumanSeat();
      const st = controller.getCurrentState();
      if (hSeat >= 0 && st && st.players[hSeat] && !st.players[hSeat].alive) {
        matchRecorded = true;
        const eloResult = leaderboard.recordHumanEarlyExit(activeConfig, st);
        if (eloResult) {
          hudUI.showEloToast(st.players[hSeat].rank, eloResult);
        }
      }
    }

    hudUI.cancelResultOverlay(true);
    matchRecorded = false;
    const cfg: MatchConfig = {
      ...activeConfig,
      slots: activeConfig.slots.map((s) => ({ ...s })),
      cliffGuard: input.isCliffGuard(),
    };
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
      }
    };

    if (!uncappedRender) {
      const loop = () => {
        tickRender();
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    } else {
      // Uncapped 240Hz+ high-frequency render loop (hybrid setTimeout + MessageChannel avoids busy-spinning 100% CPU!)
      uncapRunning = true;
      uncapChannel = new MessageChannel();
      lastUncapRenderMs = performance.now();
      const targetIntervalMs = 1000 / 260; // 260 Hz target (> 240 Hz!)
      const step = () => {
        if (!uncapRunning) return;
        const now = performance.now();
        const rem = targetIntervalMs - (now - lastUncapRenderMs);
        if (rem <= 0.25) {
          lastUncapRenderMs = now;
          tickRender();
          window.setTimeout(() => uncapChannel?.port2.postMessage(null), 1);
        } else if (rem > 1.5) {
          window.setTimeout(() => uncapChannel?.port2.postMessage(null), 1);
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

  hudUI = new HudUI(uiRoot, {
    onReturnToLobby: returnToLobby,
    onRestartMatch: restartCurrentMatch,
    onToggleMute: () => {
      sfx.muted = !sfx.muted;
      return sfx.muted;
    },
    onToggleUncap: () => {
      uncappedRender = !uncappedRender;
      startRenderLoop();
      return uncappedRender;
    },
    onToggleCliffGuard: () => {
      const next = !input.isCliffGuard();
      input.setCliffGuard(next);
      lobbyUI.setCliffGuard(next);
      return next;
    },
  });
  renderer.setNameplateLayer(hudUI.nameplateLayer);

  controller = new MatchController(input, {
    onStatus: (msg) => {
      if (mode === 'lobby') lobbyUI.setLoading(msg);
    },
    onCountdown: (stage) => {
      hudUI.setCountdown(stage);
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
      let eloResult = null;
      if (activeConfig && !matchRecorded) {
        matchRecorded = true;
        eloResult = leaderboard.recordMatch(activeConfig, finalState);
      }
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

  lobbyUI = new LobbyUI(uiRoot, maps, roster, leaderboard, {
    onSelectMap: (map) => {
      if (mode === 'lobby') {
        void renderer.loadPreviewMap(parseQuickPreviewMap(map), map.theme);
      }
    },
    onStartMatch: (config) => {
      clearMatchOverTimer();
      matchRecorded = false;
      restarting = false;
      activeConfig = config;
      lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
      void controller.start(config).catch((err) => {
        console.error(err);
        lobbyUI.setLoading(null);
        alert(`启动失败：${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });

  // Disable native browser right-click context menu everywhere inside the page
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  // Match keyboard shortcuts: ESC returns to lobby; R restarts with exact same config & spawn positions when spectating
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && mode === 'playing') {
      returnToLobby();
      return;
    }
    if (
      e.code === 'KeyR' &&
      !e.repeat &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) &&
      canQuickRestart()
    ) {
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
