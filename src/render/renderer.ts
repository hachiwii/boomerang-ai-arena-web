import * as THREE from 'three';
import { SoundFX } from '../audio/sfx';
import { HumanInputController } from '../game/humanInput';
import { CountdownStage } from '../game/matchController';
import {
  CauseType,
  CellType,
  DState,
  EngineMapData,
  GameEvent,
  LOGIC_DT_MS,
  SlotConfig,
  TickSnapshot,
} from '../game/types';
import { CharacterRig } from './charRig';
import { FXSystem } from './fxSystem';
import { ArenaMap3D } from './mapBuilder';
import { getTheme } from './themes';
import { VoxelModelData } from './voxelBuilder';

const PITCH_RAD = (58 * Math.PI) / 180;
const CAM_FOV = 26;
const RECALL_CURSOR_STEPS = 16;

function buildAimCursorCss(ringHex: string, dotHex: string, dotRadius: number): string {
  const r = Number(dotRadius.toFixed(2));
  const centerSvg =
    r > 3.2
      ? `<circle cx="16" cy="16" r="${r}" fill="${dotHex}" fill-opacity="0.92"/>`
      : `<circle cx="16" cy="16" r="${Number((r + 1.0).toFixed(2))}" fill="#080e1c" fill-opacity="0.72"/><circle cx="16" cy="16" r="${r}" fill="${dotHex}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
    centerSvg +
    `<circle cx="16" cy="16" r="10" fill="none" stroke="#080e1c" stroke-opacity="0.75" stroke-width="3.6"/>` +
    `<circle cx="16" cy="16" r="10" fill="none" stroke="${ringHex}" stroke-width="1.9"/>` +
    `<path d="M16 2.5v4.2M16 25.3v4.2M2.5 16h4.2M25.3 16h4.2" stroke="#080e1c" stroke-opacity="0.78" stroke-width="3.2" stroke-linecap="round"/>` +
    `<path d="M16 2.5v4.2M16 25.3v4.2M2.5 16h4.2M25.3 16h4.2" stroke="${ringHex}" stroke-width="1.7" stroke-linecap="round"/>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, crosshair`;
}

// Precomputed zero-latency OS hardware-plane SVG cursor table:
// - armed:   blue   (holding boomerang)
// - flying:  yellow (boomerang flying out / returning / recalled)
// - dropped: red    (boomerang knocked down / on ground)
// - recall-0..16: red with center dot expanding from r=2.6 to r=9.2 until full -> snaps to flying (yellow)
const AIM_CURSOR_BLUE = buildAimCursorCss('#66b8ff', '#3d7eff', 2.6);
const AIM_CURSOR_YELLOW = buildAimCursorCss('#ffe055', '#ffbe1a', 2.6);
const AIM_CURSOR_RED = buildAimCursorCss('#ff6464', '#ff2a2a', 2.6);
const AIM_CURSOR_RECALL: string[] = Array.from({ length: RECALL_CURSOR_STEPS + 1 }, (_, i) => {
  const prog = i / RECALL_CURSOR_STEPS;
  const r = 2.6 + (9.2 - 2.6) * prog;
  return buildAimCursorCss('#ff6464', '#ff2a2a', r);
});

export interface ProjectedNameplate {
  seat: number;
  x: number;
  y: number;
  visible: boolean;
  opacity: number;
  inGrassStealth: boolean;
}

/**
 * High-refresh-rate (240Hz+ capable) Three.js WebGL2 renderer with smooth
 * 20Hz -> 240Hz+ entity interpolation, dynamic camera framing, sky gradient,
 * screen shake, nameplates, and mouse-to-ground raycasting.
 */
export class GameRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly skyMesh: THREE.Mesh;

  private arena: ArenaMap3D | null = null;
  private rigs: CharacterRig[] = [];
  private fx: FXSystem | null = null;
  private countdownArrow: THREE.Group | null = null;
  private countdownStage: CountdownStage = null;
  private countdownPulseMs = 0;
  private countdownGoMs = 0;
  private slots: SlotConfig[] = [];
  private humanSeat = -1;

  // Logic tick interpolation state pair
  private prevState: TickSnapshot | null = null;
  private currState: TickSnapshot | null = null;
  private tickReceivedAtMs = 0;
  private tickIntervalMs = LOGIC_DT_MS;
  private gameSpeed = 1.0;
  private playbackPaused = false;
  private pausedAlpha = 1.0;

  // Dynamic camera framing
  private camTargetX = 9;
  private camTargetZ = 6;
  private camDist = 28;
  private shakeAmp = 0;
  private previewMode = true;
  private previewAngle = 0;

  // Raycasting scratch (zero allocation per frame)
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _ndc = new THREE.Vector2();
  // Intersect at y = 0.06 to match the 3D aim-line height with zero parallax offset
  private readonly _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.06);
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _projVec = new THREE.Vector3();
  private cursorSuppressed = false;
  private activeCursorKey = 'default';

  // Floating nameplate DOM elements (positioned via CSS transform3d for 240Hz smoothness!)
  private nameplateLayer: HTMLDivElement | null = null;
  private nameplates: HTMLDivElement[] = [];

  // Render Hz & frame-time telemetry
  public renderHz = 0;
  public avgFrameWorkMs = 0;
  private frameTimes: number[] = [];
  private workMsAccum = 0;
  private workMsSamples = 0;
  private lastFrameMs = performance.now();
  private elapsedSec = 0;

  // Crumbling-gravel audio state for human standing on impending-collapse tiles
  private wasOnWarnTile = false;
  private nextCrumbleAtMs = 0;

  // Voxel JSON cache
  private readonly charModelCache: Map<string, VoxelModelData>;
  private readonly sfx: SoundFX;
  private readonly fixedSize: { width: number; height: number } | null;

  constructor(
    canvas: HTMLCanvasElement,
    sfx: SoundFX,
    fixedSize?: { width: number; height: number },
    sharedCharModelCache?: Map<string, VoxelModelData>,
  ) {
    this.canvas = canvas;
    this.sfx = sfx;
    this.fixedSize = fixedSize ?? null;
    this.charModelCache = sharedCharModelCache ?? new Map<string, VoxelModelData>();

    const initW = this.fixedSize ? this.fixedSize.width : window.innerWidth;
    const initH = this.fixedSize ? this.fixedSize.height : window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(this.fixedSize ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(initW, initH, !this.fixedSize);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.camera = new THREE.PerspectiveCamera(
      CAM_FOV,
      initW / Math.max(1, initH),
      0.5,
      260,
    );

    // Sky gradient dome
    const skyGeo = new THREE.SphereGeometry(140, 20, 12);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color('#6DB6F2') },
        bottomColor: { value: new THREE.Color('#C8E6FF') },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPos;
        void main() {
          float h = clamp((normalize(vWorldPos).y + 0.25) / 0.9, 0.0, 1.0);
          gl_FragColor = vec4(mix(bottomColor, topColor, h), 1.0);
        }
      `,
    });
    this.skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(this.skyMesh);

    this.hemiLight = new THREE.HemisphereLight('#b8d4ff', '#8e78a6', 0.95);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#ffecd0', 1.55);
    this.sunLight.position.set(16, 26, 14);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024); // Lean 1K shadow map keeps GPU < 1ms for 240Hz+
    this.sunLight.shadow.camera.near = 4;
    this.sunLight.shadow.camera.far = 65;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = -0.0012;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    if (!this.fixedSize) {
      window.addEventListener('resize', () => this.handleResize());
    }
  }

  public getCharModelCache(): Map<string, VoxelModelData> {
    return this.charModelCache;
  }

  private getViewportSize(): { width: number; height: number } {
    if (this.fixedSize) return this.fixedSize;
    return { width: window.innerWidth, height: window.innerHeight };
  }

  public setNameplateLayer(el: HTMLDivElement) {
    this.nameplateLayer = el;
  }

  private handleResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    if (this.arena) {
      this.recomputeCameraFit();
    }
  }

  public async loadCharModel(charKey: string): Promise<VoxelModelData> {
    const cached = this.charModelCache.get(charKey);
    if (cached) return cached;
    const resp = await fetch(`/assets/chars/${charKey}.json?v=${__BUILD_ID__}`);
    if (!resp.ok) throw new Error(`Failed to load character model ${charKey}`);
    const data = (await resp.json()) as VoxelModelData;
    this.charModelCache.set(charKey, data);
    return data;
  }

  private applyThemeLighting(themeName: string) {
    const T = getTheme(themeName);
    const skyMat = this.skyMesh.material as THREE.ShaderMaterial;
    skyMat.uniforms.topColor.value.set(T.skyTop);
    skyMat.uniforms.bottomColor.value.set(T.skyBottom);
    this.scene.fog = new THREE.Fog(T.fogColor, 48, 125);
    this.sunLight.color.set(T.sunColor);
    this.sunLight.intensity = T.sunIntensity;
    this.hemiLight.color.set(T.ambientSky);
    this.hemiLight.groundColor.set(T.ambientGround);
    this.hemiLight.intensity = T.ambientIntensity;
  }

  public async loadPreviewMap(mapData: EngineMapData, themeName: string) {
    this.clearMatchObjects();
    this.previewMode = true;
    this.applyThemeLighting(themeName);
    this.arena = new ArenaMap3D(mapData, themeName);
    this.scene.add(this.arena.root);
    this.camTargetX = this.arena.widthM * 0.5;
    this.camTargetZ = this.arena.heightM * 0.5;
    this.recomputeCameraFit();
  }

  public async setupMatch(
    mapData: EngineMapData,
    themeName: string,
    slots: SlotConfig[],
    initialState: TickSnapshot,
    humanSeat: number,
    speed = 1.0,
  ) {
    this.clearMatchObjects();
    this.previewMode = false;
    this.slots = slots;
    this.humanSeat = humanSeat;
    this.gameSpeed = Math.max(0.1, Math.min(2.0, speed || 1.0));
    this.tickIntervalMs = LOGIC_DT_MS / this.gameSpeed;

    this.applyThemeLighting(themeName);
    this.arena = new ArenaMap3D(mapData, themeName);
    this.scene.add(this.arena.root);

    // Position sun centered on arena
    const cx = this.arena.widthM * 0.5;
    const cz = this.arena.heightM * 0.5;
    this.sunLight.position.set(cx + 10, 24, cz + 8);
    this.sunLight.target.position.set(cx, 0, cz);
    this.sunLight.target.updateMatrixWorld();

    const halfSpan = Math.max(this.arena.widthM, this.arena.heightM) * 0.65;
    this.sunLight.shadow.camera.left = -halfSpan;
    this.sunLight.shadow.camera.right = halfSpan;
    this.sunLight.shadow.camera.top = halfSpan;
    this.sunLight.shadow.camera.bottom = -halfSpan;
    this.sunLight.shadow.camera.updateProjectionMatrix();

    // Load voxel character models & construct rigs
    const models = await Promise.all(slots.map((s) => this.loadCharModel(s.charKey)));
    this.rigs = slots.map((slot, idx) => {
      const ringCol = slot.ringAccent || slot.color;
      return new CharacterRig(idx, models[idx], ringCol, slot.kind === 'human', this.scene);
    });

    this.fx = new FXSystem(
      this.scene,
      slots.map((s) => s.ringAccent || s.color),
    );

    // Pre-match countdown red 3D indicator arrow above the human player
    if (humanSeat >= 0) {
      this.countdownArrow = this.buildCountdownArrow();
      this.countdownArrow.visible = false;
      this.scene.add(this.countdownArrow);
    }

    // Build floating nameplates
    this.rebuildNameplates();

    this.prevState = initialState;
    this.currState = initialState;
    this.tickReceivedAtMs = performance.now();
    this.playbackPaused = false;
    this.pausedAlpha = 1.0;
    this.shakeAmp = 0;
    this.wasOnWarnTile = false;
    this.nextCrumbleAtMs = 0;

    this.camTargetX = cx;
    this.camTargetZ = cz;
    this.recomputeCameraFit();
  }

  public setCountdownStage(stage: CountdownStage) {
    this.countdownStage = stage;
    const now = performance.now();
    if (stage === 3 || stage === 2 || stage === 1) {
      this.countdownPulseMs = now;
      this.countdownGoMs = 0;
    } else if (stage === 'GO') {
      this.countdownGoMs = now;
    } else {
      this.countdownGoMs = 0;
      if (this.countdownArrow) this.countdownArrow.visible = false;
    }
  }

  /**
   * Builds a sleek faceted 3D V-notched red dart/chevron marker with a crisp dark cartoon outline.
   * Front and back raised center ridges give sharp 3D multi-facet shading while keeping the exact
   * iconic V-notched downward pointer silhouette from the 58-degree overhead camera.
   */
  private buildCountdownArrow(): THREE.Group {
    const outer = new THREE.Group();
    const tiltPivot = new THREE.Group();
    // Tilt toward the 58-deg overhead camera so the V-notched dart silhouette reads clearly
    tiltPivot.rotation.x = -0.58;
    outer.add(tiltPivot);

    const buildFacetedDartGeo = (
      tipY: number,
      wingX: number,
      wingY: number,
      notchY: number,
      ridgeY: number,
      ridgeZ: number,
    ): THREE.BufferGeometry => {
      const B: [number, number, number] = [0, tipY, 0];
      const R: [number, number, number] = [wingX, wingY, 0];
      const N: [number, number, number] = [0, notchY, 0];
      const L: [number, number, number] = [-wingX, wingY, 0];
      const CF: [number, number, number] = [0, ridgeY, ridgeZ];
      const CB: [number, number, number] = [0, ridgeY, -ridgeZ];

      // Non-indexed triangles so flat-shaded normals are crisp per facet
      const tris: [number, number, number][][] = [
        // Front 4 facets (CCW from +Z)
        [B, R, CF],
        [R, N, CF],
        [N, L, CF],
        [L, B, CF],
        // Back 4 facets (CCW from -Z)
        [R, B, CB],
        [N, R, CB],
        [L, N, CB],
        [B, L, CB],
      ];

      const positions = new Float32Array(tris.length * 9);
      let ptr = 0;
      for (const tri of tris) {
        for (const v of tri) {
          positions[ptr++] = v[0];
          positions[ptr++] = v[1];
          positions[ptr++] = v[2];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      return geo;
    };

    const redMat = new THREE.MeshLambertMaterial({
      color: '#ff2222',
      emissive: '#c00a0a',
      emissiveIntensity: 0.42,
      flatShading: true,
    });
    const outlineMat = new THREE.MeshBasicMaterial({
      color: '#220910',
      side: THREE.BackSide,
    });

    const mainGeo = buildFacetedDartGeo(0, 0.52, 1.38, 0.94, 0.66, 0.24);
    tiltPivot.add(new THREE.Mesh(mainGeo, redMat));

    const outGeo = buildFacetedDartGeo(-0.11, 0.61, 1.51, 1.0, 0.66, 0.32);
    tiltPivot.add(new THREE.Mesh(outGeo, outlineMat));

    return outer;
  }

  private disposeCountdownArrow() {
    if (!this.countdownArrow) return;
    this.scene.remove(this.countdownArrow);
    const mats = new Set<THREE.Material>();
    this.countdownArrow.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => mats.add(m));
        } else {
          mats.add(obj.material);
        }
      }
    });
    mats.forEach((m) => m.dispose());
    this.countdownArrow = null;
  }

  private rebuildNameplates() {
    if (!this.nameplateLayer) return;
    this.nameplateLayer.innerHTML = '';
    this.nameplates = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const el = document.createElement('div');
      el.className = `nameplate ${s.kind === 'human' ? 'nameplate-human' : ''}`;
      el.innerHTML = `<span class="np-dot" style="background:${s.ringAccent || s.color}"></span><span class="np-txt">${s.displayName}</span>`;
      this.nameplateLayer.appendChild(el);
      this.nameplates.push(el);
    }
  }

  private recomputeCameraFit() {
    if (!this.arena) return;
    const { width: vw, height: vh } = this.getViewportSize();
    const w = this.arena.widthM + 2.2;
    const h = this.arena.heightM + 2.4;
    const aspect = Math.max(0.7, vw / Math.max(1, vh));
    const vFovRad = (CAM_FOV * Math.PI) / 180;
    const tanV = Math.tan(vFovRad * 0.5);
    const tanH = tanV * aspect;

    // Fit both horizontal width and foreshortened depth comfortably inside viewport (leaving room for HUD)
    const distForW = (w * 0.5) / (tanH * 0.86);
    const distForH = ((h * 0.5) * Math.sin(PITCH_RAD)) / (tanV * 0.78);
    this.camDist = Math.max(22, distForW, distForH);
  }

  public pushTick(prev: TickSnapshot, next: TickSnapshot) {
    this.prevState = prev;
    this.currState = next;
    this.tickReceivedAtMs = performance.now();
    this.pausedAlpha = 1.0;
    this.processEvents(prev, next, next.events);
  }

  public setPlaybackSpeed(speed: number) {
    const nextSpeed = Math.max(0.1, Math.min(4.0, speed || 1.0));
    const nextInterval = LOGIC_DT_MS / nextSpeed;
    const now = performance.now();
    if (!this.playbackPaused && this.currState && !this.currState.over) {
      const curAlpha = Math.max(0, Math.min(1, (now - this.tickReceivedAtMs) / this.tickIntervalMs));
      this.tickReceivedAtMs = now - curAlpha * nextInterval;
    }
    this.gameSpeed = nextSpeed;
    this.tickIntervalMs = nextInterval;
  }

  public setPlaybackPaused(paused: boolean) {
    if (this.playbackPaused === paused) return;
    const now = performance.now();
    if (paused) {
      this.pausedAlpha =
        !this.currState || this.currState.over
          ? 1.0
          : Math.max(0, Math.min(1, (now - this.tickReceivedAtMs) / this.tickIntervalMs));
      this.playbackPaused = true;
    } else {
      this.playbackPaused = false;
      this.tickReceivedAtMs = now - this.pausedAlpha * this.tickIntervalMs;
    }
  }

  /**
   * Cleanly seeks to an arbitrary replay tick index (forward or backward)
   * without triggering SFX spam or rebuilding WebGL arena geometry.
   */
  public seekToReplayTick(ticks: TickSnapshot[], targetIndex: number) {
    if (ticks.length === 0) return;
    const idx = Math.max(0, Math.min(ticks.length - 1, Math.round(targetIndex)));
    this.fx?.clearAll();
    this.shakeAmp = 0;
    for (const rig of this.rigs) {
      rig.resetDynamicState();
    }

    const targetT = ticks[idx].t;
    for (let i = 1; i <= idx; i++) {
      const prev = ticks[i - 1];
      const curr = ticks[i];
      const gt = curr.t;
      for (const ev of curr.events) {
        if (ev.name === 'DEATH') {
          const victimIdx = ev.a;
          const cause = ev.b;
          const killerIdx = ev.c;
          const rig = this.rigs[victimIdx];
          const vp = curr.players[victimIdx];
          const vpPrev = prev.players[victimIdx];
          if (!rig || !vp) continue;
          const vx = vp.x / 1000;
          const vz = vp.y / 1000;
          if (cause === CauseType.DART) {
            let dx = 1;
            let dz = 0;
            if (killerIdx >= 0 && prev.darts[killerIdx] && curr.darts[killerIdx]) {
              const d0 = prev.darts[killerIdx];
              const d1 = curr.darts[killerIdx];
              dx = d1.x - d0.x;
              dz = d1.y - d0.y;
              if (Math.hypot(dx, dz) < 5) {
                dx = vp.x - d0.x;
                dz = vp.y - d0.y;
              }
            }
            const len = Math.hypot(dx, dz) || 1;
            const yaw = Math.PI * 0.5 - ((vp.face / 100) * Math.PI) / 180;
            rig.triggerSlice(this.scene, gt, vx, vz, yaw, dx / len, dz / len);
          } else if (cause === CauseType.SLASH) {
            let dx = 0;
            let dz = 1;
            if (killerIdx >= 0 && curr.players[killerIdx]) {
              dx = vp.x - curr.players[killerIdx].x;
              dz = vp.y - curr.players[killerIdx].y;
            }
            rig.triggerSlashDeath(gt, vx, vz, dx, dz);
          } else if (cause === CauseType.FALL) {
            const mvx = (vp.x - vpPrev.x) / 1000;
            const mvz = (vp.y - vpPrev.y) / 1000;
            rig.triggerPitFall(gt, vx, vz, mvx, mvz, killerIdx >= 0);
          }
        } else if (targetT - gt <= 20) {
          if (ev.name === 'RELEASE' && this.rigs[ev.a]) this.rigs[ev.a].lastThrowTick = gt;
          else if (ev.name === 'SWING' && this.rigs[ev.a]) {
            if (ev.b === 1) this.rigs[ev.a].lastSlashTick = gt;
            else this.rigs[ev.a].lastKickTick = gt;
          } else if (ev.name === 'CATCH' && this.rigs[ev.a]) this.rigs[ev.a].lastCatchTick = gt;
          else if (ev.name === 'PICK' && this.rigs[ev.a]) this.rigs[ev.a].lastPickTick = gt;
        }
      }
    }

    this.prevState = ticks[Math.max(0, idx - 1)];
    this.currState = ticks[idx];
    this.tickReceivedAtMs = performance.now();
    this.pausedAlpha = 1.0;
  }

  private processEvents(prev: TickSnapshot, curr: TickSnapshot, events: GameEvent[]) {
    if (!this.fx) return;
    const nowSec = this.elapsedSec;
    const gt = curr.t;

    for (const ev of events) {
      switch (ev.name) {
        case 'RELEASE': {
          const seat = ev.a;
          if (this.rigs[seat]) this.rigs[seat].lastThrowTick = gt;
          this.sfx.playThrow();
          break;
        }
        case 'SWING': {
          const seat = ev.a;
          const isSlash = ev.b === 1;
          const p = curr.players[seat];
          if (!p) break;
          const ang = Math.atan2(p.ay, p.ax);
          if (isSlash) {
            if (this.rigs[seat]) this.rigs[seat].lastSlashTick = gt;
            this.fx.spawnSlash(p.x / 1000, p.y / 1000, ang, this.slots[seat].color, nowSec);
            this.sfx.playSlash();
          } else {
            if (this.rigs[seat]) this.rigs[seat].lastKickTick = gt;
            this.fx.spawnKick(p.x / 1000, p.y / 1000, ang, nowSec);
            this.sfx.playKick();
          }
          break;
        }
        case 'KICKHIT': {
          const victim = curr.players[ev.b];
          if (victim) {
            this.fx.spawnKickHit(victim.x / 1000, victim.y / 1000, nowSec);
            this.shakeAmp = Math.max(this.shakeAmp, 0.16);
            this.sfx.playKickHit();
          }
          break;
        }
        case 'DASH': {
          const p = curr.players[ev.a];
          if (p) this.fx.spawnDust(p.x / 1000, p.y / 1000, nowSec, 5, 1.7);
          this.sfx.playDash();
          break;
        }
        case 'TURN': {
          const seat = ev.a;
          this.fx.spawnTurn(ev.b / 1000, ev.c / 1000, this.slots[seat]?.color || '#ffffff', nowSec);
          break;
        }
        case 'CATCH': {
          const seat = ev.a;
          const p = curr.players[seat];
          if (p) this.fx.spawnCatch(p.x / 1000, p.y / 1000, this.slots[seat].color, nowSec);
          if (this.rigs[seat]) this.rigs[seat].lastCatchTick = gt;
          this.sfx.playCatch();
          break;
        }
        case 'PICK': {
          const seat = ev.a;
          if (this.rigs[seat]) this.rigs[seat].lastPickTick = gt;
          this.sfx.playCatch();
          break;
        }
        case 'DROP': {
          this.fx.spawnDust(ev.b / 1000, ev.c / 1000, nowSec, 3, 1.0);
          break;
        }
        case 'CLASH': {
          const colA = this.slots[ev.a]?.color || '#ffffff';
          const colB = this.slots[ev.b]?.color || '#ffffff';
          this.fx.spawnClash(ev.c / 1000, ev.d / 1000, colA, colB, nowSec);
          this.shakeAmp = Math.max(this.shakeAmp, 0.14);
          this.sfx.playClash();
          break;
        }
        case 'BLOCK': {
          this.fx.spawnBlock(ev.c / 1000, ev.d / 1000, this.slots[ev.a]?.color || '#ffffff', nowSec);
          this.shakeAmp = Math.max(this.shakeAmp, 0.12);
          this.sfx.playBlock();
          break;
        }
        case 'CALL': {
          this.sfx.playRecallCall();
          break;
        }
        case 'COLLAPSE': {
          this.shakeAmp = Math.max(this.shakeAmp, 0.12);
          this.sfx.playCollapse();
          break;
        }
        case 'DEATH': {
          const victimIdx = ev.a;
          const cause = ev.b;
          const killerIdx = ev.c;
          const rig = this.rigs[victimIdx];
          const vp = curr.players[victimIdx];
          const vpPrev = prev.players[victimIdx];
          if (!rig || !vp) break;

          const vx = vp.x / 1000;
          const vz = vp.y / 1000;

          if (cause === CauseType.DART) {
            let dx = 1;
            let dz = 0;
            if (killerIdx >= 0 && prev.darts[killerIdx] && curr.darts[killerIdx]) {
              const d0 = prev.darts[killerIdx];
              const d1 = curr.darts[killerIdx];
              dx = d1.x - d0.x;
              dz = d1.y - d0.y;
              if (Math.hypot(dx, dz) < 5) {
                dx = vp.x - d0.x;
                dz = vp.y - d0.y;
              }
            }
            const len = Math.hypot(dx, dz) || 1;
            const ndx = dx / len;
            const ndz = dz / len;
            const yaw = Math.PI * 0.5 - ((vp.face / 100) * Math.PI) / 180;
            rig.triggerSlice(this.scene, gt, vx, vz, yaw, ndx, ndz);
            this.fx.spawnSliceHit(
              vx,
              vz,
              ndx,
              ndz,
              this.slots[victimIdx].color,
              killerIdx >= 0 ? this.slots[killerIdx].color : '#ffffff',
              nowSec,
            );
            this.shakeAmp = Math.max(this.shakeAmp, 0.34);
            this.sfx.playHitKill();
          } else if (cause === CauseType.SLASH) {
            let dx = 0;
            let dz = 1;
            if (killerIdx >= 0 && curr.players[killerIdx]) {
              dx = vp.x - curr.players[killerIdx].x;
              dz = vp.y - curr.players[killerIdx].y;
            }
            rig.triggerSlashDeath(gt, vx, vz, dx, dz);
            this.fx.spawnSliceHit(
              vx,
              vz,
              dx / (Math.hypot(dx, dz) || 1),
              dz / (Math.hypot(dx, dz) || 1),
              this.slots[victimIdx].color,
              killerIdx >= 0 ? this.slots[killerIdx].color : '#ffffff',
              nowSec,
            );
            this.shakeAmp = Math.max(this.shakeAmp, 0.32);
            this.sfx.playHitKill();
          } else if (cause === CauseType.FALL) {
            const mvx = (vp.x - vpPrev.x) / 1000;
            const mvz = (vp.y - vpPrev.y) / 1000;
            rig.triggerPitFall(gt, vx, vz, mvx, mvz, killerIdx >= 0);
            this.sfx.playFall();
          }
          break;
        }
        case 'END': {
          const winner = ev.a;
          if (winner >= 0 && curr.players[winner]?.alive) {
            const wp = curr.players[winner];
            this.fx.spawnConfetti(wp.x / 1000, wp.y / 1000, this.slots[winner].color, nowSec);
          }
          this.sfx.playVictory();
          break;
        }
      }
    }
  }

  private isCellSolidAt(xMm: number, yMm: number, tick: number): boolean {
    if (!this.arena) return true;
    const M = this.arena.mapData;
    const gx = Math.floor(xMm / M.cell);
    const gy = Math.floor(yMm / M.cell);
    if (gx < 0 || gy < 0 || gx >= M.nx || gy >= M.ny) return false;
    const idx = gy * M.nx + gx;
    if (M.cells[idx] === CellType.PIT) return false;
    const w = M.waves[idx];
    if (w >= 0 && tick >= M.waveSteps[w]) return false;
    return true;
  }

  private isCellGrassAt(xMm: number, yMm: number, tick: number): boolean {
    if (!this.arena) return false;
    const M = this.arena.mapData;
    const gx = Math.floor(xMm / M.cell);
    const gy = Math.floor(yMm / M.cell);
    if (gx < 0 || gy < 0 || gx >= M.nx || gy >= M.ny) return false;
    const idx = gy * M.nx + gx;
    const w = M.waves[idx];
    if (w >= 0 && tick >= M.waveSteps[w]) return false;
    return M.cells[idx] === CellType.GRASS;
  }

  private getHumanCollapseWarnUrgency(): number {
    if (!this.arena || !this.currState || this.currState.over || this.humanSeat < 0) return -1;
    const me = this.currState.players[this.humanSeat];
    if (!me || !me.alive || me.dashing) return -1;

    const M = this.arena.mapData;
    const cell = M.cell;
    const t = this.currState.t;
    const ax = Math.floor(me.x / cell);
    const ay = Math.floor(me.y / cell);
    const ex = ((me.x % cell) + cell) % cell === 0;
    const ey = ((me.y % cell) + cell) % cell === 0;

    let maxFallStep = -1;
    let anySolid = false;
    for (let i = 0; i <= (ex ? 1 : 0); i++) {
      for (let j = 0; j <= (ey ? 1 : 0); j++) {
        const gx = ax - i;
        const gy = ay - j;
        if (gx < 0 || gy < 0 || gx >= M.nx || gy >= M.ny) continue;
        const idx = gy * M.nx + gx;
        if (M.cells[idx] === CellType.PIT) continue;
        const w = M.waves[idx];
        const fallStep = w >= 0 && w < M.waveSteps.length ? M.waveSteps[w] : -1;
        if (fallStep >= 0 && t >= fallStep) continue;
        anySolid = true;
        if (fallStep < 0) return -1; // Touching permanent solid ground
        if (fallStep > maxFallStep) maxFallStep = fallStep;
      }
    }

    if (!anySolid || maxFallStep < 0) return -1;
    const colWarn = Math.max(1, M.colWarn);
    if (t >= maxFallStep - colWarn && t < maxFallStep) {
      return Math.max(0, Math.min(1, (t - (maxFallStep - colWarn)) / colWarn));
    }
    return -1;
  }

  /**
   * Render one frame (called directly inside requestAnimationFrame for 240Hz+ / 360Hz+!).
   */
  public renderFrame(input: HumanInputController) {
    const tWork0 = performance.now();
    const frameDt = Math.min(0.05, Math.max(0.0005, (tWork0 - this.lastFrameMs) / 1000));
    this.lastFrameMs = tWork0;
    if (this.previewMode || !this.playbackPaused) {
      this.elapsedSec += frameDt * (this.previewMode ? 1.0 : this.gameSpeed);
    }

    // Measure actual Render Hz (rolling 0.5s window)
    this.frameTimes.push(tWork0);
    while (this.frameTimes.length > 2 && tWork0 - this.frameTimes[0] > 500) {
      this.frameTimes.shift();
    }
    if (this.frameTimes.length >= 2) {
      const span = this.frameTimes[this.frameTimes.length - 1] - this.frameTimes[0];
      if (span > 0) this.renderHz = ((this.frameTimes.length - 1) * 1000) / span;
    }

    // Update camera
    if (this.previewMode && this.arena) {
      this.previewAngle += frameDt * 0.14;
      const dist = this.camDist * 0.96;
      const rHoriz = dist * Math.cos(PITCH_RAD);
      const y = dist * Math.sin(PITCH_RAD);
      this.camera.position.set(
        this.camTargetX + Math.sin(this.previewAngle) * rHoriz * 0.35,
        y,
        this.camTargetZ + Math.cos(this.previewAngle) * rHoriz,
      );
      this.camera.lookAt(this.camTargetX, 0, this.camTargetZ);
      this.arena.update(0, this.elapsedSec);
    } else if (this.arena && this.prevState && this.currState) {
      // Smooth sub-tick interpolation factor [0..1] adapted to current game speed (0.1x..2.0x)!
      const sameTick = this.prevState === this.currState || this.prevState.t === this.currState.t;
      const alpha = this.playbackPaused
        ? this.pausedAlpha
        : this.currState.over || sameTick
          ? 1.0
          : Math.max(0, Math.min(1, (tWork0 - this.tickReceivedAtMs) / this.tickIntervalMs));
      const gt = this.playbackPaused
        ? sameTick || this.currState.over
          ? this.currState.t
          : this.prevState.t + alpha
        : this.currState.over
          ? this.currState.t + (tWork0 - this.tickReceivedAtMs) / this.tickIntervalMs
          : sameTick
            ? this.currState.t
            : this.prevState.t + alpha;

      // Subtle camera shake decay
      let sx = 0;
      let sz = 0;
      if (this.shakeAmp > 0.002) {
        sx = Math.sin(this.elapsedSec * 72) * this.shakeAmp;
        sz = Math.cos(this.elapsedSec * 64) * this.shakeAmp;
        this.shakeAmp *= Math.exp(-frameDt * 12);
      } else {
        this.shakeAmp = 0;
      }

      // Slight vertical offset so top HUD has breathing room
      const camY = this.camDist * Math.sin(PITCH_RAD);
      const camZ = this.camTargetZ + this.camDist * Math.cos(PITCH_RAD) - 0.35;
      this.camera.position.set(this.camTargetX + sx, camY, camZ + sz);
      this.camera.lookAt(this.camTargetX + sx * 0.4, 0, this.camTargetZ - 0.35 + sz * 0.4);
      this.camera.updateMatrixWorld();

      // Update hardware-plane tactical crosshair cursor (0ms OS cursor latency):
      // Blue = holding dart, Yellow = dart flying/recalled, Red = dart on ground (+ growing center dot while channeling recall)
      const humanAliveNow =
        !this.cursorSuppressed &&
        this.humanSeat >= 0 &&
        !this.currState.over &&
        this.currState.players[this.humanSeat]?.alive === 1;
      if (humanAliveNow) {
        const me = this.currState.players[this.humanSeat];
        const dart = this.currState.darts[this.humanSeat];
        if (!dart || dart.st === DState.HAND) {
          this.applyCanvasCursor('armed');
        } else if (dart.st === DState.OUT || dart.st === DState.BACK || dart.st === DState.CALL) {
          this.applyCanvasCursor('flying');
        } else if (dart.st === DState.RISE) {
          const recallPre = Math.max(1, this.arena?.mapData.recallPre || 12);
          const remTicks = Math.max(0, me.timer);
          const prog = Math.max(0, Math.min(1, (recallPre - remTicks + alpha) / recallPre));
          const step = Math.max(0, Math.min(RECALL_CURSOR_STEPS, Math.round(prog * RECALL_CURSOR_STEPS)));
          this.applyCanvasCursor(`recall-${step}`);
        } else {
          this.applyCanvasCursor('dropped');
        }
      } else {
        this.applyCanvasCursor('default');
      }

      // Update mouse raycast into arena ground plane (in mm)
      let aimX = this.camTargetX;
      let aimZ = this.camTargetZ;
      if (this.humanSeat >= 0 && input.hasMouse) {
        this._ndc.set(
          (input.mouseX / window.innerWidth) * 2 - 1,
          -(input.mouseY / window.innerHeight) * 2 + 1,
        );
        this._raycaster.setFromCamera(this._ndc, this.camera);
        if (this._raycaster.ray.intersectPlane(this._groundPlane, this._hitPoint)) {
          aimX = this._hitPoint.x;
          aimZ = this._hitPoint.z;
          input.aimWorldMmX = Math.round(aimX * 1000);
          input.aimWorldMmY = Math.round(aimZ * 1000);
        }
      }

      // Update arena collapsing tiles, grass sway, clouds
      this.arena.update(gt, this.elapsedSec);

      // Play escalating crumbling-gravel SFX when the human player stands on an impending-collapse tile
      const warnUrgency = this.getHumanCollapseWarnUrgency();
      if (warnUrgency >= 0) {
        if (!this.wasOnWarnTile || tWork0 >= this.nextCrumbleAtMs) {
          this.sfx.playCrumble(warnUrgency);
          const intervalMs = (260 - warnUrgency * 145) * (0.85 + Math.random() * 0.3);
          this.nextCrumbleAtMs = tWork0 + intervalMs;
          this.wasOnWarnTile = true;
        }
      } else {
        this.wasOnWarnTile = false;
        this.nextCrumbleAtMs = 0;
      }

      // Update character rigs & floating nameplates
      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      for (let k = 0; k < this.rigs.length; k++) {
        const prevP = this.prevState.players[k];
        const currP = this.currState.players[k];
        const prevD = this.prevState.darts[k];
        const currD = this.currState.darts[k];

        // Visibility rule: if Human is playing & alive, hide enemies that Human cannot see in grass!
        const humanAlive = this.humanSeat >= 0 && this.currState.players[this.humanSeat]?.alive === 1;
        const hiddenFromHuman =
          humanAlive &&
          k !== this.humanSeat &&
          currP.alive === 1 &&
          ((currP.visMask >> this.humanSeat) & 1) === 0;

        // Stealth visual cue (crouch & dim) whenever character is hidden in grass from any opponent
        let inGrassStealth = false;
        if (currP.alive === 1 && this.isCellGrassAt(currP.x, currP.y, this.currState.t)) {
          const hasFlyingDart =
            currD.st === DState.OUT || currD.st === DState.BACK || currD.st === DState.CALL || currD.st === DState.RISE;
          if (!hasFlyingDart && currP.expose === 0) inGrassStealth = true;
        }

        const interpXMm = prevP.x + (currP.x - prevP.x) * alpha;
        const interpYMm = prevP.y + (currP.y - prevP.y) * alpha;
        const onGround = this.isCellSolidAt(interpXMm, interpYMm, this.currState.t);

        this.rigs[k].update(
          prevP,
          currP,
          prevD,
          currD,
          alpha,
          gt,
          this.currState.winner === k,
          this.currState.over,
          hiddenFromHuman,
          inGrassStealth,
          onGround,
          frameDt,
        );

        // Update floating nameplate
        const np = this.nameplates[k];
        if (np) {
          if (!currP.alive || hiddenFromHuman) {
            np.style.opacity = '0';
          } else {
            this._projVec.set(interpXMm / 1000, 1.52, interpYMm / 1000);
            this._projVec.project(this.camera);
            const sxPx = (this._projVec.x * 0.5 + 0.5) * screenW;
            const syPx = (-this._projVec.y * 0.5 + 0.5) * screenH;
            np.style.opacity = inGrassStealth ? '0.52' : '0.96';
            np.style.transform = `translate3d(${sxPx.toFixed(1)}px, ${syPx.toFixed(1)}px, 0) translate(-50%, -100%)`;
          }
        }
      }

      // Update pooled FX + human aim reticle
      if (this.fx) {
        this.fx.update(
          this.elapsedSec,
          this.prevState,
          this.currState,
          alpha,
          this.humanSeat,
          aimX,
          aimZ,
          input.hasMouse,
        );
      }

      // Update pre-match countdown red 3D arrow above the human player
      if (this.countdownArrow) {
        const hp0 = this.humanSeat >= 0 ? this.prevState.players[this.humanSeat] : null;
        const hp1 = this.humanSeat >= 0 ? this.currState.players[this.humanSeat] : null;
        const stage = this.countdownStage;
        const showDuringNums = stage === 3 || stage === 2 || stage === 1;
        const showDuringGo = stage === 'GO' && this.countdownGoMs > 0 && tWork0 - this.countdownGoMs < 360;

        if (hp0 && hp1 && hp1.alive === 1 && !this.currState.over && (showDuringNums || showDuringGo)) {
          const hx = (hp0.x + (hp1.x - hp0.x) * alpha) / 1000;
          const hz = (hp0.y + (hp1.y - hp0.y) * alpha) / 1000;

          // Position tip just above the human's floating nameplate regardless of map zoom/viewport height
          const vFovRad = (CAM_FOV * Math.PI) / 180;
          const worldYPerPx =
            (2 * this.camDist * Math.tan(vFovRad * 0.5)) /
            Math.max(1, window.innerHeight * Math.cos(PITCH_RAD));
          const baseTipY = 1.52 + 24 * worldYPerPx;

          // Crisp downward-pointing arcade bounce + gentle 3D yaw rock to showcase volumetric depth
          const bounce = Math.abs(Math.sin(this.elapsedSec * 5.6)) * 0.36;

          let sc = 1.0;
          if (showDuringGo) {
            const u = Math.min(1, (tWork0 - this.countdownGoMs) / 360);
            sc = Math.max(0.01, 1 - u * u);
          } else if (this.countdownPulseMs > 0) {
            const dtSec = Math.max(0, (tWork0 - this.countdownPulseMs) / 1000);
            sc = 1 + 0.24 * Math.exp(-dtSec * 8.5);
          }

          this.countdownArrow.visible = true;
          this.countdownArrow.position.set(hx, baseTipY + bounce, hz);
          this.countdownArrow.rotation.y = Math.sin(this.elapsedSec * 3.4) * 0.42;
          this.countdownArrow.scale.setScalar(sc);
        } else {
          this.countdownArrow.visible = false;
        }
      }
    }

    this.renderer.render(this.scene, this.camera);

    // Measure CPU frame work time (ms)
    const workMs = performance.now() - tWork0;
    this.workMsAccum += workMs;
    this.workMsSamples++;
    if (this.workMsSamples >= 30) {
      this.avgFrameWorkMs = this.workMsAccum / this.workMsSamples;
      this.workMsAccum = 0;
      this.workMsSamples = 0;
    }
  }

  public setCursorSuppressed(suppressed: boolean) {
    this.cursorSuppressed = suppressed;
    if (suppressed) {
      this.applyCanvasCursor('default');
    }
  }

  private applyCanvasCursor(key: string) {
    if (this.activeCursorKey === key) return;
    this.activeCursorKey = key;
    if (key === 'default') {
      this.canvas.style.cursor = '';
      delete this.canvas.dataset.cursorState;
      return;
    }
    this.canvas.dataset.cursorState = key;
    if (key === 'armed') {
      this.canvas.style.cursor = AIM_CURSOR_BLUE;
    } else if (key === 'flying') {
      this.canvas.style.cursor = AIM_CURSOR_YELLOW;
    } else if (key === 'dropped') {
      this.canvas.style.cursor = AIM_CURSOR_RED;
    } else if (key.startsWith('recall-')) {
      const idx = Math.max(0, Math.min(RECALL_CURSOR_STEPS, Number(key.slice(7)) || 0));
      this.canvas.style.cursor = AIM_CURSOR_RECALL[idx];
    }
  }

  public projectClientToWorldMm(clientX: number, clientY: number): [number, number] | null {
    if (this.previewMode || !this.arena) return null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w <= 0 || h <= 0) return null;
    this._ndc.set((clientX / w) * 2 - 1, -(clientY / h) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    if (this._raycaster.ray.intersectPlane(this._groundPlane, this._hitPoint)) {
      return [Math.round(this._hitPoint.x * 1000), Math.round(this._hitPoint.z * 1000)];
    }
    return null;
  }

  public processOfflineTickEvents(prev: TickSnapshot, curr: TickSnapshot, elapsedSec: number) {
    this.elapsedSec = elapsedSec;
    this.prevState = prev;
    this.currState = curr;
    this.processEvents(prev, curr, curr.events);
  }

  /**
   * Renders one deterministic spectator-perspective frame for offline MP4 export
   * and returns projected 2D nameplate coordinates in the fixed export viewport.
   */
  public renderOfflineFrame(
    prev: TickSnapshot,
    curr: TickSnapshot,
    alpha: number,
    gt: number,
    frameDt: number,
    elapsedSec: number,
  ): ProjectedNameplate[] {
    this.elapsedSec = elapsedSec;
    const out: ProjectedNameplate[] = [];
    if (!this.arena) return out;

    let sx = 0;
    let sz = 0;
    if (this.shakeAmp > 0.002) {
      sx = Math.sin(this.elapsedSec * 72) * this.shakeAmp;
      sz = Math.cos(this.elapsedSec * 64) * this.shakeAmp;
      this.shakeAmp *= Math.exp(-frameDt * 12);
    } else {
      this.shakeAmp = 0;
    }

    const camY = this.camDist * Math.sin(PITCH_RAD);
    const camZ = this.camTargetZ + this.camDist * Math.cos(PITCH_RAD) - 0.35;
    this.camera.position.set(this.camTargetX + sx, camY, camZ + sz);
    this.camera.lookAt(this.camTargetX + sx * 0.4, 0, this.camTargetZ - 0.35 + sz * 0.4);
    this.camera.updateMatrixWorld();

    this.arena.update(gt, elapsedSec);

    const { width: screenW, height: screenH } = this.getViewportSize();
    for (let k = 0; k < this.rigs.length; k++) {
      const prevP = prev.players[k];
      const currP = curr.players[k];
      const prevD = prev.darts[k];
      const currD = curr.darts[k];

      let inGrassStealth = false;
      if (currP.alive === 1 && this.isCellGrassAt(currP.x, currP.y, curr.t)) {
        const hasFlyingDart =
          currD.st === DState.OUT || currD.st === DState.BACK || currD.st === DState.CALL || currD.st === DState.RISE;
        if (!hasFlyingDart && currP.expose === 0) inGrassStealth = true;
      }

      const interpXMm = prevP.x + (currP.x - prevP.x) * alpha;
      const interpYMm = prevP.y + (currP.y - prevP.y) * alpha;
      const onGround = this.isCellSolidAt(interpXMm, interpYMm, curr.t);

      this.rigs[k].update(
        prevP,
        currP,
        prevD,
        currD,
        alpha,
        gt,
        curr.winner === k,
        curr.over,
        false,
        inGrassStealth,
        onGround,
        frameDt,
      );

      if (!currP.alive) {
        out.push({ seat: k, x: 0, y: 0, visible: false, opacity: 0, inGrassStealth: false });
      } else {
        this._projVec.set(interpXMm / 1000, 1.52, interpYMm / 1000);
        this._projVec.project(this.camera);
        out.push({
          seat: k,
          x: (this._projVec.x * 0.5 + 0.5) * screenW,
          y: (-this._projVec.y * 0.5 + 0.5) * screenH,
          visible: true,
          opacity: inGrassStealth ? 0.56 : 0.96,
          inGrassStealth,
        });
      }
    }

    if (this.fx) {
      this.fx.update(elapsedSec, prev, curr, alpha, -1, 0, 0, false);
    }

    this.renderer.render(this.scene, this.camera);
    return out;
  }

  public dispose() {
    this.clearMatchObjects();
    this.scene.remove(this.skyMesh);
    this.skyMesh.geometry.dispose();
    (this.skyMesh.material as THREE.Material).dispose();
    this.renderer.dispose();
    if (this.fixedSize) {
      this.renderer.forceContextLoss();
    }
  }

  public clearMatchObjects() {
    this.applyCanvasCursor('default');
    if (this.arena) {
      this.scene.remove(this.arena.root);
      this.arena.dispose();
      this.arena = null;
    }
    for (const r of this.rigs) r.dispose(this.scene);
    this.rigs = [];
    if (this.fx) {
      this.fx.dispose();
      this.fx = null;
    }
    this.disposeCountdownArrow();
    this.countdownStage = null;
    this.countdownPulseMs = 0;
    this.countdownGoMs = 0;
    if (this.nameplateLayer) {
      this.nameplateLayer.innerHTML = '';
    }
    this.nameplates = [];
    this.prevState = null;
    this.currState = null;
    this.playbackPaused = false;
    this.pausedAlpha = 1.0;
    this.wasOnWarnTile = false;
    this.nextCrumbleAtMs = 0;
  }
}
