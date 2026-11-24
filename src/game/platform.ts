import { PlatformPref, SettingsStore } from './settings';
import { isForcedLandscape, setForcedLandscape } from './viewport';

type PlatformListener = (isMobile: boolean) => void;

interface FullscreenCapableElement extends HTMLElement {
  webkitRequestFullscreen?: (opts?: FullscreenOptions) => Promise<void> | void;
}

interface FullscreenCapableDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
}

interface LockableOrientation extends ScreenOrientation {
  lock?: (orientation: 'landscape' | 'portrait' | 'any') => Promise<void>;
}

/** True when the device's primary pointer is a finger (phones / tablets). */
export function detectTouchPrimary(): boolean {
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
    return (navigator.maxTouchPoints || 0) > 0 && !window.matchMedia('(hover: hover)').matches;
  } catch {
    return (navigator.maxTouchPoints || 0) > 0;
  }
}

/**
 * Resolves PC vs. mobile presentation:
 * - `auto` follows the detected primary input device, and re-evaluates on the first real
 *   touch / mouse press while switching is allowed (only in the lobby, never mid-match).
 * - `mobile` / `desktop` are manual overrides chosen from the lobby toggle button.
 * Toggles `body.is-mobile` so all mobile CSS can key off one class.
 */
export class PlatformManager {
  private readonly settings: SettingsStore;
  private readonly listeners = new Set<PlatformListener>();
  private autoGuess: boolean;
  private mobile: boolean;
  private autoSwitchAllowed = true;
  private userExitedFullscreen = false;
  /** Touch devices start on the launch page; landscape forcing waits until the player picks a mode. */
  private launchDone = !detectTouchPrimary();

  constructor(settings: SettingsStore) {
    this.settings = settings;
    this.autoGuess = detectTouchPrimary();
    this.mobile = this.resolve(settings.get().platformMode);
    this.applyBodyClass();

    settings.onChange((s) => {
      this.setMobile(this.resolve(s.platformMode));
    });

    // Auto mode: follow the input device actually being used (lobby only)
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch' && e.pointerType !== 'mouse') return;
        const isTouch = e.pointerType === 'touch';
        if (isTouch === this.autoGuess) return;
        if (!this.autoSwitchAllowed) return;
        this.autoGuess = isTouch;
        if (this.settings.get().platformMode === 'auto') {
          this.setMobile(this.resolve('auto'));
        }
      },
      { capture: true, passive: true },
    );

    // Immersive mode: every tap in mobile mode (re)enters fullscreen + landscape lock unless the
    // player explicitly left fullscreen through our own toggle button.
    // (Desktop browsers switched to mobile mode by hand only go fullscreen via the lobby button.)
    const onGesture = () => {
      if (!this.launchDone || !this.mobile || !this.autoGuess || this.userExitedFullscreen || this.isFullscreen()) return;
      void this.enterImmersive();
    };
    window.addEventListener('touchend', onGesture, { capture: true, passive: true });
    window.addEventListener('click', onGesture, { capture: true, passive: true });

    // Keep the CSS landscape fallback in sync with the physical orientation (registered before the
    // renderer's own resize listener, so it always reads the updated logical viewport)
    const onViewportChange = () => this.updateOrientation();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);
    this.updateOrientation();
  }

  /**
   * Mobile mode is landscape-only. Where the OS keeps the page upright (iOS Safari, a failed or
   * unsupported orientation lock), the whole app is rotated 90° with CSS instead of asking the
   * player to turn the phone and tap again.
   */
  public updateOrientation() {
    const want = this.mobile && this.launchDone && window.innerHeight > window.innerWidth;
    const was = isForcedLandscape();
    setForcedLandscape(want);
    if (want !== was) {
      // Logical viewport flipped without a real resize: let canvas / HUD / controls re-layout
      window.dispatchEvent(new Event('resize'));
    }
  }

  public isLaunchDone(): boolean {
    return this.launchDone;
  }

  /**
   * Launch page choice (must run inside the tap handler so fullscreen / orientation lock are allowed).
   * Mobile: pin mobile mode, go fullscreen + lock landscape (Android rotates by itself); anything the
   * browser refuses falls back to the CSS rotation. Desktop: pin desktop mode, no fullscreen.
   */
  public async launch(choice: 'mobile' | 'desktop'): Promise<void> {
    this.settings.setPlatformMode(choice);
    if (choice === 'mobile') {
      await Promise.race([this.enterImmersive(), new Promise((r) => window.setTimeout(r, 900))]);
    }
    this.launchDone = true;
    this.updateOrientation();
  }

  private resolve(pref: PlatformPref): boolean {
    if (pref === 'mobile') return true;
    if (pref === 'desktop') return false;
    return this.autoGuess;
  }

  private applyBodyClass() {
    document.body.classList.toggle('is-mobile', this.mobile);
    document.documentElement.classList.toggle('is-mobile', this.mobile);
  }

  private setMobile(next: boolean) {
    if (next === this.mobile) return;
    this.mobile = next;
    this.applyBodyClass();
    this.updateOrientation();
    for (const fn of this.listeners) fn(next);
  }

  public isMobile(): boolean {
    return this.mobile;
  }

  public getPreference(): PlatformPref {
    return this.settings.get().platformMode;
  }

  /** Manual toggle from the lobby button: flips the CURRENT presentation and pins it. */
  public toggle() {
    this.settings.setPlatformMode(this.mobile ? 'desktop' : 'mobile');
  }

  public setAutoSwitchAllowed(allowed: boolean) {
    this.autoSwitchAllowed = allowed;
  }

  public onChange(fn: PlatformListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- Fullscreen & orientation ----------

  public isFullscreenSupported(): boolean {
    const d = document as FullscreenCapableDocument;
    const el = document.documentElement as FullscreenCapableElement;
    return Boolean(
      (d.fullscreenEnabled || d.webkitFullscreenEnabled) && (el.requestFullscreen || el.webkitRequestFullscreen),
    );
  }

  public isFullscreen(): boolean {
    const d = document as FullscreenCapableDocument;
    return Boolean(d.fullscreenElement || d.webkitFullscreenElement) || this.isStandaloneApp();
  }

  /** Launched from the home screen (PWA): already chrome-less, nothing to request. */
  public isStandaloneApp(): boolean {
    try {
      return (
        window.matchMedia('(display-mode: fullscreen)').matches ||
        window.matchMedia('(display-mode: standalone)').matches ||
        Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
      );
    } catch {
      return false;
    }
  }

  /** Must be called from inside a user gesture. Resolves true when fullscreen was entered. */
  public async enterImmersive(): Promise<boolean> {
    this.userExitedFullscreen = false;
    if (this.isFullscreen()) {
      await this.lockLandscape();
      return true;
    }
    const el = document.documentElement as FullscreenCapableElement;
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen({ navigationUI: 'hide' });
      } else if (el.webkitRequestFullscreen) {
        await el.webkitRequestFullscreen();
      } else {
        return false;
      }
    } catch {
      return false;
    }
    await this.lockLandscape();
    return this.isFullscreen();
  }

  public async exitImmersive() {
    this.userExitedFullscreen = true;
    const d = document as FullscreenCapableDocument;
    try {
      if (d.fullscreenElement && d.exitFullscreen) await d.exitFullscreen();
      else if (d.webkitFullscreenElement && d.webkitExitFullscreen) await d.webkitExitFullscreen();
    } catch {
      // ignore
    }
  }

  private async lockLandscape() {
    const orientation = screen.orientation as LockableOrientation | undefined;
    if (!orientation?.lock) return;
    try {
      await orientation.lock('landscape');
    } catch {
      // Not supported (e.g. iOS Safari) — the CSS rotate hint covers portrait instead.
    }
  }

  public isPortrait(): boolean {
    return window.innerHeight > window.innerWidth;
  }
}
