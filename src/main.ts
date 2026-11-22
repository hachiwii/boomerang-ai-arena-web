import './style.css';
import { SoundFX } from './audio/sfx';
import { HumanInputController } from './game/humanInput';
import { MatchController } from './game/matchController';
import { CellType, EngineMapData, MapMeta, MatchConfig, RosterEntry } from './game/types';
import { GameRenderer } from './render/renderer';
import { HudUI } from './ui/hudUI';
import { LobbyUI } from './ui/lobbyUI';

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

  let mode: 'lobby' | 'playing' = 'lobby';
  let activeConfig: MatchConfig | null = null;
  let activeMapData: EngineMapData | null = null;

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

  const returnToLobby = () => {
    controller.stop();
    input.setEnabled(false);
    hudUI.hide();
    mode = 'lobby';
    activeConfig = null;
    activeMapData = null;
    lobbyUI.show();
    const m = lobbyUI.getSelectedMap();
    void renderer.loadPreviewMap(parseQuickPreviewMap(m), m.theme);
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
    onToggleMute: () => {
      sfx.muted = !sfx.muted;
      return sfx.muted;
    },
    onToggleUncap: () => {
      uncappedRender = !uncappedRender;
      startRenderLoop();
      return uncappedRender;
    },
  });
  renderer.setNameplateLayer(hudUI.nameplateLayer);

  controller = new MatchController(input, {
    onStatus: (msg) => {
      if (mode === 'lobby') lobbyUI.setLoading(msg);
    },
    onMapLoaded: async (mapData, initialState) => {
      if (!activeConfig) return;
      activeMapData = mapData;
      const cfg = activeConfig;
      const hSeat = controller.getHumanSeat();
      await renderer.setupMatch(mapData, cfg.mapMeta.theme, cfg.slots, initialState, hSeat);
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
      // Wait 1.6s so players see the victory celebration & confetti, then show result card + auto return!
      window.setTimeout(() => {
        if (mode === 'playing') {
          hudUI.showMatchResult(finalState);
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

  lobbyUI = new LobbyUI(uiRoot, maps, roster, {
    onSelectMap: (map) => {
      if (mode === 'lobby') {
        void renderer.loadPreviewMap(parseQuickPreviewMap(map), map.theme);
      }
    },
    onStartMatch: (config) => {
      activeConfig = config;
      lobbyUI.setLoading('初始化 WASM 引擎与 AI...');
      void controller.start(config).catch((err) => {
        console.error(err);
        lobbyUI.setLoading(null);
        alert(`启动失败：${err instanceof Error ? err.message : String(err)}`);
      });
    },
  });

  // ESC returns to main lobby anytime during a match
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && mode === 'playing') {
      returnToLobby();
    }
  });

  // Load initial 3D island preview behind the lobby
  const firstMap = lobbyUI.getSelectedMap();
  await renderer.loadPreviewMap(parseQuickPreviewMap(firstMap), firstMap.theme);

  // Start high-refresh render loop!
  startRenderLoop();
}

void bootstrap();
