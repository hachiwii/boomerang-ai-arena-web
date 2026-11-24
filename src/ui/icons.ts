/** Inline SVG icons for the mobile HUD & touch controls (currentColor, 24×24 viewBox). */

const svg = (body: string, extra = '') =>
  `<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" ${extra}>${body}</svg>`;

const stroke = (d: string, w = 2.2) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const ICON_BOOMERANG = svg(
  `<path d="M5.2 5.6C12.8 2.9 20.4 7.6 18.9 19.2 16 14.2 12.6 11.2 5.2 5.6Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
);

export const ICON_RECALL = svg(
  stroke('M19.2 12.6A7.3 7.3 0 1 1 16.9 6.8') +
    stroke('M18.8 3.6v4.2h-4.2') +
    `<circle cx="12" cy="12.6" r="2.4" fill="currentColor"/>`,
);

export const ICON_SWORD = svg(
  stroke('M19.6 4.4 9.6 14.4', 3.2) + stroke('M6.6 11.4l6 6', 2.4) + stroke('M8.6 15.4 4.4 19.6', 2.8),
);

export const ICON_KICK = svg(
  `<path d="M7.5 3.5h4.6v7.2l5.6 2.6a2.6 2.6 0 0 1 1.6 2.4v2.8H7.5Z" fill="currentColor"/>` +
    `<path d="M6.5 20.5h13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
);

export const ICON_DASH = svg(stroke('M4.5 6.5 10 12l-5.5 5.5') + stroke('M12 6.5l5.5 5.5-5.5 5.5') + stroke('M20 7v10', 2));

export const ICON_RESTART = svg(stroke('M4.6 12a7.4 7.4 0 1 0 2.2-5.3') + stroke('M4.4 3.8v4.6H9'));

export const ICON_SETTINGS = svg(
  stroke(
    'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8Zm7.6 3.4c0-.5 0-1-.1-1.4l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.4-1.4L14.4 2.6h-4L10 5.2c-.9.3-1.7.8-2.4 1.4l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 2.8l-2 1.6 2 3.4 2.4-1c.7.6 1.5 1.1 2.4 1.4l.4 2.6h4l.4-2.6c.9-.3 1.7-.8 2.4-1.4l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.4Z',
    1.8,
  ),
);

export const ICON_EXIT = svg(stroke('M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14') + stroke('M10.5 12h9.5') + stroke('M16.5 8.2 20.3 12l-3.8 3.8'));

export const ICON_PLAY = svg(`<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2Z" fill="currentColor"/>`);

export const ICON_PAUSE = svg(
  `<rect x="6.2" y="4.8" width="4.2" height="14.4" rx="1.1" fill="currentColor"/><rect x="13.6" y="4.8" width="4.2" height="14.4" rx="1.1" fill="currentColor"/>`,
);

export const ICON_REPLAY = ICON_RESTART;

export const ICON_SKIP_START = svg(
  `<rect x="5" y="5.5" width="2.8" height="13" rx="1" fill="currentColor"/>` +
    `<path d="M18.6 6.3v11.4a.8.8 0 0 1-1.25.66L9.6 13.3a1.6 1.6 0 0 1 0-2.6l7.75-5.06a.8.8 0 0 1 1.25.66Z" fill="currentColor"/>`,
);

export const ICON_DOWNLOAD = svg(stroke('M12 4v11') + stroke('M7.5 10.8 12 15.3l4.5-4.5') + stroke('M5 19.5h14'));

export const ICON_HISTORY = svg(stroke('M4.6 12a7.4 7.4 0 1 0 2.2-5.3') + stroke('M4.4 3.8v4.6H9') + stroke('M12 8v4.4l3 1.8'));

export function iconStar(filled: boolean): string {
  return svg(
    `<polygon points="12 2.8 14.9 8.7 21.4 9.6 16.7 14.2 17.8 20.6 12 17.6 6.2 20.6 7.3 14.2 2.6 9.6 9.1 8.7 12 2.8" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/>`,
  );
}

export const ICON_PHONE = svg(
  `<rect x="2.6" y="6.4" width="18.8" height="11.2" rx="2.2" fill="none" stroke="currentColor" stroke-width="2"/>` +
    `<circle cx="18.4" cy="12" r="1.1" fill="currentColor"/>`,
);

export const ICON_DESKTOP = svg(
  `<rect x="3" y="4.4" width="18" height="11.6" rx="1.8" fill="none" stroke="currentColor" stroke-width="2"/>` +
    stroke('M9 20h6M12 16v4', 2),
);

export const ICON_FULLSCREEN = svg(stroke('M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15'));

export const ICON_FULLSCREEN_EXIT = svg(stroke('M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5'));

export const ICON_ROTATE = svg(
  `<rect x="7" y="2.6" width="10" height="18.8" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
    stroke('M3.4 14.5a9 9 0 0 0 4.2 5.8', 1.8) +
    stroke('M3 18.2l.4-3.9 3.6 1.4', 1.8),
);
