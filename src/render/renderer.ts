import * as THREE from 'three';
import { SoundFX } from '../audio/sfx';
import { HumanInputController } from '../game/humanInput';
import { CinematicCameraPose, CinematicDirector } from '../game/killCamDirector';
import { CountdownStage } from '../game/matchController';
import { GraphicsQualityOption } from '../game/settings';
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
import { CharacterRig, PitFallKind, RigDeathEffectCallbacks, WINNER_CELEBRATE_DELAY_TICKS } from './charRig';
import { FXSystem } from './fxSystem';
import { ArenaMover, HqArenaMap3D, IArenaMap } from './hqMapBuilder';
import { getHqTheme } from './hqThemes';
import { ArenaMap3D } from './mapBuilder';
import { getTheme } from './themes';
import { VoxelModelData } from './voxelBuilder';

const EYE_OPEN_SVG =
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M2 12s3.8-6.5 10-6.5S22 12 22 12s-3.8 6.5-10 6.5S2 12 2 12Z"/>` +
  `<circle cx="12" cy="12" r="3.2" fill="currentColor"/>` +
  `</svg>`;

const EYE_CLOSED_SVG =
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M3 10c2.4 3.6 5.5 5.2 9 5.2s6.6-1.6 9-5.2"/>` +
  `<path d="M7.4 14.1 5.8 17.4M12 15.2v3.5M16.6 14.1 18.2 17.4"/>` +
  `</svg>`;

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
  private readonly sunDirVec = new THREE.Vector3(10, 24, 8);
  private shadowMapDirty = true;

  private arena: IArenaMap | null = null;
  private activeMapData: EngineMapData | null = null;
  private activeThemeName = 'meadow';
  private graphicsQuality: GraphicsQualityOption = 'high';
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
  private cinematicDirector: CinematicDirector | null = null;
  private overElapsedSimSec = 0;
  private overElapsedRealSec = 0;
  private nextWinnerRibbonSec = -1;
  private winnerRibbonWave = 0;
  private pendingEndConfetti: { seat: number; triggerTick: number } | null = null;

  // Raycasting scratch (zero allocation per frame)
  private readonly _raycaster = new THREE.Raycaster();
  private readonly _ndc = new THREE.Vector2();
  // Intersect at y = 0.06 to match the 3D aim-line height with zero parallax offset
  private readonly _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.06);
  private readonly _hitPoint = new THREE.Vector3();
  private readonly _projVec = new THREE.Vector3();
  private readonly _focusVec = new THREE.Vector3();
  private readonly _moversScratch: ArenaMover[] = [];
  private cursorSuppressed = false;
  private activeCursorKey = 'default';

  // Floating nameplate DOM elements (positioned via CSS transform3d for 240Hz smoothness!)
  private nameplateLayer: HTMLDivElement | null = null;
  private nameplates: HTMLDivElement[] = [];
  private nameplateEyeEls: (HTMLSpanElement | null)[] = [];
  private nameplateEyeStates: ('none' | 'closed' | 'open')[] = [];

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
    graphicsQuality: GraphicsQualityOption = 'high',
  ) {
    this.canvas = canvas;
    this.sfx = sfx;
    this.fixedSize = fixedSize ?? null;
    this.charModelCache = sharedCharModelCache ?? new Map<string, VoxelModelData>();
    this.graphicsQuality = graphicsQuality;

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
    // Static shadow map caching: only re-render the 2048/1024 depth map when the map loads,
    // quality changes, replay seeks, or shadow-casting obstacles actually collapse/fall!
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = false;

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
    const initShadowRes = this.graphicsQuality === 'high' ? 2048 : 1024;
    this.sunLight.shadow.mapSize.set(initShadowRes, initShadowRes);
    this.sunLight.shadow.camera.near = 4;
    this.sunLight.shadow.camera.far = 75;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = this.graphicsQuality === 'high' ? -0.0007 : -0.0012;
    this.sunLight.shadow.normalBias = this.graphicsQuality === 'high' ? 0.025 : 0;
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

  private createArenaInstance(mapData: EngineMapData, themeName: string): IArenaMap {
    return this.graphicsQuality === 'high'
      ? new HqArenaMap3D(mapData, themeName)
      : new ArenaMap3D(mapData, themeName);
  }

  private invalidateShadowMap() {
    this.shadowMapDirty = true;
  }

  private flushShadowMapIfDirty() {
    if (!this.shadowMapDirty) return;
    this.renderer.shadowMap.needsUpdate = true;
    this.shadowMapDirty = false;
  }

  private updateSunShadowResolution() {
    const targetRes = this.graphicsQuality === 'high' ? 2048 : 1024;
    if (this.sunLight.shadow.mapSize.x !== targetRes) {
      this.sunLight.shadow.mapSize.set(targetRes, targetRes);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    }
    this.sunLight.shadow.bias = this.graphicsQuality === 'high' ? -0.0007 : -0.0012;
    this.sunLight.shadow.normalBias = this.graphicsQuality === 'high' ? 0.025 : 0;
    this.invalidateShadowMap();
  }

  private positionSunForArena() {
    if (!this.arena) return;
    const cx = this.arena.widthM * 0.5;
    const cz = this.arena.heightM * 0.5;
    let dx = 10;
    let dy = 24;
    let dz = 8;
    if (this.graphicsQuality === 'high') {
      const hq = getHqTheme(this.activeThemeName);
      const azRad = (hq.light.az * Math.PI) / 180;
      const elRad = (hq.light.el * Math.PI) / 180;
      const dist = 34;
      // Blender az/el -> Three.js (bx, bz, -by)
      dx = Math.cos(elRad) * Math.sin(azRad) * dist;
      dy = Math.sin(elRad) * dist;
      dz = -Math.cos(elRad) * Math.cos(azRad) * dist;
    }
    this.sunDirVec.set(dx, dy, dz);
    this.sunLight.position.set(cx + dx, dy, cz + dz);
    this.sunLight.target.position.set(cx, 0, cz);
    this.sunLight.target.updateMatrixWorld();

    for (const rig of this.rigs) {
      rig.setSunDirection(dx, dy, dz);
    }

    const halfSpan = Math.max(this.arena.widthM, this.arena.heightM) * (this.graphicsQuality === 'high' ? 0.78 : 0.65);
    this.sunLight.shadow.camera.left = -halfSpan;
    this.sunLight.shadow.camera.right = halfSpan;
    this.sunLight.shadow.camera.top = halfSpan;
    this.sunLight.shadow.camera.bottom = -halfSpan;
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.invalidateShadowMap();
  }

  public setGraphicsQuality(quality: GraphicsQualityOption) {
    if (this.graphicsQuality === quality) return;
    this.graphicsQuality = quality;
    const hq = quality === 'high';
    for (const rig of this.rigs) {
      rig.setHighQuality(hq);
    }
    this.fx?.setHighQuality(hq);
    this.updateSunShadowResolution();
    if (this.arena && this.activeMapData) {
      this.scene.remove(this.arena.root);
      this.arena.dispose();
      this.applyThemeLighting(this.activeThemeName);
      this.arena = this.createArenaInstance(this.activeMapData, this.activeThemeName);
      this.scene.add(this.arena.root);
      this.positionSunForArena();
      if (this.currState) {
        this.arena.update(this.currState.t, this.elapsedSec, {
          freezeCollapseAtTick: this.currState.over ? this.currState.t : undefined,
        });
      }
    }
  }

  private applyThemeLighting(themeName: string) {
    const skyMat = this.skyMesh.material as THREE.ShaderMaterial;
    if (this.graphicsQuality === 'high') {
      const hq = getHqTheme(themeName);
      skyMat.uniforms.topColor.value.set(hq.pal.sky_deep);
      skyMat.uniforms.bottomColor.value.set(hq.pal.sky);
      this.scene.fog = new THREE.Fog(hq.pal.haze, 52, 138);
      this.sunLight.color.setRGB(hq.light.color[0], hq.light.color[1], hq.light.color[2]);
      this.sunLight.intensity = hq.light.energy * 0.34;
      this.hemiLight.color.set(hq.pal.ambient);
      this.hemiLight.groundColor.set(hq.pal.rock_deep);
      this.hemiLight.intensity = hq.light.ambient * 1.62;
    } else {
      const T = getTheme(themeName);
      skyMat.uniforms.topColor.value.set(T.skyTop);
      skyMat.uniforms.bottomColor.value.set(T.skyBottom);
      this.scene.fog = new THREE.Fog(T.fogColor, 48, 125);
      this.sunLight.color.set(T.sunColor);
      this.sunLight.intensity = T.sunIntensity;
      this.hemiLight.color.set(T.ambientSky);
      this.hemiLight.groundColor.set(T.ambientGround);
      this.hemiLight.intensity = T.ambientIntensity;
    }
  }

  public async loadPreviewMap(mapData: EngineMapData, themeName: string) {
    this.clearMatchObjects();
    this.previewMode = true;
    this.activeMapData = mapData;
    this.activeThemeName = themeName;
    this.resetCameraToOverview({ nx: mapData.nx, ny: mapData.ny, cell: mapData.cell });
    this.applyThemeLighting(themeName);
    this.arena = this.createArenaInstance(mapData, themeName);
    this.scene.add(this.arena.root);
    this.positionSunForArena();
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
    this.activeMapData = mapData;
    this.activeThemeName = themeName;
    this.slots = slots;
    this.humanSeat = humanSeat;
    this.gameSpeed = Math.max(0.1, Math.min(2.0, speed || 1.0));
    this.tickIntervalMs = LOGIC_DT_MS / this.gameSpeed;

    // Reset camera to the new map's clean overhead overview BEFORE building & mounting the new arena
    this.resetCameraToOverview({ nx: mapData.nx, ny: mapData.ny, cell: mapData.cell });

    this.applyThemeLighting(themeName);
    this.arena = this.createArenaInstance(mapData, themeName);
    this.scene.add(this.arena.root);

    this.positionSunForArena();

    // Load voxel character models & construct rigs
    const hq = this.graphicsQuality === 'high';
    const models = await Promise.all(slots.map((s) => this.loadCharModel(s.charKey)));
    this.rigs = slots.map((slot, idx) => {
      const ringCol = slot.ringAccent || slot.color;
      const rig = new CharacterRig(idx, models[idx], ringCol, slot.kind === 'human', this.scene, hq);
      rig.setSunDirection(this.sunDirVec.x, this.sunDirVec.y, this.sunDirVec.z);
      return rig;
    });

    this.fx = new FXSystem(
      this.scene,
      slots.map((s) => s.ringAccent || s.color),
      hq,
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
    this.overElapsedSimSec = 0;
    this.overElapsedRealSec = 0;
    this.nextWinnerRibbonSec = -1;
    this.winnerRibbonWave = 0;
    this.pendingEndConfetti = null;
    this.cinematicDirector = null;
    this.wasOnWarnTile = false;
    this.nextCrumbleAtMs = 0;

    this.resetCameraToOverview({ nx: mapData.nx, ny: mapData.ny, cell: mapData.cell });
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
    this.nameplateEyeEls = [];
    this.nameplateEyeStates = [];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      const el = document.createElement('div');
      el.className = `nameplate ${s.kind === 'human' ? 'nameplate-human' : ''}`;
      el.innerHTML = `<span class="np-eye" data-eye="none"></span><span class="np-dot" style="background:${s.ringAccent || s.color}"></span><span class="np-txt">${s.displayName}</span>`;
      this.nameplateLayer.appendChild(el);
      this.nameplates.push(el);
      this.nameplateEyeEls.push(el.querySelector<HTMLSpanElement>('.np-eye'));
      this.nameplateEyeStates.push('none');
    }
  }

  private setNameplateEyeState(seat: number, next: 'none' | 'closed' | 'open') {
    if (this.nameplateEyeStates[seat] === next) return;
    this.nameplateEyeStates[seat] = next;
    const eyeEl = this.nameplateEyeEls[seat];
    if (!eyeEl) return;
    eyeEl.dataset.eye = next;
    if (next === 'open') eyeEl.innerHTML = EYE_OPEN_SVG;
    else if (next === 'closed') eyeEl.innerHTML = EYE_CLOSED_SVG;
    else eyeEl.innerHTML = '';
  }

  private recomputeCameraFitForSize(widthM: number, heightM: number) {
    const { width: vw, height: vh } = this.getViewportSize();
    const w = widthM + 2.2;
    const h = heightM + 2.4;
    const aspect = Math.max(0.7, vw / Math.max(1, vh));
    const vFovRad = (CAM_FOV * Math.PI) / 180;
    const tanV = Math.tan(vFovRad * 0.5);
    const tanH = tanV * aspect;

    // Fit both horizontal width and foreshortened depth comfortably inside viewport (leaving room for HUD)
    const distForW = (w * 0.5) / (tanH * 0.86);
    const distForH = ((h * 0.5) * Math.sin(PITCH_RAD)) / (tanV * 0.78);
    this.camDist = Math.max(22, distForW, distForH);
  }

  private recomputeCameraFit() {
    if (!this.arena) return;
    this.recomputeCameraFitForSize(this.arena.widthM, this.arena.heightM);
  }

  /**
   * Immediately clears any active close-up cinematic / screen shake / foreground fade and
   * snaps the camera back to the clean overhead overview framing BEFORE loading a new map.
   */
  public resetCameraToOverview(mapDims?: { nx: number; ny: number; cell?: number }) {
    this.cinematicDirector = null;
    this.shakeAmp = 0;
    this.overElapsedSimSec = 0;
    this.overElapsedRealSec = 0;
    this.nextWinnerRibbonSec = -1;
    this.winnerRibbonWave = 0;
    this.pendingEndConfetti = null;

    if (mapDims) {
      const cs = (mapDims.cell ?? 500) / 1000;
      const widthM = mapDims.nx * cs;
      const heightM = mapDims.ny * cs;
      this.camTargetX = widthM * 0.5;
      this.camTargetZ = heightM * 0.5;
      this.recomputeCameraFitForSize(widthM, heightM);
    } else if (this.arena) {
      this.camTargetX = this.arena.widthM * 0.5;
      this.camTargetZ = this.arena.heightM * 0.5;
      this.recomputeCameraFit();
    }

    const y = this.camDist * Math.sin(PITCH_RAD);
    const z = this.camTargetZ + this.camDist * Math.cos(PITCH_RAD) - 0.35;
    this.camera.position.set(this.camTargetX, y, z);
    this.camera.lookAt(this.camTargetX, 0, this.camTargetZ - 0.35);
    this.camera.updateMatrixWorld();

    if (this.arena) {
      this._focusVec.set(this.camTargetX, 0, this.camTargetZ);
      this.arena.updateCloseupOcclusion(this.camera.position, this._focusVec, 0, 1);
    }
  }

  public setCinematicDirector(director: CinematicDirector | null) {
    this.cinematicDirector = director;
  }

  public pushTick(prev: TickSnapshot, next: TickSnapshot, tickDurationMs?: number) {
    this.prevState = prev;
    this.currState = next;
    if (tickDurationMs && tickDurationMs > 0) {
      this.tickIntervalMs = tickDurationMs;
    }
    if (!next.over) {
      this.overElapsedSimSec = 0;
      this.overElapsedRealSec = 0;
      this.nextWinnerRibbonSec = -1;
      this.winnerRibbonWave = 0;
    }
    this.tickReceivedAtMs = performance.now();
    this.pausedAlpha = 1.0;
    this.processEvents(prev, next, next.events);
  }

  public setPlaybackSpeed(speed: number) {
    const nextSpeed = Math.max(0.1, Math.min(4.0, speed || 1.0));
    const curSimSec = this.currState ? this.currState.t * 0.05 : 0;
    const cineScale = this.cinematicDirector?.getSpeedScaleAtSim(curSimSec) ?? 1.0;
    const nextInterval = LOGIC_DT_MS / (nextSpeed * cineScale);
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
            const ndx = dx / len;
            const ndz = dz / len;
            const yaw = Math.PI * 0.5 - ((vp.face / 100) * Math.PI) / 180;
            const { landUpper, landLower } = this.computeSliceLanding(vx, vz, ndx, ndz, victimIdx, gt);
            rig.triggerSlice(this.scene, gt, vx, vz, yaw, ndx, ndz, landUpper, landLower);
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
            const kind = this.classifyPitFallKind(vp.x, vp.y, killerIdx, gt);
            rig.triggerPitFall(gt, vx, vz, mvx, mvz, killerIdx >= 0, kind);
          }
        } else if (targetT - gt <= 20) {
          if (ev.name === 'RELEASE' && this.rigs[ev.a]) this.rigs[ev.a].lastThrowTick = gt;
          else if (ev.name === 'SWING' && this.rigs[ev.a]) {
            if (ev.b === 1) this.rigs[ev.a].lastSlashTick = gt;
            else this.rigs[ev.a].lastKickTick = gt;
          } else if (ev.name === 'CATCH' && this.rigs[ev.a]) this.rigs[ev.a].lastCatchTick = gt;
          else if (ev.name === 'PICK' && this.rigs[ev.a]) this.rigs[ev.a].lastPickTick = gt;
          else if (ev.name === 'STOP' && this.rigs[ev.a]) this.rigs[ev.a].lastDashEndTick = gt;
          else if (ev.name === 'DROP' && this.rigs[ev.a]) this.rigs[ev.a].lastDartLandTick = gt;
          else if (ev.name === 'KICKHIT' && this.rigs[ev.b]) {
            this.rigs[ev.b].lastStunTick = gt;
            const kicker = curr.players[ev.a];
            const victim = curr.players[ev.b];
            if (kicker && victim) {
              const dkx = kicker.x - victim.x;
              const dky = kicker.y - victim.y;
              if (Math.hypot(dkx, dky) > 1) {
                this.rigs[ev.b].lastStunFaceYaw = Math.atan2(dkx, dky);
              }
            }
          }
        }
      }
    }

    this.prevState = ticks[Math.max(0, idx - 1)];
    this.currState = ticks[idx];
    this.overElapsedSimSec = 0;
    this.overElapsedRealSec = 0;
    this.nextWinnerRibbonSec = -1;
    this.winnerRibbonWave = 0;
    this.pendingEndConfetti = null;
    this.tickReceivedAtMs = performance.now();
    this.pausedAlpha = 1.0;
    this.invalidateShadowMap();
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
          const kicker = curr.players[ev.a];
          const victim = curr.players[ev.b];
          if (victim) {
            if (this.rigs[ev.b]) {
              this.rigs[ev.b].lastStunTick = gt;
              if (kicker) {
                const dkx = kicker.x - victim.x;
                const dky = kicker.y - victim.y;
                if (Math.hypot(dkx, dky) > 1) {
                  this.rigs[ev.b].lastStunFaceYaw = Math.atan2(dkx, dky);
                }
              }
            }
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
        case 'STOP': {
          const seat = ev.a;
          if (this.rigs[seat]) this.rigs[seat].lastDashEndTick = gt;
          if (this.graphicsQuality === 'high') {
            const p = curr.players[seat];
            if (p) this.fx.spawnDust(p.x / 1000, p.y / 1000, nowSec, 3, 1.0, 0.72);
          }
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
          if (this.graphicsQuality === 'high') {
            const p = curr.players[seat];
            if (p) this.fx.spawnCatch(p.x / 1000, p.y / 1000, this.slots[seat]?.color || '#ffffff', nowSec);
          }
          this.sfx.playCatch();
          break;
        }
        case 'DROP': {
          if (this.rigs[ev.a]) this.rigs[ev.a].lastDartLandTick = gt;
          this.fx.spawnDrop(ev.b / 1000, ev.c / 1000, nowSec);
          break;
        }
        case 'LOST': {
          if (this.graphicsQuality === 'high') {
            this.fx.spawnPoof(ev.b / 1000, 0.66, ev.c / 1000, this.slots[ev.a]?.color || '#ffffff', nowSec, 0.55);
          }
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
          this.fx.spawnBlock(
            ev.c / 1000,
            ev.d / 1000,
            this.slots[ev.a]?.color || '#ffffff',
            nowSec,
            this.slots[ev.b]?.color,
          );
          this.shakeAmp = Math.max(this.shakeAmp, 0.12);
          this.sfx.playBlock();
          break;
        }
        case 'CALL': {
          if (this.graphicsQuality === 'high') {
            this.fx.spawnTurn(ev.b / 1000, ev.c / 1000, this.slots[ev.a]?.color || '#ffffff', nowSec);
          }
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
            const { landUpper, landLower } = this.computeSliceLanding(vx, vz, ndx, ndz, victimIdx, gt);
            rig.triggerSlice(this.scene, gt, vx, vz, yaw, ndx, ndz, landUpper, landLower);
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
            const killerCol = killerIdx >= 0 ? this.slots[killerIdx].color : '#ffffff';
            if (this.graphicsQuality === 'high') {
              this.fx.spawnHit(vx, vz, killerCol, nowSec);
            } else {
              this.fx.spawnSliceHit(
                vx,
                vz,
                dx / (Math.hypot(dx, dz) || 1),
                dz / (Math.hypot(dx, dz) || 1),
                this.slots[victimIdx].color,
                killerCol,
                nowSec,
              );
            }
            this.shakeAmp = Math.max(this.shakeAmp, 0.32);
            this.sfx.playHitKill();
          } else if (cause === CauseType.FALL) {
            const mvx = (vp.x - vpPrev.x) / 1000;
            const mvz = (vp.y - vpPrev.y) / 1000;
            const kind = this.classifyPitFallKind(vp.x, vp.y, killerIdx, gt);
            rig.triggerPitFall(gt, vx, vz, mvx, mvz, killerIdx >= 0, kind);
            if (this.graphicsQuality === 'high') {
              this.fx.spawnFallCry(vx, vz, nowSec);
            }
            this.sfx.playFall();
          }
          break;
        }
        case 'END': {
          const winner = ev.a;
          if (winner >= 0 && curr.players[winner]?.alive) {
            this.pendingEndConfetti = {
              seat: winner,
              triggerTick: curr.t + WINNER_CELEBRATE_DELAY_TICKS,
            };
          }
          this.sfx.playVictory();
          break;
        }
      }
    }
  }

  private classifyPitFallKind(xMm: number, yMm: number, killerIdx: number, tick: number): PitFallKind {
    if (this.arena) {
      const M = this.arena.mapData;
      const gx = Math.floor(xMm / M.cell);
      const gy = Math.floor(yMm / M.cell);
      if (gx >= 0 && gy >= 0 && gx < M.nx && gy < M.ny) {
        const w = M.waves[gy * M.nx + gx];
        if (w >= 0 && w < M.waveSteps.length) {
          const ws = M.waveSteps[w];
          if (tick - 2.5 <= ws && ws <= tick + 1.5) return 'ground';
        }
      }
    }
    return killerIdx >= 0 ? 'kick' : 'walk';
  }

  private computeSliceLanding(
    vx: number,
    vz: number,
    ndx: number,
    ndz: number,
    seat: number,
    tick: number,
  ): { landUpper: boolean; landLower: boolean } {
    let sx = -ndz;
    let sz = ndx;
    if (sz < -0.01 || (Math.abs(sz) <= 0.01 && seat % 2 === 1)) {
      sx = ndz;
      sz = -ndx;
    }
    const landUpper = this.isCellSolidAt((vx + ndx * 1.3) * 1000, (vz + ndz * 1.3) * 1000, tick + 7);
    const landLower = this.isCellSolidAt((vx + sx * 0.32) * 1000, (vz + sz * 0.32) * 1000, tick + 7);
    return { landUpper, landLower };
  }

  private collectArenaMovers(prev: TickSnapshot, curr: TickSnapshot, alpha: number): ArenaMover[] {
    const out = this._moversScratch;
    out.length = 0;
    if (this.graphicsQuality !== 'high') return out;
    for (let k = 0; k < curr.n; k++) {
      const p0 = prev.players[k];
      const p1 = curr.players[k];
      if (p1 && p1.alive === 1) {
        const px = (p0.x + (p1.x - p0.x) * alpha) / 1000;
        const pz = (p0.y + (p1.y - p0.y) * alpha) / 1000;
        const speed = curr.over ? 0 : Math.hypot(p1.vx, p1.vy) / 1000;
        out.push({ x: px, z: pz, speed });
      }
      const d0 = prev.darts[k];
      const d1 = curr.darts[k];
      if (d1 && (d1.st === DState.OUT || d1.st === DState.BACK || d1.st === DState.CALL)) {
        const usePrev = d0 && d0.st !== DState.HAND && d0.st !== DState.GONE;
        const dx = (usePrev ? d0.x + (d1.x - d0.x) * alpha : d1.x) / 1000;
        const dz = (usePrev ? d0.y + (d1.y - d0.y) * alpha : d1.y) / 1000;
        out.push({ x: dx, z: dz, speed: 0.3 });
      }
    }
    return out;
  }

  private makeDeathEffectCallbacks(seat: number, nowSec: number): RigDeathEffectCallbacks | undefined {
    if (this.graphicsQuality !== 'high' || !this.fx) return undefined;
    const fx = this.fx;
    const col = this.slots[seat]?.color || '#ffffff';
    return {
      onCloudSplash: (x, z) => fx.spawnCloudSplash(x, z, nowSec),
      onPoof: (x, y, z, size) => fx.spawnPoof(x, y, z, col, nowSec, size),
    };
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

  private maybeEmitWinnerConfetti(
    curr: TickSnapshot,
    cinePose: CinematicCameraPose | null,
    nowSec: number,
    gt: number,
  ) {
    if (!this.fx || !curr.over || curr.winner < 0) {
      return;
    }
    if (this.pendingEndConfetti && gt >= this.pendingEndConfetti.triggerTick) {
      const seat = this.pendingEndConfetti.seat;
      this.pendingEndConfetti = null;
      const wp = curr.players[seat];
      if (wp && wp.alive) {
        this.fx.spawnConfetti(wp.x / 1000, wp.y / 1000, this.slots[seat].color, nowSec);
      }
    }
    if (!cinePose || cinePose.winnerBlend < 0.2 || gt < curr.t + WINNER_CELEBRATE_DELAY_TICKS) {
      return;
    }
    const wp = curr.players[curr.winner];
    if (!wp || !wp.alive) return;
    const slot = this.slots[curr.winner];
    const col = slot?.ringAccent || slot?.color || '#ffe04d';

    if (this.nextWinnerRibbonSec < 0 || nowSec < this.nextWinnerRibbonSec - 1.5) {
      this.nextWinnerRibbonSec = nowSec;
    }
    // Periodic 360-degree confetti ribbon shower every 0.72s while winner close-up is active!
    let guard = 0;
    while (nowSec >= this.nextWinnerRibbonSec && guard < 4) {
      this.fx.spawnWinnerConfettiBurst(
        wp.x / 1000,
        wp.y / 1000,
        col,
        this.nextWinnerRibbonSec,
        this.winnerRibbonWave++,
      );
      this.nextWinnerRibbonSec += 0.72;
      guard++;
    }
  }

  private applyCameraWithOptionalCinematic(
    simSec: number,
    frameDt: number,
    explicitPose?: CinematicCameraPose | null,
  ): CinematicCameraPose | null {
    const ovPos = {
      x: this.camTargetX,
      y: this.camDist * Math.sin(PITCH_RAD),
      z: this.camTargetZ + this.camDist * Math.cos(PITCH_RAD) - 0.35,
    };
    const ovLook = {
      x: this.camTargetX,
      y: 0,
      z: this.camTargetZ - 0.35,
    };

    const pose =
      explicitPose !== undefined
        ? explicitPose
        : this.cinematicDirector?.isEnabled()
          ? this.cinematicDirector.evaluate(simSec, ovPos, ovLook)
          : null;

    const camPos = pose ? pose.pos : ovPos;
    const camLook = pose ? pose.lookAt : ovLook;

    // Scale camera shake proportionally to camera distance so close-up shots stay dramatic without jarring jumps
    let sx = 0;
    let sz = 0;
    if (this.shakeAmp > 0.002) {
      const distNow = Math.hypot(
        camPos.x - camLook.x,
        camPos.y - camLook.y,
        camPos.z - camLook.z,
      );
      const shakeScale = Math.max(0.18, Math.min(1.0, distNow / Math.max(1, this.camDist)));
      sx = Math.sin(this.elapsedSec * 72) * this.shakeAmp * shakeScale;
      sz = Math.cos(this.elapsedSec * 64) * this.shakeAmp * shakeScale;
      this.shakeAmp *= Math.exp(-frameDt * 12);
    } else {
      this.shakeAmp = 0;
    }

    this.camera.position.set(camPos.x + sx, camPos.y, camPos.z + sz);
    this.camera.lookAt(camLook.x + sx * 0.4, camLook.y, camLook.z + sz * 0.4);
    this.camera.updateMatrixWorld();
    return pose;
  }

  /**
   * Render one frame (called directly inside requestAnimationFrame for 240Hz+ / 360Hz+!).
   */
  public renderFrame(input: HumanInputController) {
    const tWork0 = performance.now();
    const frameDt = Math.min(0.05, Math.max(0.0005, (tWork0 - this.lastFrameMs) / 1000));
    this.lastFrameMs = tWork0;

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
      this.elapsedSec += frameDt;
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
      if (this.arena.update(0, this.elapsedSec)) {
        this.shadowMapDirty = true;
      }
    } else if (this.arena && this.prevState && this.currState) {
      // Smooth sub-tick interpolation factor [0..1] adapted to current game speed & kill-cam slow-mo!
      const sameTick = this.prevState === this.currState || this.prevState.t === this.currState.t;
      const alpha = this.playbackPaused
        ? this.pausedAlpha
        : this.currState.over || sameTick
          ? 1.0
          : Math.max(0, Math.min(1, (tWork0 - this.tickReceivedAtMs) / this.tickIntervalMs));

      let gt: number;
      let liveScale = 1.0;
      let effectiveBaseSpeed = this.gameSpeed;
      if (this.playbackPaused) {
        gt = this.currState.over
          ? this.currState.t + this.overElapsedSimSec * 20
          : sameTick
            ? this.currState.t
            : this.prevState.t + alpha;
        liveScale = this.cinematicDirector?.getSpeedScaleAtSim(gt * 0.05) ?? 1.0;
      } else if (this.currState.over) {
        // Smoothly transition base playback speed from configured gameSpeed -> 1.0x after match end
        // so winner close-up, victory hops, confetti, and result overlay always play cleanly at 1.0x!
        this.overElapsedRealSec += frameDt;
        const uRamp = Math.min(1, this.overElapsedRealSec / 0.45);
        const smoothRamp = uRamp * uRamp * (3 - 2 * uRamp);
        effectiveBaseSpeed = this.gameSpeed + (1.0 - this.gameSpeed) * smoothRamp;

        const curOverSim = this.currState.t * 0.05 + this.overElapsedSimSec;
        liveScale = this.cinematicDirector?.getSpeedScaleAtSim(curOverSim) ?? 1.0;
        this.overElapsedSimSec += frameDt * effectiveBaseSpeed * liveScale;
        gt = this.currState.t + this.overElapsedSimSec * 20;
      } else {
        gt = sameTick ? this.currState.t : this.prevState.t + alpha;
        liveScale = this.cinematicDirector?.getSpeedScaleAtSim(gt * 0.05) ?? 1.0;
      }

      const simFrameDt = frameDt * effectiveBaseSpeed * liveScale;
      if (!this.playbackPaused) {
        this.elapsedSec += simFrameDt;
      }

      const cinePose = this.applyCameraWithOptionalCinematic(gt * 0.05, simFrameDt);

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

      // Update arena collapsing tiles, grass sway & mover brush-parting, clouds (freeze collapse once match is over!)
      const movers = this.collectArenaMovers(this.prevState, this.currState, alpha);
      const liveFx = this.fx;
      const liveElapsed = this.elapsedSec;
      if (
        this.arena.update(gt, liveElapsed, {
          freezeCollapseAtTick: this.currState.over ? this.currState.t : undefined,
          movers,
          onCollapseDust:
            this.graphicsQuality === 'high' && liveFx && !this.playbackPaused
              ? (cx, cy, cz, count, spread, size, alpha0, riseVy) =>
                  liveFx.spawnCollapseDust(cx, cy, cz, liveElapsed, count, spread, size, alpha0, riseVy)
              : undefined,
        })
      ) {
        this.shadowMapDirty = true;
      }

      // Semi-transparent foreground obstacles blocking subject during close-up shots!
      if (cinePose && cinePose.blend > 0.01) {
        this._focusVec.set(cinePose.lookAt.x, cinePose.lookAt.y, cinePose.lookAt.z);
        this.arena.updateCloseupOcclusion(this.camera.position, this._focusVec, cinePose.blend, frameDt);
      } else {
        this._focusVec.set(this.camTargetX, 0, this.camTargetZ);
        this.arena.updateCloseupOcclusion(this.camera.position, this._focusVec, 0, frameDt);
      }

      // Play escalating crumbling-gravel SFX when the human player stands on an impending-collapse tile
      const warnUrgency = this.playbackPaused ? -1 : this.getHumanCollapseWarnUrgency();
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

      // Determine whether the live human player is currently in grass (LoL Twitch-style stealth ring + AI eye indicators)
      const meHuman = this.humanSeat >= 0 ? this.currState.players[this.humanSeat] : null;
      const humanAlive = Boolean(meHuman && meHuman.alive === 1);
      const humanInGrass =
        humanAlive &&
        !this.currState.over &&
        Boolean(meHuman && this.isCellGrassAt(meHuman.x, meHuman.y, this.currState.t));
      let spottedByAny = false;

      // Update character rigs & floating nameplates
      const screenW = window.innerWidth;
      const screenH = window.innerHeight;
      for (let k = 0; k < this.rigs.length; k++) {
        const prevP = this.prevState.players[k];
        const currP = this.currState.players[k];
        const prevD = this.prevState.darts[k];
        const currD = this.currState.darts[k];

        // Visibility rule: if Human is playing & alive, hide enemies that Human cannot see in grass!
        const hiddenFromHuman =
          humanAlive &&
          k !== this.humanSeat &&
          currP.alive === 1 &&
          ((currP.visMask >> this.humanSeat) & 1) === 0;

        // Eye indicator above opponent AI heads when human is standing in grass!
        let eyeState: 'none' | 'closed' | 'open' = 'none';
        if (humanInGrass && meHuman && k !== this.humanSeat && currP.alive === 1) {
          const aiCanSeeMe = ((meHuman.visMask >> k) & 1) !== 0;
          if (aiCanSeeMe) spottedByAny = true;
          if (!hiddenFromHuman) {
            eyeState = aiCanSeeMe ? 'open' : 'closed';
          }
        }
        this.setNameplateEyeState(k, eyeState);

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
          this.currState.t,
          this.currState.winner === k,
          this.currState.over,
          hiddenFromHuman,
          inGrassStealth,
          onGround,
          simFrameDt,
          cinePose?.winnerFaceYaw,
          !currP.alive && !this.playbackPaused ? this.makeDeathEffectCallbacks(k, this.elapsedSec) : undefined,
        );

        // Update floating nameplate (hide if behind close-up camera or fading cleanly during winner portrait)
        const np = this.nameplates[k];
        if (np) {
          if (!currP.alive || hiddenFromHuman) {
            np.style.opacity = '0';
          } else {
            this._projVec.set(interpXMm / 1000, 1.52, interpYMm / 1000);
            this._projVec.project(this.camera);
            const behindCam = this._projVec.z > 1.0 || this._projVec.z < -1.0;
            const winFade =
              this.currState.over && this.currState.winner === k && cinePose
                ? Math.max(0, 1 - cinePose.winnerBlend * 1.4)
                : 1;
            const baseOp = inGrassStealth ? 0.52 : 0.96;
            const finalOp = behindCam ? 0 : baseOp * winFade;
            if (finalOp <= 0.02) {
              np.style.opacity = '0';
            } else {
              const sxPx = (this._projVec.x * 0.5 + 0.5) * screenW;
              const syPx = (-this._projVec.y * 0.5 + 0.5) * screenH;
              np.style.opacity = finalOp.toFixed(2);
              np.style.transform = `translate3d(${sxPx.toFixed(1)}px, ${syPx.toFixed(1)}px, 0) translate(-50%, -100%)`;
            }
          }
        }
      }

      // Periodic festive confetti ribbons around winner during winner close-up
      if (!this.playbackPaused) {
        this.maybeEmitWinnerConfetti(this.currState, cinePose, this.elapsedSec, gt);
      }

      // Update pooled FX + human aim reticle + grass stealth ring
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
          humanInGrass,
          spottedByAny,
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

    this.flushShadowMapIfDirty();
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
   * Renders one deterministic spectator-perspective frame for offline MP4/GIF export
   * and returns projected 2D nameplate coordinates in the fixed export viewport.
   */
  public renderOfflineFrame(
    prev: TickSnapshot,
    curr: TickSnapshot,
    alpha: number,
    gt: number,
    frameDt: number,
    elapsedSec: number,
    opts?: {
      pauseClouds?: boolean;
      hideAmbient?: boolean;
      pauseGrass?: boolean;
      pauseWaterfall?: boolean;
      skipRender?: boolean;
      cameraPose?: CinematicCameraPose | null;
    },
  ): ProjectedNameplate[] {
    this.elapsedSec = elapsedSec;
    const out: ProjectedNameplate[] = [];
    if (!this.arena) return out;

    const cinePose = this.applyCameraWithOptionalCinematic(gt * 0.05, frameDt, opts?.cameraPose);

    const movers = this.collectArenaMovers(prev, curr, alpha);
    const offFx = this.fx;
    if (
      this.arena.update(gt, elapsedSec, {
        pauseClouds: opts?.pauseClouds,
        hideAmbient: opts?.hideAmbient,
        pauseGrass: opts?.pauseGrass,
        pauseWaterfall: opts?.pauseWaterfall,
        freezeCollapseAtTick: curr.over ? curr.t : undefined,
        movers,
        onCollapseDust:
          this.graphicsQuality === 'high' && offFx
            ? (cx, cy, cz, count, spread, size, alpha0, riseVy) =>
                offFx.spawnCollapseDust(cx, cy, cz, elapsedSec, count, spread, size, alpha0, riseVy)
            : undefined,
      })
    ) {
      this.shadowMapDirty = true;
    }

    if (cinePose && cinePose.blend > 0.01) {
      this._focusVec.set(cinePose.lookAt.x, cinePose.lookAt.y, cinePose.lookAt.z);
      this.arena.updateCloseupOcclusion(this.camera.position, this._focusVec, cinePose.blend, frameDt);
    } else {
      this._focusVec.set(this.camTargetX, 0, this.camTargetZ);
      this.arena.updateCloseupOcclusion(this.camera.position, this._focusVec, 0, frameDt);
    }

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
        curr.t,
        curr.winner === k,
        curr.over,
        false,
        inGrassStealth,
        onGround,
        frameDt,
        cinePose?.winnerFaceYaw,
        !currP.alive ? this.makeDeathEffectCallbacks(k, elapsedSec) : undefined,
      );

      if (!currP.alive) {
        out.push({ seat: k, x: 0, y: 0, visible: false, opacity: 0, inGrassStealth: false });
      } else {
        this._projVec.set(interpXMm / 1000, 1.52, interpYMm / 1000);
        this._projVec.project(this.camera);
        const behindCam = this._projVec.z > 1.0 || this._projVec.z < -1.0;
        const winFade =
          curr.over && curr.winner === k && cinePose
            ? Math.max(0, 1 - cinePose.winnerBlend * 1.4)
            : 1;
        const finalOp = behindCam ? 0 : (inGrassStealth ? 0.56 : 0.96) * winFade;
        out.push({
          seat: k,
          x: (this._projVec.x * 0.5 + 0.5) * screenW,
          y: (-this._projVec.y * 0.5 + 0.5) * screenH,
          visible: finalOp > 0.02,
          opacity: finalOp,
          inGrassStealth,
        });
      }
    }

    this.maybeEmitWinnerConfetti(curr, cinePose, elapsedSec, gt);

    if (this.fx) {
      this.fx.update(elapsedSec, prev, curr, alpha, -1, 0, 0, false);
    }

    if (!opts?.skipRender) {
      this.flushShadowMapIfDirty();
      this.renderer.render(this.scene, this.camera);
    }
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
    this.nameplateEyeEls = [];
    this.nameplateEyeStates = [];
    this.activeMapData = null;
    this.prevState = null;
    this.currState = null;
    this.playbackPaused = false;
    this.pausedAlpha = 1.0;
    this.overElapsedSimSec = 0;
    this.overElapsedRealSec = 0;
    this.nextWinnerRibbonSec = -1;
    this.winnerRibbonWave = 0;
    this.pendingEndConfetti = null;
    this.cinematicDirector = null;
    this.wasOnWarnTile = false;
    this.nextCrumbleAtMs = 0;
  }
}
