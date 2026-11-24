import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createEngineModule from '../public/wasm/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAPS_DIR = path.resolve(__dirname, '../public/assets/maps');

const CELL = 500;
const BODY_R = 400;
const SEE_R = 2500;

const mod = await createEngineModule({ print: () => {}, printErr: () => {} });
const engineInit = mod.cwrap('engine_init', 'number', ['string', 'number', 'number']);
const engineInitWithSpawnSeed = mod.cwrap('engine_init_with_spawn_seed', 'number', ['string', 'number', 'number', 'number']);
const engineGetMapJson = mod.cwrap('engine_get_map_json', 'string', []);
const engineGetStateJson = mod.cwrap('engine_get_state_json', 'string', []);
const engineGetHeader = mod.cwrap('engine_get_header', 'string', ['number']);
const engineLastError = mod.cwrap('engine_last_error', 'string', []);

function circleHitsCell(mapData, r, x, y, targetType) {
  const cx = Math.floor(x / CELL);
  const cy = Math.floor(y / CELL);
  const r2 = r * r;
  for (let gy = cy - 1; gy <= cy + 1; gy++) {
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      const inside = gx >= 0 && gy >= 0 && gx < mapData.nx && gy < mapData.ny;
      const cell = inside ? mapData.cells[gy * mapData.nx + gx] : 2; // C_PIT outside
      if (cell !== targetType) continue;
      const qx = Math.max(gx * CELL, Math.min(x, (gx + 1) * CELL));
      const qy = Math.max(gy * CELL, Math.min(y, (gy + 1) * CELL));
      if ((x - qx) ** 2 + (y - qy) ** 2 < r2) return true;
    }
  }
  return false;
}

function reachableSet(mapData, sx, sy) {
  const sgx = Math.max(0, Math.min(mapData.nx - 1, Math.floor(sx / CELL)));
  const sgy = Math.max(0, Math.min(mapData.ny - 1, Math.floor(sy / CELL)));
  const vis = new Uint8Array(mapData.nx * mapData.ny);
  const q = [sgy * mapData.nx + sgx];
  vis[q[0]] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const idx = q[qi];
    const cx = idx % mapData.nx;
    const cy = Math.floor(idx / mapData.nx);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= mapData.nx || ny >= mapData.ny) continue;
      const nidx = ny * mapData.nx + nx;
      if (vis[nidx]) continue;
      const c = mapData.cells[nidx];
      if (c !== 0 && c !== 3) continue; // FLOOR or GRASS
      vis[nidx] = 1;
      q.push(nidx);
    }
  }
  return vis;
}

const KLEIN4_4P = new Set(['hourglass', 'oldtown', 'stonecircle']);
const R180_4P = new Set(['canyon', 'forest', 'icefloes', 'skybridge', 'twinlakes', 'ruins']);
const PARTIAL_R180_4P = new Set(['yinyang']);

const mapFiles = fs.readdirSync(MAPS_DIR).filter((f) => f.endsWith('.txt')).sort();
assert.equal(mapFiles.length, 10, 'Expected 10 built-in maps');

const SEEDS_PER_CASE = 200;
let totalChecks = 0;

for (const file of mapFiles) {
  const mapName = file.replace(/\.txt$/, '');
  const mapText = fs.readFileSync(path.join(MAPS_DIR, file), 'utf8');

  for (const nPlayers of [2, 3, 4]) {
    // 1. Original unrandomized spawns (engine_init with seed=0)
    assert.equal(engineInit(mapText, nPlayers, 0), 1, `engine_init(0) failed: ${engineLastError()}`);
    const origMap = JSON.parse(engineGetMapJson());
    const origSpawns = origMap.spawns;
    const W = origMap.nx * CELL;
    const H = origMap.ny * CELL;
    const reaches = origSpawns.map(([x, y]) => reachableSet(origMap, x, y));

    // 2. Verify backward compatibility: engine_init_with_spawn_seed(..., seed, 0) === engine_init(..., seed)
    assert.equal(engineInit(mapText, nPlayers, 424242), 1);
    const legacySpawns = JSON.parse(engineGetMapJson()).spawns;
    assert.equal(engineInitWithSpawnSeed(mapText, nPlayers, 424242, 0), 1);
    const compatSpawns = JSON.parse(engineGetMapJson()).spawns;
    assert.deepEqual(compatSpawns, legacySpawns, `Backward compat broken on ${mapName} ${nPlayers}p`);

    // 3. Test 200 random spawnSeeds (including high-bit unsigned 32-bit values)
    let maxRadius = 0;
    const xsBySeat = Array.from({ length: nPlayers }, () => new Set());
    const ysBySeat = Array.from({ length: nPlayers }, () => new Set());
    let independentOrbitsSeen = 0;

    for (let i = 0; i < SEEDS_PER_CASE; i++) {
      const spawnSeed = ((Math.imul(i + 1, 2654435761) ^ 0x9e3779b9) >>> 0) || 1;
      const legacySeed = (i * 17 + 99) >>> 0;
      assert.equal(
        engineInitWithSpawnSeed(mapText, nPlayers, legacySeed, spawnSeed),
        1,
        `engine_init_with_spawn_seed failed on ${mapName} ${nPlayers}p seed=${spawnSeed}: ${engineLastError()}`,
      );
      const md = JSON.parse(engineGetMapJson());
      const st = JSON.parse(engineGetStateJson());
      const sp = md.spawns;
      assert.equal(sp.length, nPlayers);

      // Verify determinism independent of legacySeed on first few seeds
      if (i < 5) {
        const hdr = engineGetHeader(0);
        const spawnLine = hdr.split('\n').find((l) => l.startsWith('SPAWN '));
        const expectedSpawnLine = 'SPAWN ' + sp.flatMap(([x, y]) => [x, y]).join(' ');
        assert.equal(spawnLine, expectedSpawnLine, `Protocol header SPAWN mismatch on ${mapName}`);

        assert.equal(engineInitWithSpawnSeed(mapText, nPlayers, legacySeed + 7777, spawnSeed), 1);
        const sp2 = JSON.parse(engineGetMapJson()).spawns;
        assert.deepEqual(sp2, sp, `spawnSeed determinism broken by legacySeed on ${mapName}`);
      }

      // Per-seat radius, bounds, terrain, wall/pit clearance, connectivity, state consistency
      for (let k = 0; k < nPlayers; k++) {
        const [x, y] = sp[k];
        const [ox, oy] = origSpawns[k];
        const dx = x - ox;
        const dy = y - oy;
        const r2 = dx * dx + dy * dy;
        assert.ok(r2 <= SEE_R * SEE_R, `${mapName} ${nPlayers}p seat ${k} exceeded see_r: dist=${Math.sqrt(r2)}`);
        if (Math.sqrt(r2) > maxRadius) maxRadius = Math.sqrt(r2);

        assert.ok(x >= BODY_R && x <= W - BODY_R && y >= BODY_R && y <= H - BODY_R, `${mapName} seat ${k} out of bounds`);
        assert.ok(!circleHitsCell(md, BODY_R, x, y, 1), `${mapName} seat ${k} overlaps wall`);
        assert.ok(!circleHitsCell(md, BODY_R, x, y, 2), `${mapName} seat ${k} overlaps pit`);

        const gx = Math.max(0, Math.min(md.nx - 1, Math.floor(x / CELL)));
        const gy = Math.max(0, Math.min(md.ny - 1, Math.floor(y / CELL)));
        const cell = md.cells[gy * md.nx + gx];
        assert.ok(cell === 0 || cell === 3, `${mapName} seat ${k} not on floor/grass: ${cell}`);
        assert.equal(reaches[k][gy * md.nx + gx], 1, `${mapName} seat ${k} landed on disconnected island!`);

        assert.equal(st.players[k].x, x);
        assert.equal(st.players[k].y, y);
        assert.equal(st.darts[k].x, x);
        assert.equal(st.darts[k].y, y);

        xsBySeat[k].add(x);
        ysBySeat[k].add(y);
      }

      // Minimum pairwise separation >= 2500mm
      for (let a = 0; a < nPlayers; a++) {
        for (let b = a + 1; b < nPlayers; b++) {
          const d2 = (sp[a][0] - sp[b][0]) ** 2 + (sp[a][1] - sp[b][1]) ** 2;
          assert.ok(d2 >= 2500 * 2500, `${mapName} ${nPlayers}p seats ${a},${b} too close: ${Math.sqrt(d2)}mm`);
        }
      }

      // Exact symmetry checks
      if (nPlayers === 2) {
        assert.equal(sp[0][0] + sp[1][0], W, `${mapName} 2p R180 X violated`);
        assert.equal(sp[0][1] + sp[1][1], H, `${mapName} 2p R180 Y violated`);
      } else if (nPlayers === 4) {
        if (KLEIN4_4P.has(mapName)) {
          assert.equal(sp[0][0] + sp[1][0], W, `${mapName} 4p LR(0,1) X violated`);
          assert.equal(sp[0][1], sp[1][1], `${mapName} 4p LR(0,1) Y violated`);
          assert.equal(sp[0][0], sp[3][0], `${mapName} 4p TB(0,3) X violated`);
          assert.equal(sp[0][1] + sp[3][1], H, `${mapName} 4p TB(0,3) Y violated`);
          assert.equal(sp[0][0] + sp[2][0], W, `${mapName} 4p R180(0,2) X violated`);
          assert.equal(sp[0][1] + sp[2][1], H, `${mapName} 4p R180(0,2) Y violated`);
        } else if (R180_4P.has(mapName)) {
          assert.equal(sp[0][0] + sp[2][0], W, `${mapName} 4p R180(0,2) X violated`);
          assert.equal(sp[0][1] + sp[2][1], H, `${mapName} 4p R180(0,2) Y violated`);
          assert.equal(sp[1][0] + sp[3][0], W, `${mapName} 4p R180(1,3) X violated`);
          assert.equal(sp[1][1] + sp[3][1], H, `${mapName} 4p R180(1,3) Y violated`);
          const dx0 = sp[0][0] - origSpawns[0][0];
          const dx1 = sp[1][0] - origSpawns[1][0];
          if (Math.abs(dx0) !== Math.abs(dx1)) independentOrbitsSeen++;
        } else if (PARTIAL_R180_4P.has(mapName)) {
          assert.equal(sp[0][0] + sp[2][0], W, `${mapName} 4p partial R180(0,2) X violated`);
          assert.equal(sp[0][1] + sp[2][1], H, `${mapName} 4p partial R180(0,2) Y violated`);
          const dx1 = sp[1][0] - origSpawns[1][0];
          const dx3 = sp[3][0] - origSpawns[3][0];
          if (Math.abs(dx1) !== Math.abs(dx3)) independentOrbitsSeen++;
        }
      } else if (nPlayers === 3) {
        // Seats 0 and 2 are R180 partners on all 10 maps
        assert.equal(sp[0][0] + sp[2][0], W, `${mapName} 3p R180(0,2) X violated`);
        assert.equal(sp[0][1] + sp[2][1], H, `${mapName} 3p R180(0,2) Y violated`);
        if (KLEIN4_4P.has(mapName)) {
          assert.equal(sp[0][0] + sp[1][0], W, `${mapName} 3p LR(0,1) X violated`);
          assert.equal(sp[0][1], sp[1][1], `${mapName} 3p LR(0,1) Y violated`);
        }
      }
      totalChecks++;
    }

    assert.ok(maxRadius > 2000, `${mapName} ${nPlayers}p maxRadius too small (${maxRadius.toFixed(0)}mm)`);
    for (let k = 0; k < nPlayers; k++) {
      assert.ok(xsBySeat[k].size > 50, `${mapName} ${nPlayers}p seat ${k} X collapsed (${xsBySeat[k].size} unique)`);
      assert.ok(ysBySeat[k].size > 50, `${mapName} ${nPlayers}p seat ${k} Y collapsed (${ysBySeat[k].size} unique)`);
    }
    if (nPlayers === 4 && (R180_4P.has(mapName) || PARTIAL_R180_4P.has(mapName))) {
      assert.ok(independentOrbitsSeen > 150, `${mapName} 4p orbits should vary independently`);
    }
  }
  console.log(`  PASS ${mapName} (2p, 3p, 4p × ${SEEDS_PER_CASE} seeds)`);
}

// 4. Synthetic custom maps: C4 square pinwheel, LR-only, TB-only, asymmetric
function makeOpenMap(nx, ny, mode, spawnStr) {
  const row = '.'.repeat(nx);
  const grid = Array.from({ length: ny }, () => row).join('\n');
  return `NAME synth\nMODES ${mode}\nSPAWN ${mode} ${spawnStr}\nGRID ${nx} ${ny}\n${grid}\n`;
}

// 4a. Square C4 pinwheel (20x20 => W=H=10000): (2,3), (7,2), (8,7), (3,8) -> R90(x,y)=(10-y,x)
const c4Map = makeOpenMap(20, 20, 1, '2 3 7 2 8 7 3 8');
for (let s = 1; s <= 50; s++) {
  assert.equal(engineInitWithSpawnSeed(c4Map, 4, 0, s * 1337), 1);
  const sp = JSON.parse(engineGetMapJson()).spawns;
  assert.equal(sp[1][0], 10000 - sp[0][1], 'C4 R90 X violated');
  assert.equal(sp[1][1], sp[0][0], 'C4 R90 Y violated');
  assert.equal(sp[2][0], 10000 - sp[0][0], 'C4 R180 X violated');
  assert.equal(sp[2][1], 10000 - sp[0][1], 'C4 R180 Y violated');
  assert.equal(sp[3][0], sp[0][1], 'C4 R270 X violated');
  assert.equal(sp[3][1], 10000 - sp[0][0], 'C4 R270 Y violated');
}
console.log('  PASS synthetic C4 square pinwheel');

// 4b. LR-only 2p (36x24 => W=18000, H=12000): (3,3) & (15,3)
const lrMap = makeOpenMap(36, 24, 0, '3 3 15 3');
for (let s = 1; s <= 50; s++) {
  assert.equal(engineInitWithSpawnSeed(lrMap, 2, 0, s * 7919), 1);
  const sp = JSON.parse(engineGetMapJson()).spawns;
  assert.equal(sp[0][0] + sp[1][0], 18000, 'LR-only X violated');
  assert.equal(sp[0][1], sp[1][1], 'LR-only Y violated');
}
console.log('  PASS synthetic LR-only 2p');

// 4c. TB-only 2p (36x24 => W=18000, H=12000): (3,3) & (3,9)
const tbMap = makeOpenMap(36, 24, 0, '3 3 3 9');
for (let s = 1; s <= 50; s++) {
  assert.equal(engineInitWithSpawnSeed(tbMap, 2, 0, s * 104729), 1);
  const sp = JSON.parse(engineGetMapJson()).spawns;
  assert.equal(sp[0][0], sp[1][0], 'TB-only X violated');
  assert.equal(sp[0][1] + sp[1][1], 12000, 'TB-only Y violated');
}
console.log('  PASS synthetic TB-only 2p');

console.log(`ALL ${totalChecks} built-in checks + synthetic symmetry checks PASSED!`);
