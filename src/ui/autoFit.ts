/**
 * Mobile "no vertical scrolling" helper: for each registered screen, finds the largest CSS zoom
 * (≤ 1) that makes its scroll container stop overflowing, so the whole screen is visible at once.
 * Layout tightening is done in CSS first; this only scales what still doesn't fit.
 */
export interface FitRule {
  /** Element whose subtree changes should trigger a refit (also used for visibility checks). */
  root: HTMLElement;
  /** The element that must not overflow vertically (fixed height, overflow auto/hidden). */
  scroll: () => HTMLElement | null;
  /** Elements that receive the zoom (often the scroll container's content). */
  targets: () => HTMLElement[];
  minZoom?: number;
}

function isShown(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && !el.classList.contains('hidden');
}

export function fitZoom(scroll: HTMLElement, targets: HTMLElement[], minZoom = 0.5): number {
  const apply = (z: number) => {
    const v = z >= 0.999 ? '' : z.toFixed(3);
    for (const t of targets) t.style.zoom = v;
  };
  const fits = () => scroll.scrollHeight <= scroll.clientHeight + 1;
  apply(1);
  if (fits()) return 1;
  let lo = minZoom;
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) / 2;
    apply(mid);
    if (fits()) lo = mid;
    else hi = mid;
  }
  apply(lo);
  return lo;
}

export class AutoFitter {
  private readonly rules: FitRule[] = [];
  private raf = 0;
  private readonly enabled: () => boolean;

  constructor(enabled: () => boolean) {
    this.enabled = enabled;
    window.addEventListener('resize', () => this.schedule());
  }

  public add(rule: FitRule) {
    this.rules.push(rule);
    // Zoom writes only touch `style`, which isn't observed, so fitting never retriggers itself
    const mo = new MutationObserver(() => this.schedule());
    mo.observe(rule.root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
    this.schedule();
  }

  public schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.runAll();
    });
  }

  private runAll() {
    if (document.body.classList.contains('is-dnd-dragging')) return;
    const on = this.enabled();
    for (const r of this.rules) {
      const targets = r.targets();
      if (!on) {
        for (const t of targets) t.style.zoom = '';
        continue;
      }
      const scroll = r.scroll();
      if (!scroll || !isShown(r.root) || !isShown(scroll)) continue;
      fitZoom(scroll, targets, r.minZoom ?? 0.5);
    }
  }
}
