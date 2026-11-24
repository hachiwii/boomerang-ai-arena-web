/**
 * Generates an inline SVG avatar for the built-in generic humanoid (Human & Sparring hoodies)
 * so every contestant card has a crisp square icon.
 */
export function makeHoodieAvatarDataUrl(hoodColor: string, hairColor: string, label?: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
    <rect x="14" y="10" width="36" height="28" rx="4" fill="${hairColor}" stroke="#2E2238" stroke-width="3"/>
    <rect x="20" y="20" width="24" height="16" fill="#FFDCC2"/>
    <rect x="24" y="23" width="4" height="7" fill="#2B3550"/>
    <rect x="36" y="23" width="4" height="7" fill="#2B3550"/>
    <rect x="25" y="23" width="2" height="2" fill="#FFFFFF"/>
    <rect x="37" y="23" width="2" height="2" fill="#FFFFFF"/>
    <rect x="20" y="32" width="4" height="3" fill="#FF9FA8"/>
    <rect x="40" y="32" width="4" height="3" fill="#FF9FA8"/>
    <rect x="18" y="38" width="28" height="20" rx="3" fill="${hoodColor}" stroke="#2E2238" stroke-width="3"/>
    <rect x="27" y="39" width="2" height="10" fill="#FFFFFF"/>
    <rect x="35" y="39" width="2" height="10" fill="#FFFFFF"/>
    ${label ? `<text x="32" y="55" font-size="9" font-weight="800" fill="#fff" text-anchor="middle" font-family="sans-serif">${label}</text>` : ''}
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
