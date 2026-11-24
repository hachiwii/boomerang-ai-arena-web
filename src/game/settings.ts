export type GraphicsQualityOption = 'low' | 'high';
export type SlashJudgmentOption = 'normal' | 'strict' | 'ai';
export type ExportResolutionOption = '480p' | '720p' | '1080p' | '2k' | '4k';
export type ExportBitrateOption = number;
export type ExportSpeedOption = number;

export type ActionBindKey =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'throwRecall'
  | 'melee'
  | 'dash'
  | 'dashToMouse'
  | 'quickRestart'
  | 'toggleHideUi';

export type KeySlotPair = [string | null, string | null];
export type KeyBindings = Record<ActionBindKey, KeySlotPair>;

export interface CinematicOptions {
  killCam: boolean; // Non-final kills (0.5x slow-mo + eye-level camera)
  finisherCam: boolean; // Final kill (0.25x slow-mo + eye-level camera)
  winnerCam: boolean; // Winner front close-up + periodic confetti shower
}

/** 'auto' follows the detected primary input device (touch → mobile); otherwise a manual override. */
export type PlatformPref = 'auto' | 'mobile' | 'desktop';

export type MobileControlKey = 'move' | 'aim' | 'slash' | 'dash';

/**
 * One on-screen touch control, anchored to the left or right edge of the landscape viewport.
 * All values are in units of viewport HEIGHT so the cluster keeps its shape across aspect ratios:
 * - x: distance from the anchored side edge to the control center
 * - y: distance from the bottom edge to the control center
 * - s: control diameter
 */
export interface MobileControlSpot {
  side: 'l' | 'r';
  x: number;
  y: number;
  s: number;
}

export type MobileLayout = Record<MobileControlKey, MobileControlSpot>;

export const MOBILE_CONTROL_KEYS: MobileControlKey[] = ['move', 'aim', 'slash', 'dash'];

export const MOBILE_CONTROL_LABELS: Record<MobileControlKey, string> = {
  move: '移动',
  aim: '瞄准 / 召回',
  slash: '挥砍',
  dash: '冲刺',
};

export const MOBILE_CONTROL_SIZE_LIMITS: Record<MobileControlKey, [number, number]> = {
  move: [0.22, 0.62],
  aim: [0.2, 0.56],
  slash: [0.1, 0.32],
  dash: [0.1, 0.32],
};

export function cloneDefaultMobileLayout(): MobileLayout {
  return {
    move: { side: 'l', x: 0.3, y: 0.3, s: 0.4 },
    aim: { side: 'r', x: 0.24, y: 0.3, s: 0.36 },
    slash: { side: 'r', x: 0.2, y: 0.63, s: 0.17 },
    dash: { side: 'r', x: 0.57, y: 0.26, s: 0.17 },
  };
}

/** Previous built-in defaults: players who never customised get upgraded to the new defaults. */
const LEGACY_DEFAULT_MOBILE_LAYOUTS: MobileLayout[] = [
  {
    move: { side: 'l', x: 0.3, y: 0.3, s: 0.4 },
    aim: { side: 'r', x: 0.3, y: 0.3, s: 0.36 },
    slash: { side: 'r', x: 0.35, y: 0.63, s: 0.17 },
    dash: { side: 'r', x: 0.63, y: 0.26, s: 0.17 },
  },
];

function isSameMobileLayout(a: MobileLayout, b: MobileLayout): boolean {
  return MOBILE_CONTROL_KEYS.every((k) => {
    const p = a[k];
    const q = b[k];
    return p.side === q.side && Math.abs(p.x - q.x) < 1e-6 && Math.abs(p.y - q.y) < 1e-6 && Math.abs(p.s - q.s) < 1e-6;
  });
}

function sanitizeMobileLayout(raw: unknown): MobileLayout {
  const def = cloneDefaultMobileLayout();
  if (!raw || typeof raw !== 'object') return def;
  const parsed = sanitizeMobileLayoutEntries(raw);
  return LEGACY_DEFAULT_MOBILE_LAYOUTS.some((old) => isSameMobileLayout(parsed, old)) ? def : parsed;
}

function sanitizeMobileLayoutEntries(raw: object): MobileLayout {
  const def = cloneDefaultMobileLayout();
  const src = raw as Record<string, unknown>;
  for (const key of MOBILE_CONTROL_KEYS) {
    const e = src[key] as Partial<MobileControlSpot> | undefined;
    if (!e || typeof e !== 'object') continue;
    const [sMin, sMax] = MOBILE_CONTROL_SIZE_LIMITS[key];
    const num = (v: unknown, lo: number, hi: number, fb: number) =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fb;
    def[key] = {
      side: e.side === 'l' || e.side === 'r' ? e.side : def[key].side,
      x: num(e.x, 0, 3, def[key].x),
      y: num(e.y, 0, 1, def[key].y),
      s: num(e.s, sMin, sMax, def[key].s),
    };
  }
  return def;
}

export interface GameSettings {
  platformMode: PlatformPref;
  mobileLayout: MobileLayout;
  soundEnabled: boolean;
  volume: number; // 0..100
  bgmEnabled: boolean;
  bgmVolume: number; // 0..100
  bossMusicEnabled: boolean;
  graphicsQuality: GraphicsQualityOption; // 'low' = lightweight instanced, 'high' = faithful open-source art
  lockFps: boolean; // true = monitor refresh rate (VSync), false = uncapped
  dashInputBuffer: boolean; // Buffer throw/melee during dash without interrupting dash
  meleeAssist: boolean; // Auto-rotate slash/kick aim minimally to include reachable target when mouse cone misses
  cliffGuard: boolean; // Prevent walking off cliffs
  dashGuard: boolean; // Dash-tail 25% cliff save
  slashJudgment: SlashJudgmentOption; // 'normal' (5f) | 'strict' (3f) | 'ai' (windup + 1f)
  killCam: boolean; // Non-final kill slow-mo & eye-level camera (0.5x)
  finisherCam: boolean; // Final kill slow-mo & eye-level camera (0.25x)
  winnerCam: boolean; // Winner front close-up & periodic confetti shower
  exportResolution: ExportResolutionOption;
  exportBitrateMbps: ExportBitrateOption;
  exportSpeed: ExportSpeedOption;
  exportSoundEnabled: boolean;
  exportBgmEnabled: boolean;
  keybindings: KeyBindings;
}

export function getCinematicOptions(s: GameSettings): CinematicOptions {
  return {
    killCam: s.killCam,
    finisherCam: s.finisherCam,
    winnerCam: s.winnerCam,
  };
}

export interface ActionMeta {
  key: ActionBindKey;
  label: string;
  group: '移动' | '战斗' | '快捷';
  allowCombo?: boolean;
}

export const ACTION_META: ActionMeta[] = [
  { key: 'moveUp', label: '向上移动', group: '移动' },
  { key: 'moveDown', label: '向下移动', group: '移动' },
  { key: 'moveLeft', label: '向左移动', group: '移动' },
  { key: 'moveRight', label: '向右移动', group: '移动' },
  { key: 'throwRecall', label: '扔镖 / 长按召回', group: '战斗' },
  { key: 'melee', label: '挥砍 / 空手踢人', group: '战斗' },
  { key: 'dash', label: '冲刺', group: '战斗' },
  { key: 'dashToMouse', label: '向鼠标方向冲刺', group: '战斗' },
  { key: 'quickRestart', label: '重开 / 重新匹配', group: '快捷' },
  { key: 'toggleHideUi', label: '隐藏 / 显示界面', group: '快捷', allowCombo: true },
];

export const GRAPHICS_QUALITY_OPTIONS: { value: GraphicsQualityOption; label: string }[] = [
  { value: 'low', label: '低' },
  { value: 'high', label: '高' },
];

export const SLASH_JUDGMENT_OPTIONS: {
  value: SlashJudgmentOption;
  label: string;
  ticks: number;
  desc: string;
}[] = [
  { value: 'normal', label: '普通', ticks: 5, desc: '按下即生效，持续前 5 帧判定' },
  { value: 'strict', label: '严格', ticks: 3, desc: '按下即生效，仅前 3 帧判定' },
  { value: 'ai', label: 'AI', ticks: 0, desc: '与 AI 完全相同：有前摇，仅 1 帧判定' },
];

export function getSlashJudgmentTicks(mode: SlashJudgmentOption): number {
  return SLASH_JUDGMENT_OPTIONS.find((o) => o.value === mode)?.ticks ?? 5;
}

export function getSlashJudgmentDesc(mode: SlashJudgmentOption): string {
  return SLASH_JUDGMENT_OPTIONS.find((o) => o.value === mode)?.desc ?? SLASH_JUDGMENT_OPTIONS[0].desc;
}

export const EXPORT_RESOLUTION_OPTIONS: {
  value: ExportResolutionOption;
  label: string;
  width: number;
  height: number;
  desc: string;
}[] = [
  { value: '480p', label: '480p', width: 854, height: 480, desc: '854×480 · 极小体积' },
  { value: '720p', label: '720p', width: 1280, height: 720, desc: '1280×720 · 高清轻量' },
  { value: '1080p', label: '1080p', width: 1920, height: 1080, desc: '1920×1080 · 全高清推荐' },
  { value: '2k', label: '2K', width: 2560, height: 1440, desc: '2560×1440 · 2K 超清' },
  { value: '4k', label: '4K', width: 3840, height: 2160, desc: '3840×2160 · 4K 极致' },
];

export const EXPORT_BITRATE_MIN = 4;
export const EXPORT_BITRATE_MAX = 50;
export const EXPORT_BITRATE_TICKS: readonly number[] = [4, 10, 20, 35, 50];

export const EXPORT_SPEED_MIN = 0.1;
export const EXPORT_SPEED_MAX = 2.0;
export const EXPORT_SPEED_STEP = 0.1;
export const EXPORT_SPEED_TICKS: readonly number[] = [0.1, 0.5, 1.0, 1.5, 2.0];

export function clampExportBitrateMbps(mbps: number): number {
  if (!Number.isFinite(mbps)) return 4;
  return Math.max(EXPORT_BITRATE_MIN, Math.min(EXPORT_BITRATE_MAX, Math.round(mbps)));
}

export function clampExportSpeed(speed: number): number {
  if (!Number.isFinite(speed)) return 1.0;
  return Math.round(Math.max(EXPORT_SPEED_MIN, Math.min(EXPORT_SPEED_MAX, speed)) * 10) / 10;
}

export function getExportResolutionSpec(res: ExportResolutionOption) {
  return EXPORT_RESOLUTION_OPTIONS.find((o) => o.value === res) || EXPORT_RESOLUTION_OPTIONS[2];
}

export function formatExportPresetLabel(s: GameSettings): string {
  const resLabel = getExportResolutionSpec(s.exportResolution).label;
  const spd = `${clampExportSpeed(s.exportSpeed).toFixed(1)}x`;
  const audioTag =
    s.exportSoundEnabled && s.exportBgmEnabled
      ? ''
      : s.exportSoundEnabled
        ? ' · 仅音效'
        : s.exportBgmEnabled
          ? ' · 仅 BGM'
          : ' · 静音';
  return `${resLabel} · ${s.exportBitrateMbps} Mbps · ${spd}${audioTag}`;
}

export function cloneDefaultKeybindings(): KeyBindings {
  return {
    moveUp: ['KeyW', 'ArrowUp'],
    moveDown: ['KeyS', 'ArrowDown'],
    moveLeft: ['KeyA', 'ArrowLeft'],
    moveRight: ['KeyD', 'ArrowRight'],
    throwRecall: ['Mouse0', null],
    melee: ['Mouse2', null],
    dash: ['ShiftLeft', 'Space'],
    dashToMouse: [null, null],
    quickRestart: ['KeyR', null],
    toggleHideUi: ['Shift+KeyF', null],
  };
}

export function defaultSettings(): GameSettings {
  return {
    platformMode: 'auto',
    mobileLayout: cloneDefaultMobileLayout(),
    soundEnabled: true,
    volume: 100,
    bgmEnabled: true,
    bgmVolume: 70,
    bossMusicEnabled: true,
    graphicsQuality: 'high',
    lockFps: true,
    dashInputBuffer: true,
    meleeAssist: true,
    cliffGuard: true,
    dashGuard: true,
    slashJudgment: 'normal',
    killCam: true,
    finisherCam: true,
    winnerCam: true,
    exportResolution: '1080p',
    exportBitrateMbps: 4,
    exportSpeed: 1.0,
    exportSoundEnabled: true,
    exportBgmEnabled: true,
    keybindings: cloneDefaultKeybindings(),
  };
}

const VALID_GRAPHICS_QUALITY = new Set<GraphicsQualityOption>(['low', 'high']);
const VALID_SLASH_JUDGMENT = new Set<SlashJudgmentOption>(['normal', 'strict', 'ai']);
const VALID_EXPORT_RES = new Set<ExportResolutionOption>(['480p', '720p', '1080p', '2k', '4k']);
const STORAGE_KEY = 'boomerang_arena_settings_v1';

const MODIFIER_KEY_CODES = new Set<string>([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

export function isModifierKeyCode(code: string): boolean {
  return MODIFIER_KEY_CODES.has(code);
}

/**
 * Encodes a KeyboardEvent into a canonical binding string, supporting modifier
 * combinations such as "Shift+KeyF", "Ctrl+Shift+KeyH", or plain key codes.
 */
export function encodeKeyEventCombo(e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string {
  if (isModifierKeyCode(e.code)) return e.code;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  parts.push(e.code);
  return parts.join('+');
}

/**
 * Format an input code (KeyboardEvent.code, modifier combo like "Shift+KeyF",
 * or "Mouse0".."Mouse4") into a crisp Chinese/keycap label.
 */
export function formatInputCode(code: string | null, compact = false): string {
  if (!code) return '未设置';
  if (code.includes('+')) {
    const parts = code.split('+').filter(Boolean);
    if (parts.length >= 2) {
      const base = parts[parts.length - 1];
      const mods = parts.slice(0, -1).map((m) => (m === 'Meta' ? 'Meta' : m));
      const sep = compact ? '+' : ' + ';
      return [...mods, formatInputCode(base, true)].join(sep);
    }
  }
  if (code === 'Mouse0') return compact ? '左键' : '鼠标左键';
  if (code === 'Mouse1') return compact ? '中键' : '鼠标中键';
  if (code === 'Mouse2') return compact ? '右键' : '鼠标右键';
  if (code === 'Mouse3') return compact ? '侧键4' : '鼠标侧键 4';
  if (code === 'Mouse4') return compact ? '侧键5' : '鼠标侧键 5';
  if (code.startsWith('Mouse')) return `鼠标键 ${code.slice(5)}`;

  if (code.startsWith('Key') && code.length === 4) return code[3];
  if (code.startsWith('Digit') && code.length === 6) return code[5];
  if (code.startsWith('Numpad')) return `小键盘 ${code.slice(6)}`;

  const map: Record<string, string> = {
    Space: '空格',
    ShiftLeft: compact ? 'Shift' : '左 Shift',
    ShiftRight: compact ? 'R-Shift' : '右 Shift',
    ControlLeft: compact ? 'Ctrl' : '左 Ctrl',
    ControlRight: compact ? 'R-Ctrl' : '右 Ctrl',
    AltLeft: compact ? 'Alt' : '左 Alt',
    AltRight: compact ? 'R-Alt' : '右 Alt',
    Tab: 'Tab',
    Enter: 'Enter',
    CapsLock: 'Caps',
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
  };
  return map[code] || code;
}

/**
 * Short display label for HUD/legend pills (prefers slot 0, falls back to slot 1).
 */
export function formatPrimaryBind(pair: KeySlotPair, fallback = '未绑定'): string {
  const primary = pair[0] || pair[1];
  return primary ? formatInputCode(primary, true) : fallback;
}

export function formatDashSummary(kb: KeyBindings): string {
  const moveDash = formatPrimaryBind(kb.dash, '');
  const mouseDash = formatPrimaryBind(kb.dashToMouse, '');
  if (moveDash && mouseDash) return `${moveDash} / ${mouseDash}`;
  return moveDash || mouseDash || '未绑定';
}

/**
 * Compact movement key summary (e.g. "WASD" when default, or "I/K/J/L" when rebound).
 */
export function formatMoveSummary(kb: KeyBindings): string {
  const u = formatPrimaryBind(kb.moveUp, '?');
  const l = formatPrimaryBind(kb.moveLeft, '?');
  const d = formatPrimaryBind(kb.moveDown, '?');
  const r = formatPrimaryBind(kb.moveRight, '?');
  if (u === 'W' && l === 'A' && d === 'S' && r === 'D') return 'WASD';
  if (u === '↑' && l === '←' && d === '↓' && r === '→') return '方向键';
  if (u.length === 1 && l.length === 1 && d.length === 1 && r.length === 1) {
    return `${u}${l}${d}${r}`;
  }
  return `${u}/${l}/${d}/${r}`;
}

export function isBoundToAction(kb: KeyBindings, action: ActionBindKey, code: string): boolean {
  const pair = kb[action];
  return pair[0] === code || pair[1] === code;
}

export function matchesKeyEventBinding(
  binding: string | null,
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): boolean {
  if (!binding || binding.startsWith('Mouse')) return false;
  if (binding.includes('+')) {
    const parts = binding.split('+').filter(Boolean);
    const baseCode = parts[parts.length - 1];
    if (e.code !== baseCode) return false;
    const mods = new Set(parts.slice(0, -1));
    return (
      e.ctrlKey === mods.has('Ctrl') &&
      e.altKey === mods.has('Alt') &&
      e.shiftKey === mods.has('Shift') &&
      e.metaKey === mods.has('Meta')
    );
  }
  if (isModifierKeyCode(binding)) return e.code === binding;
  return e.code === binding && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
}

export function matchesActionKeyEvent(
  kb: KeyBindings,
  action: ActionBindKey,
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): boolean {
  const pair = kb[action];
  return matchesKeyEventBinding(pair[0], e) || matchesKeyEventBinding(pair[1], e);
}

type SettingsListener = (settings: GameSettings) => void;

export class SettingsStore {
  private settings: GameSettings;
  private listeners = new Set<SettingsListener>();

  constructor() {
    this.settings = this.load();
  }

  private load(): GameSettings {
    const def = defaultSettings();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return def;
      const parsed = JSON.parse(raw) as Partial<GameSettings> & { fpsCap?: unknown };
      const soundEnabled = typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : def.soundEnabled;
      const volume =
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(100, Math.round(parsed.volume)))
          : def.volume;
      const bgmEnabled = typeof parsed.bgmEnabled === 'boolean' ? parsed.bgmEnabled : def.bgmEnabled;
      const bgmVolume =
        typeof parsed.bgmVolume === 'number' && Number.isFinite(parsed.bgmVolume)
          ? Math.max(0, Math.min(100, Math.round(parsed.bgmVolume)))
          : def.bgmVolume;
      const bossMusicEnabled =
        typeof parsed.bossMusicEnabled === 'boolean' ? parsed.bossMusicEnabled : def.bossMusicEnabled;
      const graphicsQuality: GraphicsQualityOption =
        parsed.graphicsQuality !== undefined && VALID_GRAPHICS_QUALITY.has(parsed.graphicsQuality)
          ? parsed.graphicsQuality
          : def.graphicsQuality;
      const lockFps =
        typeof parsed.lockFps === 'boolean'
          ? parsed.lockFps
          : parsed.fpsCap === 'uncapped'
            ? false
            : def.lockFps;
      const dashInputBuffer =
        typeof parsed.dashInputBuffer === 'boolean' ? parsed.dashInputBuffer : def.dashInputBuffer;
      const meleeAssist =
        typeof parsed.meleeAssist === 'boolean' ? parsed.meleeAssist : def.meleeAssist;
      const cliffGuard =
        typeof parsed.cliffGuard === 'boolean' ? parsed.cliffGuard : def.cliffGuard;
      const dashGuard =
        typeof parsed.dashGuard === 'boolean' ? parsed.dashGuard : cliffGuard;
      const slashJudgment: SlashJudgmentOption =
        parsed.slashJudgment !== undefined && VALID_SLASH_JUDGMENT.has(parsed.slashJudgment)
          ? parsed.slashJudgment
          : def.slashJudgment;
      const killCam =
        typeof parsed.killCam === 'boolean' ? parsed.killCam : def.killCam;
      const finisherCam =
        typeof parsed.finisherCam === 'boolean'
          ? parsed.finisherCam
          : typeof parsed.killCam === 'boolean'
            ? parsed.killCam
            : def.finisherCam;
      const winnerCam =
        typeof parsed.winnerCam === 'boolean'
          ? parsed.winnerCam
          : typeof parsed.killCam === 'boolean'
            ? parsed.killCam
            : def.winnerCam;
      const rawExportRes = parsed.exportResolution as string | undefined;
      const migratedRes = rawExportRes === '1440p' ? '2k' : rawExportRes;
      const exportResolution: ExportResolutionOption =
        migratedRes !== undefined && VALID_EXPORT_RES.has(migratedRes as ExportResolutionOption)
          ? (migratedRes as ExportResolutionOption)
          : def.exportResolution;
      const exportBitrateMbps: ExportBitrateOption =
        typeof parsed.exportBitrateMbps === 'number' && Number.isFinite(parsed.exportBitrateMbps)
          ? clampExportBitrateMbps(parsed.exportBitrateMbps)
          : def.exportBitrateMbps;
      const exportSpeed: ExportSpeedOption =
        typeof parsed.exportSpeed === 'number' && Number.isFinite(parsed.exportSpeed)
          ? clampExportSpeed(parsed.exportSpeed)
          : def.exportSpeed;
      const exportSoundEnabled =
        typeof parsed.exportSoundEnabled === 'boolean' ? parsed.exportSoundEnabled : def.exportSoundEnabled;
      const exportBgmEnabled =
        typeof parsed.exportBgmEnabled === 'boolean' ? parsed.exportBgmEnabled : def.exportBgmEnabled;

      const kb = cloneDefaultKeybindings();
      // Preserve legacy ShiftLeft/ShiftRight for existing saved configs that predate an explicit dash entry
      if (!parsed.keybindings || !Array.isArray(parsed.keybindings.dash)) {
        kb.dash = ['ShiftLeft', 'ShiftRight'];
      }
      if (parsed.keybindings && typeof parsed.keybindings === 'object') {
        for (const meta of ACTION_META) {
          const entry = parsed.keybindings[meta.key];
          if (Array.isArray(entry) && entry.length >= 2) {
            const s0 = typeof entry[0] === 'string' && entry[0].length > 0 ? entry[0] : null;
            const s1 = typeof entry[1] === 'string' && entry[1].length > 0 ? entry[1] : null;
            kb[meta.key] = [s0, s1 === s0 ? null : s1];
          }
        }
      }
      const platformMode: PlatformPref =
        parsed.platformMode === 'mobile' || parsed.platformMode === 'desktop' || parsed.platformMode === 'auto'
          ? parsed.platformMode
          : def.platformMode;
      const mobileLayout = sanitizeMobileLayout(parsed.mobileLayout);
      return {
        platformMode,
        mobileLayout,
        soundEnabled,
        volume,
        bgmEnabled,
        bgmVolume,
        bossMusicEnabled,
        graphicsQuality,
        lockFps,
        dashInputBuffer,
        meleeAssist,
        cliffGuard,
        dashGuard,
        slashJudgment,
        killCam,
        finisherCam,
        winnerCam,
        exportResolution,
        exportBitrateMbps,
        exportSpeed,
        exportSoundEnabled,
        exportBgmEnabled,
        keybindings: kb,
      };
    } catch {
      return def;
    }
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Ignore storage errors
    }
  }

  private emit() {
    this.save();
    for (const fn of this.listeners) {
      fn(this.settings);
    }
  }

  public get(): GameSettings {
    return this.settings;
  }

  public onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  public setPlatformMode(mode: PlatformPref) {
    if (this.settings.platformMode === mode) return;
    this.settings.platformMode = mode;
    this.emit();
  }

  public setMobileLayout(layout: MobileLayout) {
    this.settings.mobileLayout = sanitizeMobileLayout(layout);
    this.emit();
  }

  public resetMobileLayout() {
    this.settings.mobileLayout = cloneDefaultMobileLayout();
    this.emit();
  }

  public setSoundEnabled(enabled: boolean) {
    if (this.settings.soundEnabled === enabled) return;
    this.settings.soundEnabled = enabled;
    this.emit();
  }

  public setVolume(volume: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    if (this.settings.volume === clamped) return;
    this.settings.volume = clamped;
    this.emit();
  }

  public setBgmEnabled(enabled: boolean) {
    if (this.settings.bgmEnabled === enabled) return;
    this.settings.bgmEnabled = enabled;
    this.emit();
  }

  public setBgmVolume(volume: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    if (this.settings.bgmVolume === clamped) return;
    this.settings.bgmVolume = clamped;
    this.emit();
  }

  public setBossMusicEnabled(enabled: boolean) {
    if (this.settings.bossMusicEnabled === enabled) return;
    this.settings.bossMusicEnabled = enabled;
    this.emit();
  }

  public setGraphicsQuality(quality: GraphicsQualityOption) {
    if (!VALID_GRAPHICS_QUALITY.has(quality) || this.settings.graphicsQuality === quality) return;
    this.settings.graphicsQuality = quality;
    this.emit();
  }

  public setLockFps(locked: boolean) {
    if (this.settings.lockFps === locked) return;
    this.settings.lockFps = locked;
    this.emit();
  }

  public setDashInputBuffer(enabled: boolean) {
    if (this.settings.dashInputBuffer === enabled) return;
    this.settings.dashInputBuffer = enabled;
    this.emit();
  }

  public setMeleeAssist(enabled: boolean) {
    if (this.settings.meleeAssist === enabled) return;
    this.settings.meleeAssist = enabled;
    this.emit();
  }

  public setCliffGuard(enabled: boolean) {
    if (this.settings.cliffGuard === enabled) return;
    this.settings.cliffGuard = enabled;
    this.emit();
  }

  public setDashGuard(enabled: boolean) {
    if (this.settings.dashGuard === enabled) return;
    this.settings.dashGuard = enabled;
    this.emit();
  }

  public setSlashJudgment(mode: SlashJudgmentOption) {
    if (!VALID_SLASH_JUDGMENT.has(mode) || this.settings.slashJudgment === mode) return;
    this.settings.slashJudgment = mode;
    this.emit();
  }

  public setKillCam(enabled: boolean) {
    if (this.settings.killCam === enabled) return;
    this.settings.killCam = enabled;
    this.emit();
  }

  public setFinisherCam(enabled: boolean) {
    if (this.settings.finisherCam === enabled) return;
    this.settings.finisherCam = enabled;
    this.emit();
  }

  public setWinnerCam(enabled: boolean) {
    if (this.settings.winnerCam === enabled) return;
    this.settings.winnerCam = enabled;
    this.emit();
  }

  public setExportResolution(res: ExportResolutionOption) {
    if (!VALID_EXPORT_RES.has(res) || this.settings.exportResolution === res) return;
    this.settings.exportResolution = res;
    this.emit();
  }

  public setExportBitrateMbps(mbps: ExportBitrateOption) {
    const clamped = clampExportBitrateMbps(mbps);
    if (this.settings.exportBitrateMbps === clamped) return;
    this.settings.exportBitrateMbps = clamped;
    this.emit();
  }

  public setExportSpeed(speed: ExportSpeedOption) {
    const clamped = clampExportSpeed(speed);
    if (this.settings.exportSpeed === clamped) return;
    this.settings.exportSpeed = clamped;
    this.emit();
  }

  public setExportSoundEnabled(enabled: boolean) {
    if (this.settings.exportSoundEnabled === enabled) return;
    this.settings.exportSoundEnabled = enabled;
    this.emit();
  }

  public setExportBgmEnabled(enabled: boolean) {
    if (this.settings.exportBgmEnabled === enabled) return;
    this.settings.exportBgmEnabled = enabled;
    this.emit();
  }

  public setBinding(
    action: ActionBindKey,
    slotIndex: 0 | 1,
    code: string | null,
  ): { clearedFrom?: ActionBindKey } {
    let clearedFrom: ActionBindKey | undefined;

    if (code !== null) {
      // Clear any conflicting binding across all actions (including the sibling slot)
      for (const meta of ACTION_META) {
        const pair = this.settings.keybindings[meta.key];
        for (const idx of [0, 1] as const) {
          if (meta.key === action && idx === slotIndex) continue;
          if (pair[idx] === code) {
            pair[idx] = null;
            if (meta.key !== action) clearedFrom = meta.key;
          }
        }
      }
    }

    this.settings.keybindings[action][slotIndex] = code;
    this.emit();
    return { clearedFrom };
  }

  public resetKeybindings() {
    this.settings.keybindings = cloneDefaultKeybindings();
    this.emit();
  }

  public resetAll() {
    this.settings = defaultSettings();
    this.emit();
  }
}
