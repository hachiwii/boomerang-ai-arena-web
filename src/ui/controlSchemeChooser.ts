// First-run PC control scheme chooser: two large cards (标准模式 / MOBA 模式), each with a small diagram and a few
// lines on how it plays. Shown once on desktop to players who never picked a scheme; the choice is saved in settings
// and can be changed later in 设置 → 键位.
import {
  ControlScheme,
  formatDashSummary,
  formatMoveSummary,
  formatPrimaryBind,
  SettingsStore,
} from '../game/settings';

const STANDARD_ART = `
<svg viewBox="0 0 260 132" aria-hidden="true">
  <g class="csc-key"><rect x="46" y="18" width="30" height="30" rx="7"/><text x="61" y="38">W</text></g>
  <g class="csc-key"><rect x="12" y="52" width="30" height="30" rx="7"/><text x="27" y="72">A</text></g>
  <g class="csc-key"><rect x="46" y="52" width="30" height="30" rx="7"/><text x="61" y="72">S</text></g>
  <g class="csc-key"><rect x="80" y="52" width="30" height="30" rx="7"/><text x="95" y="72">D</text></g>
  <g class="csc-key csc-key-wide"><rect x="12" y="88" width="64" height="26" rx="7"/><text x="44" y="105">Shift</text></g>
  <text class="csc-cap" x="94" y="105">冲刺</text>
  <text class="csc-cap" x="61" y="12">移动</text>
  <g transform="translate(170 22)">
    <path class="csc-mouse" d="M0 30 C0 8 12 0 30 0 C48 0 60 8 60 30 L60 62 C60 84 48 96 30 96 C12 96 0 84 0 62 Z"/>
    <path class="csc-btn-l" d="M3 30 C3 11 13 3 28 3 L28 38 L3 38 Z"/>
    <path class="csc-btn-r" d="M57 30 C57 11 47 3 32 3 L32 38 L57 38 Z"/>
    <rect class="csc-wheel" x="27" y="12" width="6" height="14" rx="3"/>
  </g>
  <text class="csc-cap csc-cap-l" x="163" y="44" text-anchor="end">扔镖</text>
  <text class="csc-cap csc-cap-r" x="237" y="44">挥砍</text>
  <text class="csc-cap" x="200" y="132" text-anchor="middle">朝鼠标方向</text>
</svg>`;

const MOBA_ART = `
<svg viewBox="0 0 260 132" aria-hidden="true">
  <rect class="csc-ground" x="4" y="6" width="252" height="84" rx="12"/>
  <rect class="csc-wall" x="104" y="26" width="26" height="44" rx="4"/>
  <circle class="csc-hero" cx="36" cy="60" r="11"/>
  <path class="csc-path" d="M48 58 C84 52 96 80 118 80 C146 80 160 46 206 42"/>
  <g transform="translate(212 40)">
    <circle class="csc-ring" r="15"/>
    <g class="csc-chev">
      <path d="M-24 -24 L-12 -16 L-16 -12 Z" transform="rotate(0)"/>
      <path d="M-24 -24 L-12 -16 L-16 -12 Z" transform="rotate(90)"/>
      <path d="M-24 -24 L-12 -16 L-16 -12 Z" transform="rotate(180)"/>
      <path d="M-24 -24 L-12 -16 L-16 -12 Z" transform="rotate(270)"/>
    </g>
    <circle class="csc-dot" r="3"/>
  </g>
  <text class="csc-cap" x="212" y="78" text-anchor="middle">右键点地</text>
  <g class="csc-key"><rect x="38" y="98" width="30" height="30" rx="7"/><text x="53" y="118">Q</text></g>
  <g class="csc-key"><rect x="115" y="98" width="30" height="30" rx="7"/><text x="130" y="118">W</text></g>
  <g class="csc-key"><rect x="192" y="98" width="30" height="30" rx="7"/><text x="207" y="118">E</text></g>
  <text class="csc-cap" x="74" y="118">扔镖</text>
  <text class="csc-cap" x="151" y="118">挥砍</text>
  <text class="csc-cap" x="228" y="118">冲刺</text>
</svg>`;

let open = false;

/** Show the chooser (no-op if already open); `onChosen` runs once the pick is saved. */
export function showControlSchemeChooser(settings: SettingsStore, onChosen?: (scheme: ControlScheme) => void) {
  if (open) return;
  open = true;
  const kb = settings.get().keybindings;
  const std = {
    move: formatMoveSummary(kb),
    thr: formatPrimaryBind(kb.throwRecall),
    mel: formatPrimaryBind(kb.melee),
    dsh: formatDashSummary(kb),
  };
  const moba = {
    move: formatPrimaryBind(kb.mobaMove),
    thr: formatPrimaryBind(kb.mobaThrowRecall),
    mel: formatPrimaryBind(kb.mobaMelee),
    dsh: formatPrimaryBind(kb.mobaDash),
    stop: formatPrimaryBind(kb.mobaStop, ''),
  };

  const el = document.createElement('div');
  el.className = 'csc-screen';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', '选择操作模式');
  el.innerHTML = `
    <div class="csc-panel">
      <div class="csc-head">
        <h2>选择操作模式</h2>
        <p>选择后会记住，之后可在「设置 → 键位」中随时切换</p>
      </div>
      <div class="csc-cards">
        <button type="button" class="csc-card" data-scheme="standard">
          <div class="csc-art">${STANDARD_ART}</div>
          <div class="csc-title"><strong>标准模式</strong><span>动作游戏手感</span></div>
          <ul class="csc-list">
            <li><kbd>${std.move}</kbd> 移动，鼠标瞄准</li>
            <li><kbd>${std.thr}</kbd> 向鼠标扔镖 · 长按召回</li>
            <li><kbd>${std.mel}</kbd> 挥砍 / 踢人 · <kbd>${std.dsh}</kbd> 冲刺</li>
          </ul>
        </button>
        <button type="button" class="csc-card" data-scheme="moba">
          <div class="csc-art">${MOBA_ART}</div>
          <div class="csc-title"><strong>MOBA 模式</strong><span>类似 LoL / Dota</span></div>
          <ul class="csc-list">
            <li><kbd>${moba.move}</kbd> 点地移动，按住跟随鼠标${moba.stop ? ` · <kbd>${moba.stop}</kbd> 停下` : ''}</li>
            <li><kbd>${moba.thr}</kbd> 向鼠标扔镖 · 长按召回</li>
            <li><kbd>${moba.mel}</kbd> 挥砍 / 踢人 · <kbd>${moba.dsh}</kbd> 向鼠标冲刺</li>
          </ul>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-in'));

  const stop = (e: Event) => e.stopPropagation();
  // Keep game / lobby shortcuts from reacting while the chooser is up
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.code === 'Digit1' || e.code === 'Digit2') choose(e.code === 'Digit1' ? 'standard' : 'moba');
  };
  window.addEventListener('keydown', onKey, { capture: true });
  el.addEventListener('mousedown', stop);
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  let done = false;
  function choose(scheme: ControlScheme) {
    if (done) return;
    done = true;
    settings.setControlScheme(scheme);
    window.removeEventListener('keydown', onKey, { capture: true });
    el.querySelector(`[data-scheme="${scheme}"]`)?.classList.add('is-picked');
    el.classList.add('is-leaving');
    window.setTimeout(() => {
      el.remove();
      open = false;
    }, 260);
    onChosen?.(scheme);
  }
  el.querySelectorAll<HTMLButtonElement>('[data-scheme]').forEach((btn) => {
    btn.addEventListener('click', () => choose(btn.dataset.scheme as ControlScheme));
  });
}

export function isControlSchemeChooserOpen(): boolean {
  return open;
}
