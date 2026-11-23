export type FpsCapOption = 'vsync' | 60 | 120 | 144 | 240 | 360 | 'uncapped';
export type ExportResolutionOption = '480p' | '720p' | '1080p' | '1440p';
export type ExportBitrateOption = 2 | 4 | 8 | 12;
export type ExportSpeedOption = 0.5 | 1.0 | 1.5 | 2.0;

export type ActionBindKey =
  | 'moveUp'
  | 'moveDown'
  | 'moveLeft'
  | 'moveRight'
  | 'throwRecall'
  | 'melee'
  | 'dash'
  | 'dashToMouse'
  | 'quickRestart';

export type KeySlotPair = [string | null, string | null];
export type KeyBindings = Record<ActionBindKey, KeySlotPair>;

export interface GameSettings {
  soundEnabled: boolean;
  volume: number; // 0..100
  fpsCap: FpsCapOption;
  dashInputBuffer: boolean; // Buffer throw/melee during dash without interrupting dash
  exportResolution: ExportResolutionOption;
  exportBitrateMbps: ExportBitrateOption;
  exportSpeed: ExportSpeedOption;
  keybindings: KeyBindings;
}

export interface ActionMeta {
  key: ActionBindKey;
  label: string;
  group: '移动' | '战斗' | '快捷';
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
];

export const FPS_CAP_OPTIONS: { value: FpsCapOption; label: string; desc: string }[] = [
  { value: 'vsync', label: 'VSync', desc: '跟随屏幕刷新率' },
  { value: 60, label: '60 Hz', desc: '省电稳定' },
  { value: 120, label: '120 Hz', desc: '高刷流畅' },
  { value: 144, label: '144 Hz', desc: '电竞高刷' },
  { value: 240, label: '240 Hz', desc: '超低延迟' },
  { value: 360, label: '360 Hz', desc: '极限帧率' },
  { value: 'uncapped', label: '240Hz+ 解锁', desc: '突破 VSync (~260Hz)' },
];

export const EXPORT_RESOLUTION_OPTIONS: {
  value: ExportResolutionOption;
  label: string;
  width: number;
  height: number;
  desc: string;
}[] = [
  { value: '480p', label: '480p', width: 854, height: 480, desc: '854×480 · 极小体积' },
  { value: '720p', label: '720p', width: 1280, height: 720, desc: '1280×720 · 适合 Web 分享' },
  { value: '1080p', label: '1080p', width: 1920, height: 1080, desc: '1920×1080 · 全高清' },
  { value: '1440p', label: '1440p', width: 2560, height: 1440, desc: '2560×1440 · 2K 超清' },
];

export const EXPORT_BITRATE_OPTIONS: { value: ExportBitrateOption; label: string; desc: string }[] = [
  { value: 2, label: '2 Mbps', desc: '超轻量' },
  { value: 4, label: '4 Mbps', desc: '推荐 · 均衡清晰' },
  { value: 8, label: '8 Mbps', desc: '高清晰度' },
  { value: 12, label: '12 Mbps', desc: '极致画质' },
];

export const EXPORT_SPEED_OPTIONS: { value: ExportSpeedOption; label: string }[] = [
  { value: 0.5, label: '0.5x' },
  { value: 1.0, label: '1x' },
  { value: 1.5, label: '1.5x' },
  { value: 2.0, label: '2x' },
];

export function getExportResolutionSpec(res: ExportResolutionOption) {
  return EXPORT_RESOLUTION_OPTIONS.find((o) => o.value === res) || EXPORT_RESOLUTION_OPTIONS[1];
}

export function cloneDefaultKeybindings(): KeyBindings {
  return {
    moveUp: ['KeyW', 'ArrowUp'],
    moveDown: ['KeyS', 'ArrowDown'],
    moveLeft: ['KeyA', 'ArrowLeft'],
    moveRight: ['KeyD', 'ArrowRight'],
    throwRecall: ['Mouse0', null],
    melee: ['Mouse2', null],
    dash: ['ShiftLeft', 'ShiftRight'],
    dashToMouse: [null, null],
    quickRestart: ['KeyR', null],
  };
}

export function defaultSettings(): GameSettings {
  return {
    soundEnabled: true,
    volume: 100,
    fpsCap: 'vsync',
    dashInputBuffer: true,
    exportResolution: '720p',
    exportBitrateMbps: 4,
    exportSpeed: 1.0,
    keybindings: cloneDefaultKeybindings(),
  };
}

const VALID_FPS_CAPS = new Set<FpsCapOption>(['vsync', 60, 120, 144, 240, 360, 'uncapped']);
const VALID_EXPORT_RES = new Set<ExportResolutionOption>(['480p', '720p', '1080p', '1440p']);
const VALID_EXPORT_BITRATES = new Set<ExportBitrateOption>([2, 4, 8, 12]);
const VALID_EXPORT_SPEEDS = new Set<ExportSpeedOption>([0.5, 1.0, 1.5, 2.0]);
const STORAGE_KEY = 'boomerang_arena_settings_v1';

/**
 * Format an input code (KeyboardEvent.code or "Mouse0".."Mouse4") into a crisp Chinese/keycap label.
 */
export function formatInputCode(code: string | null, compact = false): string {
  if (!code) return '未设置';
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
      const parsed = JSON.parse(raw) as Partial<GameSettings>;
      const soundEnabled = typeof parsed.soundEnabled === 'boolean' ? parsed.soundEnabled : def.soundEnabled;
      const volume =
        typeof parsed.volume === 'number' && Number.isFinite(parsed.volume)
          ? Math.max(0, Math.min(100, Math.round(parsed.volume)))
          : def.volume;
      const fpsCap: FpsCapOption =
        parsed.fpsCap !== undefined && VALID_FPS_CAPS.has(parsed.fpsCap) ? parsed.fpsCap : def.fpsCap;
      const dashInputBuffer =
        typeof parsed.dashInputBuffer === 'boolean' ? parsed.dashInputBuffer : def.dashInputBuffer;
      const exportResolution: ExportResolutionOption =
        parsed.exportResolution !== undefined && VALID_EXPORT_RES.has(parsed.exportResolution)
          ? parsed.exportResolution
          : def.exportResolution;
      const exportBitrateMbps: ExportBitrateOption =
        parsed.exportBitrateMbps !== undefined && VALID_EXPORT_BITRATES.has(parsed.exportBitrateMbps)
          ? parsed.exportBitrateMbps
          : def.exportBitrateMbps;
      const exportSpeed: ExportSpeedOption =
        parsed.exportSpeed !== undefined && VALID_EXPORT_SPEEDS.has(parsed.exportSpeed)
          ? parsed.exportSpeed
          : def.exportSpeed;

      const kb = cloneDefaultKeybindings();
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
      return {
        soundEnabled,
        volume,
        fpsCap,
        dashInputBuffer,
        exportResolution,
        exportBitrateMbps,
        exportSpeed,
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

  public setFpsCap(cap: FpsCapOption) {
    if (!VALID_FPS_CAPS.has(cap) || this.settings.fpsCap === cap) return;
    this.settings.fpsCap = cap;
    this.emit();
  }

  public setDashInputBuffer(enabled: boolean) {
    if (this.settings.dashInputBuffer === enabled) return;
    this.settings.dashInputBuffer = enabled;
    this.emit();
  }

  public setExportResolution(res: ExportResolutionOption) {
    if (!VALID_EXPORT_RES.has(res) || this.settings.exportResolution === res) return;
    this.settings.exportResolution = res;
    this.emit();
  }

  public setExportBitrateMbps(mbps: ExportBitrateOption) {
    if (!VALID_EXPORT_BITRATES.has(mbps) || this.settings.exportBitrateMbps === mbps) return;
    this.settings.exportBitrateMbps = mbps;
    this.emit();
  }

  public setExportSpeed(speed: ExportSpeedOption) {
    if (!VALID_EXPORT_SPEEDS.has(speed) || this.settings.exportSpeed === speed) return;
    this.settings.exportSpeed = speed;
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
