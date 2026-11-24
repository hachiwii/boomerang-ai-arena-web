/**
 * Logical (game) viewport. On phones that cannot lock orientation from the web (iOS Safari),
 * mobile mode held in portrait is rendered as landscape by rotating <body> 90° with CSS
 * (`body.force-landscape`). Everything that maps pointer coordinates or reads the viewport
 * size goes through these helpers so it keeps working in both frames.
 *
 * Rotation used: logical (X, Y) → screen (innerWidth − Y, X)   (i.e. translateX(W) rotate(90deg))
 */
let forced = false;

export function isForcedLandscape(): boolean {
  return forced;
}

/** Applies / removes the CSS rotation and keeps the size variables in sync with the screen. */
export function setForcedLandscape(on: boolean) {
  forced = on;
  const b = document.body;
  b.classList.toggle('force-landscape', on);
  if (on) {
    b.style.setProperty('--fl-w', `${window.innerHeight}px`);
    b.style.setProperty('--fl-h', `${window.innerWidth}px`);
    b.style.setProperty('--fl-x', `${window.innerWidth}px`);
  } else {
    b.style.removeProperty('--fl-w');
    b.style.removeProperty('--fl-h');
    b.style.removeProperty('--fl-x');
  }
}

export function getLogicalViewport(): { width: number; height: number } {
  return forced
    ? { width: window.innerHeight, height: window.innerWidth }
    : { width: window.innerWidth, height: window.innerHeight };
}

export function clientToLogical(clientX: number, clientY: number): [number, number] {
  return forced ? [clientY, window.innerWidth - clientX] : [clientX, clientY];
}

export interface LogicalRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** Screen-space bounding box (getBoundingClientRect) → box in the logical frame. */
export function rectToLogical(r: DOMRect): LogicalRect {
  if (!forced) {
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  }
  const left = r.top;
  const top = window.innerWidth - r.right;
  return { left, top, right: left + r.height, bottom: top + r.width, width: r.height, height: r.width };
}

/** Pointer position relative to an element's top-left, in the element's own (logical) axes. */
export function localPoint(el: Element, clientX: number, clientY: number): [number, number] {
  const r = rectToLogical(el.getBoundingClientRect());
  const [x, y] = clientToLogical(clientX, clientY);
  return [x - r.left, y - r.top];
}
