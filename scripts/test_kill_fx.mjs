import assert from 'node:assert/strict';
import path from 'node:path';
import esbuild from 'esbuild';

/**
 * Automated verification for:
 * 1. Settings defaults & migration:
 *    - New user: killCam=false, killFx=true, graphicsQuality='high' (available & effective)
 *    - Existing user (saved settings without killFx): preserves killCam, killFx=false
 *    - Existing user (legacy leaderboard/profile without settings key): killCam=true, killFx=false
 *    - Availability rule: killFx only available when graphicsQuality==='high' && !killCam
 * 2. CinematicDirector upstream hit-stop & camera punch/shake math:
 *    - Normal dart/slash kill freezes at td+0.6 for exact 3/30=0.100s
 *    - Final dart/slash kill freezes at td+0.6 for exact 5/30=0.1667s (both with & without finisherCam)
 *    - Pit fall (CauseType.FALL) does NOT trigger hit-stop
 *    - Same-tick double kill merges into a single hit-stop
 *    - Camera zoom punch (zoomMul dips to 0.978) & shake advance in real time during frozen hit-stop
 *    - Defensive guard: killCam=true forces killFx=false
 */

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const built = await esbuild.build({
  entryPoints: [
    path.join(root, 'src/game/settings.ts'),
    path.join(root, 'src/game/killCamDirector.ts'),
    path.join(root, 'src/game/types.ts'),
  ],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  outdir: path.join(root, '.tmp-test'),
});
const codeByName = new Map(built.outputFiles.map((f) => [path.basename(f.path), f.text]));

const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

const importMem = async (name) =>
  import(`data:text/javascript;base64,${Buffer.from(codeByName.get(name)).toString('base64')}`);

const settingsMod = await importMem('settings.js');
const directorMod = await importMem('killCamDirector.js');
const typesMod = await importMem('types.js');

const { SettingsStore, defaultSettings, isKillFxAvailable, isKillFxEffective, getCinematicOptions } = settingsMod;
const { CinematicDirector, normalizeCinematicOptions } = directorMod;
const { CauseType, CellType, DState, PState } = typesMod;

const approx = (a, b, eps = 1e-5, msg = '') => {
  assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${a} ≈ ${b} (eps=${eps})`);
};

// ---------------- 1. Settings Defaults & Migration Tests ----------------
{
  storage.clear();
  const def = defaultSettings();
  assert.equal(def.killCam, false, 'new user default killCam must be false');
  assert.equal(def.killFx, true, 'new user default killFx must be true');
  assert.equal(def.graphicsQuality, 'high', 'new user default graphicsQuality must be high');
  assert.equal(isKillFxAvailable(def), true);
  assert.equal(isKillFxEffective(def), true);

  // Brand-new user loading fresh localStorage
  const sNew = new SettingsStore();
  assert.equal(sNew.get().killCam, false);
  assert.equal(sNew.get().killFx, true);
  assert.equal(getCinematicOptions(sNew.get()).killFx, true);
  // Persisted immediately so subsequent loads after playing a match keep new-user defaults
  assert.ok(storage.has('boomerang_arena_settings_v1'));

  // Reload after leaderboard data is written: must stay new-user settings!
  storage.set('boomerang_arena_leaderboard_v2', '{"solo":{"elo":520}}');
  const sNewReload = new SettingsStore();
  assert.equal(sNewReload.get().killCam, false);
  assert.equal(sNewReload.get().killFx, true);

  // Existing user with saved settings (predating killFx) with killCam=true
  storage.clear();
  storage.set('boomerang_arena_settings_v1', JSON.stringify({ graphicsQuality: 'high', killCam: true }));
  const sOld1 = new SettingsStore();
  assert.equal(sOld1.get().killCam, true, 'existing user killCam=true preserved');
  assert.equal(sOld1.get().killFx, false, 'existing user killFx defaults to false');
  assert.equal(isKillFxAvailable(sOld1.get()), false);
  assert.equal(isKillFxEffective(sOld1.get()), false);

  // Existing user with saved settings (predating killFx) with killCam=false
  storage.clear();
  storage.set('boomerang_arena_settings_v1', JSON.stringify({ graphicsQuality: 'high', killCam: false }));
  const sOld2 = new SettingsStore();
  assert.equal(sOld2.get().killCam, false, 'existing user killCam=false preserved');
  assert.equal(sOld2.get().killFx, false, 'existing user killFx still defaults to false');
  assert.equal(isKillFxAvailable(sOld2.get()), true);
  assert.equal(isKillFxEffective(sOld2.get()), false);

  // Existing user who played before without ever saving Settings (only leaderboard exists)
  storage.clear();
  storage.set('boomerang_arena_leaderboard_v2', '{"solo":{"elo":640}}');
  const sOldNoSettings = new SettingsStore();
  assert.equal(sOldNoSettings.get().killCam, true, 'returning user without settings key keeps killCam=true');
  assert.equal(sOldNoSettings.get().killFx, false, 'returning user without settings key gets killFx=false');

  // Availability matrix (only high + !killCam)
  assert.equal(isKillFxAvailable({ graphicsQuality: 'high', killCam: false }), true);
  assert.equal(isKillFxAvailable({ graphicsQuality: 'high', killCam: true }), false);
  assert.equal(isKillFxAvailable({ graphicsQuality: 'low', killCam: false }), false);
  assert.equal(isKillFxAvailable({ graphicsQuality: 'low', killCam: true }), false);

  // Toggling graphicsQuality / killCam dynamically disables killFx without losing stored preference
  storage.clear();
  const sDyn = new SettingsStore();
  assert.equal(sDyn.get().killFx, true);
  sDyn.setKillCam(true);
  assert.equal(isKillFxAvailable(sDyn.get()), false);
  assert.equal(getCinematicOptions(sDyn.get()).killFx, false);
  sDyn.setKillCam(false);
  assert.equal(isKillFxAvailable(sDyn.get()), true);
  assert.equal(getCinematicOptions(sDyn.get()).killFx, true);
  sDyn.setGraphicsQuality('low');
  assert.equal(isKillFxAvailable(sDyn.get()), false);
  assert.equal(getCinematicOptions(sDyn.get()).killFx, false);
  sDyn.setGraphicsQuality('high');
  assert.equal(getCinematicOptions(sDyn.get()).killFx, true);

  // resetAll restores new-user defaults
  sDyn.setKillCam(true);
  sDyn.setKillFx(false);
  sDyn.resetAll();
  assert.equal(sDyn.get().killCam, false);
  assert.equal(sDyn.get().killFx, true);

  console.log('✓ Settings defaults, migration & availability matrix passed');
}

// ---------------- 2. CinematicDirector Hit-Stop & Impact Tests ----------------
const makeMap = () => ({
  name: 'test',
  nx: 20,
  ny: 14,
  cell: 500,
  nwave: 0,
  colStart: 240,
  colEvery: 30,
  colWarn: 30,
  steps: 800,
  bodyR: 400,
  dartR: 320,
  range: 7200,
  slashReach: 1500,
  dashCd: 20,
  recallPre: 12,
  cells: new Array(20 * 14).fill(CellType.FLOOR),
  waves: new Array(20 * 14).fill(-1),
  waveSteps: [],
  spawns: [],
});

const makePlayer = (id, x, y, alive = 1) => ({
  id,
  team: id,
  x,
  y,
  vx: 0,
  vy: 0,
  face: 0,
  alive,
  st: alive ? PState.FREE : PState.DEAD,
  timer: 0,
  cd: 0,
  ax: 1000,
  ay: 0,
  dashing: 0,
  expose: 0,
  kills: 0,
  rank: alive ? 1 : 4,
  visMask: 0b1111,
});

const makeDart = (id, x, y, st = DState.HAND) => ({
  id,
  st,
  x,
  y,
  vx: 0,
  vy: 0,
  age: 0,
  left: 0,
});

const buildTicks = () => {
  const ticks = [];
  for (let t = 0; t <= 40; t++) {
    const p0Alive = 1;
    const p1Alive = t < 20 ? 1 : 0; // Dart kill at t=20 (non-final)
    const p2Alive = t < 30 ? 1 : 0; // Fall death at t=30 (non-final, NO hitstop)
    const p3Alive = t < 40 ? 1 : 0; // Slash kill at t=40 (final kill!)
    const events = [];
    if (t === 20) {
      // Double-check same-tick deduplication too by putting 1 dart kill here
      events.push({ name: 'DEATH', a: 1, b: CauseType.DART, c: 0, d: 0 });
    }
    if (t === 30) {
      events.push({ name: 'DEATH', a: 2, b: CauseType.FALL, c: 0, d: 0 });
    }
    if (t === 40) {
      events.push({ name: 'DEATH', a: 3, b: CauseType.SLASH, c: 0, d: 0 });
      events.push({ name: 'END', a: 0, b: 0, c: 0, d: 0 });
    }
    ticks.push({
      t,
      n: 4,
      over: t === 40,
      winner: t === 40 ? 0 : -1,
      reason: t === 40 ? 'ko' : '',
      players: [
        makePlayer(0, 3000 + t * 20, 3500, p0Alive),
        makePlayer(1, 5000, 3500, p1Alive),
        makePlayer(2, 7000, 3500, p2Alive),
        makePlayer(3, 4200, 3500, p3Alive),
      ],
      darts: [
        makeDart(0, 3500 + t * 50, 3500, t === 19 || t === 20 ? DState.OUT : DState.HAND),
        makeDart(1, 5000, 3500),
        makeDart(2, 7000, 3500),
        makeDart(3, 4200, 3500),
      ],
      events,
    });
  }
  return ticks;
};

{
  // Defensive guard in normalizeCinematicOptions
  const guarded = normalizeCinematicOptions({ killCam: true, finisherCam: true, winnerCam: true, killFx: true });
  assert.equal(guarded.killFx, false, 'killFx must be forced false whenever killCam is true');

  const mapData = makeMap();
  const ticks = buildTicks();
  const ovPos = { x: 5, y: 22, z: 18 };
  const ovLook = { x: 5, y: 0, z: 3.5 };

  // Case A: killCam=false, finisherCam=false, winnerCam=false, killFx=true
  const dirOnlyFx = new CinematicDirector(ticks, mapData, {
    killCam: false,
    finisherCam: false,
    winnerCam: false,
    killFx: true,
  });
  assert.equal(dirOnlyFx.isEnabled(), true);
  assert.equal(dirOnlyFx.hasKillFx(), true);

  // Tick 19 (before dart kill): normal 50ms
  approx(dirOnlyFx.getTickRealDurationSec(19), 0.05, 1e-6, 'tick 19 duration');
  // Tick 20 (dart kill at t=20 -> hitstop at 20.6 = 1.03s for 3/30 = 0.100s): 50ms + 100ms = 150ms!
  approx(dirOnlyFx.getTickRealDurationSec(20), 0.15, 1e-6, 'tick 20 duration with normal hitstop');
  // Tick 30 (FALL death -> NO hitstop): normal 50ms!
  approx(dirOnlyFx.getTickRealDurationSec(30), 0.05, 1e-6, 'tick 30 fall death must not hitstop');

  // Verify freeze at simSec = 1.03s across realSec [1.03, 1.13]
  approx(dirOnlyFx.simToReal(1.0), 1.0, 1e-6);
  approx(dirOnlyFx.simToReal(1.03), 1.03, 1e-6);
  approx(dirOnlyFx.simToReal(1.05), 1.15, 1e-6);
  approx(dirOnlyFx.realToSim(1.03), 1.03, 1e-6);
  approx(dirOnlyFx.realToSim(1.08), 1.03, 1e-6, 'mid-hitstop simSec must stay frozen at 1.03');
  approx(dirOnlyFx.realToSim(1.13), 1.03, 1e-6, 'end-hitstop simSec still 1.03');
  approx(dirOnlyFx.realToSim(1.15), 1.05, 1e-6, 'post-hitstop resumes smoothly');

  // Verify camera impact punch & real-time shake DURING the freeze!
  const poseStart = dirOnlyFx.evaluate(1.03, ovPos, ovLook, 1.03);
  const poseMid = dirOnlyFx.evaluate(1.03, ovPos, ovLook, 1.08);
  const poseAfter = dirOnlyFx.evaluate(1.05, ovPos, ovLook, 1.8);
  assert.equal(poseStart.inHitStop, true);
  assert.equal(poseStart.timeScale, 0);
  approx(poseStart.zoomMul, 1 - 0.022, 1e-5, 'peak zoom punch 0.978 at hitstop start');
  assert.equal(poseMid.inHitStop, true);
  assert.ok(poseMid.zoomMul < 0.99 && poseMid.zoomMul > poseStart.zoomMul, 'zoom punch eases during freeze');
  assert.ok(
    poseStart.shakeRight !== poseMid.shakeRight || poseStart.shakeUp !== poseMid.shakeUp,
    'shake must animate in real time while simulation is frozen',
  );
  assert.equal(poseAfter.inHitStop, false);
  approx(poseAfter.zoomMul, 1.0, 1e-6, 'zoomMul settles back to 1.0');
  approx(poseAfter.shakeRight, 0, 1e-6);
  approx(poseAfter.shakeUp, 0, 1e-6);

  // Verify final kill at tick 40 (simSec = 2.00 -> hitstop at 2.03s for 5/30 = 0.16667s)
  approx(dirOnlyFx.simToReal(2.0), 2.1, 1e-6, 'match end real includes earlier 0.1s hitstop');
  approx(dirOnlyFx.simToReal(2.03), 2.13, 1e-6);
  approx(dirOnlyFx.realToSim(2.13), 2.03, 1e-6);
  approx(dirOnlyFx.realToSim(2.22), 2.03, 1e-6, 'mid-final-hitstop stays frozen at 2.03');
  approx(dirOnlyFx.realToSim(2.13 + 5 / 30), 2.03, 1e-5);
  approx(dirOnlyFx.realToSim(2.13 + 5 / 30 + 0.05), 2.08, 1e-5);

  // Case B: Default new-user combo (killCam=false, finisherCam=true, winnerCam=true, killFx=true)
  const dirNewUser = new CinematicDirector(ticks, mapData, {
    killCam: false,
    finisherCam: true,
    winnerCam: true,
    killFx: true,
  });
  // Mid-match kill at tick 20 has hitstop (150ms) and NO slow-mo eye-level killCam!
  approx(dirNewUser.getTickRealDurationSec(20), 0.15, 1e-6, 'new-user mid kill gets 150ms hitstop tick');
  assert.equal(dirNewUser.getSpeedScaleAtSim(0.9), 1.0, 'no pre-kill slow-mo on non-final kill');
  // Final kill at tick 40 has BOTH 0.25x finisherCam slow-mo AND 5-frame (0.1667s) hitstop at 2.03s!
  approx(dirNewUser.getSpeedScaleAtSim(1.8), 0.25, 1e-6, 'finisherCam 0.25x active before final kill');
  const finEndSim = 2.0 + 0.16; // POST_KILL_SIM_SEC_FINAL = 0.16
  // Real time from matchEnd (2.00) to finEnd (2.16) = 0.16 / 0.25 + 5/30 = 0.64 + 0.16667 = 0.80667s
  approx(
    dirNewUser.simToReal(finEndSim) - dirNewUser.simToReal(2.0),
    0.16 / 0.25 + 5 / 30,
    1e-5,
    'finisher window includes both 0.25x slow-mo and 5-frame hitstop',
  );
  approx(dirNewUser.getFinisherEndRealSec(), dirNewUser.simToReal(finEndSim), 1e-6);

  // Case C: Same-tick double kill merges cleanly into ONE hitstop
  const dblTicks = buildTicks();
  dblTicks[20].events.push({ name: 'DEATH', a: 2, b: CauseType.SLASH, c: 0, d: 0 });
  const dirDbl = new CinematicDirector(dblTicks, mapData, {
    killCam: false,
    finisherCam: false,
    winnerCam: false,
    killFx: true,
  });
  approx(dirDbl.getTickRealDurationSec(20), 0.15, 1e-6, 'same-tick double kill deduplicates to single 100ms hitstop');

  // Case D: createWinnerCloseupOnly with killFxEnabled=true adds final 5-frame hitstop
  const postDir = CinematicDirector.createWinnerCloseupOnly(ticks[40], mapData, true, true);
  assert.ok(postDir && postDir.hasKillFx() && postDir.hasWinnerCloseup());
  approx(postDir.simToReal(2.05) - postDir.simToReal(2.0), 0.05 + 5 / 30, 1e-5, 'post-match director includes 5-frame hitstop');

  console.log('✓ CinematicDirector hit-stop, zoom punch, shake & finisher coexistence passed');
}

console.log('ALL KILL FX TESTS PASSED');
