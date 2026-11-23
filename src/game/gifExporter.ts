import { GIFEncoder, PaletteColor, quantize } from 'gifenc';
import { SoundFX } from '../audio/sfx';
import { GameRenderer } from '../render/renderer';
import { VoxelModelData } from '../render/voxelBuilder';
import { MatchReplayBundle } from './matchHistory';
import { drawBroadcastOverlay, loadImage, triggerMp4Download } from './mp4Exporter';
import { LOGIC_DT_MS, TickSnapshot } from './types';

export interface GifClipExportOptions {
  /** Current replay tick index (`0 .. ticks.length - 1`) to capture backwards from. */
  endTickIndex: number;
  /** Maximum clip duration in seconds (default 10s). */
  maxDurationSec?: number;
  sharedCharModelCache?: Map<string, VoxelModelData>;
  signal?: AbortSignal;
  onProgress?: (progress01: number, phaseText: string) => void;
}

export interface GifClipExportResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  sizeBytes: number;
}

const GIF_WIDTH = 1280;
const GIF_HEIGHT = 720;
const GIF_FPS = 15;
const DEFAULT_MAX_CLIP_SEC = 10.0;
const END_OUTRO_SEC = 0.85;
const WARMUP_TICKS = 30; // 1.5s pre-roll so trails/particles/shake are warm at clip start
const TRANSPARENT_IDX = 255;
// 70 + 70 + 60 = 200ms per 3 frames => exact 15.000 fps in GIF 10ms centisecond timing
const FRAME_DELAYS_MS = [70, 70, 60] as const;

function buildGifFilename(bundle: MatchReplayBundle, startSec: number, endSec: number): string {
  const { summary } = bundle;
  const d = new Date(summary.playedAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const modeTag =
    summary.matchMode === 'ranked-solo'
      ? 'solo'
      : summary.matchMode === 'ranked-ffa'
        ? 'ffa'
        : 'custom';
  const sTag = `${startSec.toFixed(1)}s`;
  const eTag = `${endSec.toFixed(1)}s`;
  return `boomerang_${modeTag}_${summary.mapId}_${stamp}_${sTag}-${eTag}_720p_15fps.gif`;
}

/**
 * Exports up to the last `maxDurationSec` (default 10s) leading up to `endTickIndex`
 * as a 720p 15fps animated GIF with paused background clouds while keeping all
 * other effects (grass sway, ambient particles, collapse, camera shake, FX, HUD) intact.
 */
export async function exportReplayClipToGif(
  bundle: MatchReplayBundle,
  options: GifClipExportOptions,
): Promise<GifClipExportResult> {
  const ticks = bundle.replay.ticks;
  if (!ticks || ticks.length < 2) {
    throw new Error('回放帧数据不足，无法导出 GIF');
  }

  const maxTickIdx = ticks.length - 1;
  const endTickIndex = Math.max(0, Math.min(maxTickIdx, Math.round(options.endTickIndex)));
  if (endTickIndex < 2) {
    throw new Error('当前处于回放起点，请先播放一段后再截取 10s GIF');
  }

  const maxDurationSec = Math.max(1, options.maxDurationSec ?? DEFAULT_MAX_CLIP_SEC);
  const tickSec = LOGIC_DT_MS / 1000; // 0.05s per logic tick (20Hz)
  const endPlaySec = endTickIndex * tickSec;
  const atMatchEnd = endTickIndex >= maxTickIdx;
  const outroSec = atMatchEnd ? END_OUTRO_SEC : 0;
  const totalEndSec = endPlaySec + outroSec;
  const startPlaySec = Math.max(0, totalEndSec - maxDurationSec);
  const clipDurationSec = Math.max(tickSec, totalEndSec - startPlaySec);
  const totalFrames = Math.max(
    2,
    Math.min(Math.round(maxDurationSec * GIF_FPS), Math.round(clipDurationSec * GIF_FPS)),
  );
  const frameDt = 1 / GIF_FPS;

  const startTickIdx = Math.max(0, Math.min(maxTickIdx, Math.floor(startPlaySec / tickSec)));
  const warmupStartIdx = Math.max(0, startTickIdx - WARMUP_TICKS);

  options.onProgress?.(0.02, '初始化 720p 离线渲染器...');

  const webglCanvas = document.createElement('canvas');
  webglCanvas.width = GIF_WIDTH;
  webglCanvas.height = GIF_HEIGHT;

  const compCanvas = document.createElement('canvas');
  compCanvas.width = GIF_WIDTH;
  compCanvas.height = GIF_HEIGHT;
  const compCtx = compCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
  if (!compCtx) {
    throw new Error('无法初始化 2D 合成画布');
  }

  const silentSfx = new SoundFX();
  silentSfx.applySettings(false, 0);

  const offRenderer = new GameRenderer(
    webglCanvas,
    silentSfx,
    { width: GIF_WIDTH, height: GIF_HEIGHT },
    options.sharedCharModelCache,
  );

  try {
    const [avatars] = await Promise.all([
      Promise.all(bundle.summary.slots.map((s) => loadImage(s.avatar))),
      offRenderer.setupMatch(
        bundle.replay.mapData,
        bundle.summary.mapTheme,
        bundle.summary.slots,
        ticks[0],
        -1,
        1.0,
      ),
    ]);

    if (options.signal?.aborted) {
      throw new DOMException('已取消导出', 'AbortError');
    }

    /**
     * Resets renderer to warmupStartIdx and fast-forwards simulation state (without GPU render)
     * up to `startPlaySec` so frame 0 has seamless terrain collapse, FX trails, and camera shake.
     */
    const resetAndWarmup = (): number => {
      offRenderer.seekToReplayTick(ticks, warmupStartIdx);
      let processedIdx = warmupStartIdx;
      const warmStartSec = warmupStartIdx * tickSec;
      if (startPlaySec > warmStartSec + 1e-4) {
        const warmSteps = Math.max(1, Math.ceil((startPlaySec - warmStartSec) * GIF_FPS));
        const stepDt = (startPlaySec - warmStartSec) / warmSteps;
        for (let s = 1; s <= warmSteps; s++) {
          const simSec = warmStartSec + s * stepDt;
          const rawTickFloat = simSec / tickSec;
          const targetIdx = Math.min(maxTickIdx, Math.floor(rawTickFloat) + 1);
          while (processedIdx < targetIdx) {
            const nextIdx = processedIdx + 1;
            offRenderer.processOfflineTickEvents(ticks[nextIdx - 1], ticks[nextIdx], nextIdx * tickSec);
            processedIdx = nextIdx;
          }
          const prevSnap = ticks[Math.max(0, targetIdx - 1)];
          const currSnap = ticks[targetIdx];
          const alpha = Math.max(0, Math.min(1, rawTickFloat - (targetIdx - 1)));
          const gt = prevSnap.t + alpha;
          offRenderer.renderOfflineFrame(prevSnap, currSnap, alpha, gt, stepDt, simSec, {
            pauseClouds: true,
            skipRender: true,
          });
        }
      }
      return processedIdx;
    };

    const stepAndRenderFrame = (
      f: number,
      processedIdxRef: { value: number },
      skipRender: boolean,
    ): void => {
      const simSec = Math.min(totalEndSec, startPlaySec + f * frameDt);
      const rawTickFloat = simSec / tickSec;

      let prevSnap: TickSnapshot;
      let currSnap: TickSnapshot;
      let alpha = 1.0;
      let gt = ticks[0].t;
      let outroAlpha = 0;

      if (rawTickFloat < maxTickIdx) {
        const targetIdx = Math.min(maxTickIdx, Math.floor(rawTickFloat) + 1);
        while (processedIdxRef.value < targetIdx) {
          const nextIdx = processedIdxRef.value + 1;
          offRenderer.processOfflineTickEvents(ticks[nextIdx - 1], ticks[nextIdx], nextIdx * tickSec);
          processedIdxRef.value = nextIdx;
        }
        prevSnap = ticks[targetIdx - 1];
        currSnap = ticks[targetIdx];
        alpha = Math.max(0, Math.min(1, rawTickFloat - (targetIdx - 1)));
        gt = prevSnap.t + alpha;
      } else {
        while (processedIdxRef.value < maxTickIdx) {
          const nextIdx = processedIdxRef.value + 1;
          offRenderer.processOfflineTickEvents(ticks[nextIdx - 1], ticks[nextIdx], nextIdx * tickSec);
          processedIdxRef.value = nextIdx;
        }
        const extraSec = Math.max(0, simSec - maxTickIdx * tickSec);
        prevSnap = ticks[maxTickIdx];
        currSnap = ticks[maxTickIdx];
        alpha = 1.0;
        gt = currSnap.t + extraSec / tickSec;
        outroAlpha = Math.max(0, Math.min(1, (extraSec - 0.12) / 0.3));
      }

      const nameplates = offRenderer.renderOfflineFrame(prevSnap, currSnap, alpha, gt, frameDt, simSec, {
        pauseClouds: true,
        skipRender,
      });

      if (!skipRender) {
        compCtx.drawImage(webglCanvas, 0, 0, GIF_WIDTH, GIF_HEIGHT);
        drawBroadcastOverlay(
          compCtx,
          GIF_WIDTH,
          GIF_HEIGHT,
          bundle,
          currSnap,
          nameplates,
          avatars,
          1.0,
          outroAlpha,
        );
      }
    };

    // Pass 1: Sample up to 14 evenly spaced frames to build an accurate 255-color global palette
    options.onProgress?.(0.06, '采样画面色彩并生成调色板...');
    const sampleCount = Math.min(14, totalFrames);
    const sampleFrameSet = new Set<number>();
    for (let s = 0; s < sampleCount; s++) {
      const fi = sampleCount === 1 ? 0 : Math.round((s / (sampleCount - 1)) * (totalFrames - 1));
      sampleFrameSet.add(fi);
    }

    const maxSamplePixels = 720_000;
    const sampleBuf = new Uint8Array(maxSamplePixels * 4);
    let samplePtr = 0;
    let baseSampleFrame: Uint8ClampedArray | null = null;

    const pass1Idx = { value: resetAndWarmup() };
    let lastYieldMs = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }
      const wantSample = sampleFrameSet.has(f);
      stepAndRenderFrame(f, pass1Idx, !wantSample);

      if (wantSample) {
        const imgData = compCtx.getImageData(0, 0, GIF_WIDTH, GIF_HEIGHT).data;
        if (!baseSampleFrame) {
          baseSampleFrame = new Uint8ClampedArray(imgData);
          // Frame 0: uniform 4x4 grid captures full static map, sky, clouds, HUD
          for (let y = 0; y < GIF_HEIGHT; y += 4) {
            for (let x = 0; x < GIF_WIDTH; x += 4) {
              if (samplePtr + 4 > sampleBuf.length) break;
              const p = (y * GIF_WIDTH + x) << 2;
              sampleBuf[samplePtr++] = imgData[p];
              sampleBuf[samplePtr++] = imgData[p + 1];
              sampleBuf[samplePtr++] = imgData[p + 2];
              sampleBuf[samplePtr++] = 255;
            }
          }
        } else {
          // Subsequent samples: sparse background (stride 6) + denser changed regions (stride 2)
          // so boomerang trails, hit sparks, collapse warnings, and winner banners get crisp colors
          for (let y = 0; y < GIF_HEIGHT; y += 2) {
            const bgRow = y % 6 === 0;
            for (let x = 0; x < GIF_WIDTH; x += 2) {
              if (samplePtr + 4 > sampleBuf.length) break;
              const p = (y * GIF_WIDTH + x) << 2;
              const r = imgData[p];
              const g = imgData[p + 1];
              const b = imgData[p + 2];
              const changed =
                Math.abs(r - baseSampleFrame[p]) > 12 ||
                Math.abs(g - baseSampleFrame[p + 1]) > 12 ||
                Math.abs(b - baseSampleFrame[p + 2]) > 12;
              if (changed || (bgRow && x % 6 === 0)) {
                sampleBuf[samplePtr++] = r;
                sampleBuf[samplePtr++] = g;
                sampleBuf[samplePtr++] = b;
                sampleBuf[samplePtr++] = 255;
              }
            }
          }
        }

        const now = performance.now();
        if (now - lastYieldMs >= 20) {
          lastYieldMs = now;
          const p01 = 0.06 + ((f + 1) / totalFrames) * 0.10;
          options.onProgress?.(p01, '采样画面色彩并生成调色板...');
          await new Promise((r) => window.setTimeout(r, 0));
        }
      }
    }

    if (options.signal?.aborted) {
      throw new DOMException('已取消导出', 'AbortError');
    }

    const quantized = quantize(sampleBuf.subarray(0, samplePtr), TRANSPARENT_IDX, { format: 'rgb565' });
    const palette: PaletteColor[] = quantized.slice(0, TRANSPARENT_IDX);
    const activeColors = palette.length;
    while (palette.length < TRANSPARENT_IDX) {
      palette.push([0, 0, 0]);
    }
    palette.push([0, 0, 0]); // Index 255 reserved exclusively for transparent delta pixels

    // Build lazy persistent RGB565 -> palette index LUT (reused across all frames!)
    const palR = new Int32Array(activeColors);
    const palG = new Int32Array(activeColors);
    const palB = new Int32Array(activeColors);
    for (let i = 0; i < activeColors; i++) {
      palR[i] = palette[i][0];
      palG[i] = palette[i][1];
      palB[i] = palette[i][2];
    }
    const rgb565Lut = new Int16Array(65536).fill(-1);
    const mapRgbToPalette = (r: number, g: number, b: number): number => {
      const key = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
      const cached = rgb565Lut[key];
      if (cached >= 0) return cached;
      let bestIdx = 0;
      let bestDist = 0x7fffffff;
      for (let i = 0; i < activeColors; i++) {
        const dr = r - palR[i];
        const dg = g - palG[i];
        const db = b - palB[i];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
          if (dist === 0) break;
        }
      }
      rgb565Lut[key] = bestIdx;
      return bestIdx;
    };

    // Pass 2: Stream-render all frames, compute per-pixel transparent diff + dirty sub-rect, LZW encode
    options.onProgress?.(0.18, `编码 GIF 帧 0 / ${totalFrames}...`);
    await new Promise((r) => window.setTimeout(r, 0));

    const numPixels = GIF_WIDTH * GIF_HEIGHT;
    const prevRgba32 = new Uint32Array(numPixels);
    const prevPaletteIdx = new Uint8Array(numPixels);
    const diffFull = new Uint8Array(numPixels);
    const cropBuf = new Uint8Array(numPixels);

    const gif = GIFEncoder({ initialCapacity: 4 * 1024 * 1024 });
    const pass2Idx = { value: resetAndWarmup() };
    lastYieldMs = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }

      stepAndRenderFrame(f, pass2Idx, false);

      const img = compCtx.getImageData(0, 0, GIF_WIDTH, GIF_HEIGHT);
      const rgba = img.data;
      const curRgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, numPixels);
      const delay = FRAME_DELAYS_MS[f % 3];

      if (f === 0) {
        for (let i = 0; i < numPixels; i++) {
          prevRgba32[i] = curRgba32[i];
          const p4 = i << 2;
          prevPaletteIdx[i] = mapRgbToPalette(rgba[p4], rgba[p4 + 1], rgba[p4 + 2]);
        }
        gif.writeFrame(prevPaletteIdx, GIF_WIDTH, GIF_HEIGHT, {
          palette,
          repeat: 0,
          delay,
          colorDepth: 8,
          dispose: 1,
          transparent: false,
        });
      } else {
        let minX = GIF_WIDTH;
        let minY = GIF_HEIGHT;
        let maxX = -1;
        let maxY = -1;

        for (let y = 0; y < GIF_HEIGHT; y++) {
          const row = y * GIF_WIDTH;
          for (let x = 0; x < GIF_WIDTH; x++) {
            const i = row + x;
            const c = curRgba32[i];
            if (c === prevRgba32[i]) {
              diffFull[i] = TRANSPARENT_IDX;
              continue;
            }
            prevRgba32[i] = c;
            const p4 = i << 2;
            const idx = mapRgbToPalette(rgba[p4], rgba[p4 + 1], rgba[p4 + 2]);
            if (idx === prevPaletteIdx[i]) {
              diffFull[i] = TRANSPARENT_IDX;
              continue;
            }
            prevPaletteIdx[i] = idx;
            diffFull[i] = idx;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }

        if (maxX < minX) {
          // Identical frame: emit a 1x1 transparent sub-frame to preserve exact timing
          cropBuf[0] = TRANSPARENT_IDX;
          gif.writeFrame(cropBuf.subarray(0, 1), 1, 1, {
            delay,
            colorDepth: 8,
            dispose: 1,
            transparent: true,
            transparentIndex: TRANSPARENT_IDX,
          });
        } else {
          const dw = maxX - minX + 1;
          const dh = maxY - minY + 1;
          let dp = 0;
          for (let y = minY; y <= maxY; y++) {
            const srcRow = y * GIF_WIDTH + minX;
            cropBuf.set(diffFull.subarray(srcRow, srcRow + dw), dp);
            dp += dw;
          }

          const posBefore = gif.stream.bytesView().length;
          gif.writeFrame(cropBuf.subarray(0, dp), dw, dh, {
            delay,
            colorDepth: 8,
            dispose: 1,
            transparent: true,
            transparentIndex: TRANSPARENT_IDX,
          });
          // Patch GIF89a Image Descriptor left/top offset (after 8-byte GCE + 0x2c separator)
          const view = gif.stream.bytesView();
          if (view[posBefore + 8] === 0x2c) {
            view[posBefore + 9] = minX & 0xff;
            view[posBefore + 10] = (minX >> 8) & 0xff;
            view[posBefore + 11] = minY & 0xff;
            view[posBefore + 12] = (minY >> 8) & 0xff;
          }
        }
      }

      const now = performance.now();
      if (now - lastYieldMs >= 20 || f === totalFrames - 1) {
        lastYieldMs = now;
        const pct = 0.18 + ((f + 1) / totalFrames) * 0.80;
        options.onProgress?.(pct, `渲染并编码 GIF 帧 ${f + 1} / ${totalFrames}...`);
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }

    if (options.signal?.aborted) {
      throw new DOMException('已取消导出', 'AbortError');
    }

    options.onProgress?.(0.99, '封装 GIF 文件...');
    gif.finish();
    const outBytes = gif.bytes();
    const blob = new Blob([outBytes], { type: 'image/gif' });
    const filename = buildGifFilename(bundle, startPlaySec, endPlaySec);
    options.onProgress?.(1.0, '导出完成');

    return {
      blob,
      filename,
      width: GIF_WIDTH,
      height: GIF_HEIGHT,
      fps: GIF_FPS,
      frameCount: totalFrames,
      startSec: startPlaySec,
      endSec: endPlaySec,
      durationSec: clipDurationSec,
      sizeBytes: blob.size,
    };
  } finally {
    offRenderer.dispose();
  }
}

export function triggerGifDownload(blob: Blob, filename: string) {
  triggerMp4Download(blob, filename);
}
