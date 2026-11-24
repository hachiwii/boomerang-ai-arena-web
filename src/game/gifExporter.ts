import { GIFEncoder, PaletteColor, quantize } from 'gifenc';
import { SoundFX } from '../audio/sfx';
import { GameRenderer } from '../render/renderer';
import { VoxelModelData } from '../render/voxelBuilder';
import { CinematicDirector, normalizeCinematicOptions } from './killCamDirector';
import { MatchReplayBundle } from './matchHistory';
import { drawBroadcastOverlay, loadImage, triggerMp4Download } from './mp4Exporter';
import { CinematicOptions, GraphicsQualityOption } from './settings';
import { LOGIC_DT_MS, TickSnapshot } from './types';

export interface GifClipExportOptions {
  /** Current replay tick index (`0 .. ticks.length - 1`) to capture backwards from. */
  endTickIndex: number;
  /** Maximum clip duration in seconds (default 10s). */
  maxDurationSec?: number;
  /** Graphics quality tier ('low' | 'high'). */
  graphicsQuality?: GraphicsQualityOption;
  /** Granular cinematic camera toggles (killCam, finisherCam, winnerCam). */
  cinematic?: boolean | Partial<CinematicOptions>;
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

const GIF_FPS = 24;
const DEFAULT_MAX_CLIP_SEC = 10.0;
// Short post-kill impact tail when finisherCam is off (0.16s = 3.2 ticks, strictly below WINNER_CELEBRATE_DELAY_TICKS = 4.0)
const NO_FINISHER_END_TAIL_SEC = 0.16;
const WARMUP_TICKS = 30; // 1.5s pre-roll so trails/particles are warm at clip start
// Keep every 10s High-Quality GIF comfortably under 10 MB even with nonstop close-up camera pans!
const TARGET_MAX_GIF_BYTES = Math.round(9.4 * 1024 * 1024);
// 5x40ms + 50ms = 250ms per 6 frames => exact 24.000 fps in GIF 10ms centisecond timing
const FRAME_DELAYS_MS = [40, 40, 40, 40, 40, 50] as const;

interface GifResolutionAttempt {
  width: number;
  height: number;
  tag: string;
  colorDepth: 6 | 7;
  diffErrSq: number;
  despeckleErrSq: number;
}

const GIF_ATTEMPTS: GifResolutionAttempt[] = [
  // Tier 0: Full 720p with 7-bit (127+1) palette — ideal for static-camera or Low-Quality clips
  { width: 1280, height: 720, tag: '720p', colorDepth: 7, diffErrSq: 170, despeckleErrSq: 320 },
  // Tier 1: Crisp 540p with 6-bit (63+1) LZW palette — huge ~55% savings on HQ close-up camera pans
  { width: 960, height: 540, tag: '540p', colorDepth: 6, diffErrSq: 230, despeckleErrSq: 440 },
  // Tier 2: Compact 450p with 6-bit (63+1) LZW palette — hard < 10 MB guarantee for extreme worst-case clips
  { width: 800, height: 450, tag: '450p', colorDepth: 6, diffErrSq: 280, despeckleErrSq: 520 },
];

function buildGifFilename(
  bundle: MatchReplayBundle,
  startSec: number,
  endSec: number,
  resTag: string,
): string {
  const { summary } = bundle;
  const d = new Date(summary.playedAt || Date.now());
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const modeTag =
    summary.matchMode === 'ranked-solo'
      ? 'solo'
      : summary.matchMode === 'ranked-ffa'
        ? 'ffa'
        : summary.matchMode === 'cricket'
          ? 'cricket'
          : 'custom';
  const sTag = `${startSec.toFixed(1)}s`;
  const eTag = `${endSec.toFixed(1)}s`;
  return `boomerang_${modeTag}_${summary.mapId}_${stamp}_${sTag}-${eTag}_${resTag}_${GIF_FPS}fps.gif`;
}

/**
 * Exports up to the last `maxDurationSec` (default 10s) leading up to `endTickIndex`
 * as a compact 24fps animated GIF guaranteed under 10 MB even on High-Quality maps:
 * - Freezes background clouds, tall grass sway, waterfalls, and micro screen-shake, and hides
 *   ambient falling petals/snow/leaves; stops cleanly at the end of the finisher shot without
 *   winner celebration or close-up outro
 * - Uses 7-bit / 6-bit global palettes, perceptual delta dead-zone against displayed palette RGB,
 *   and isolated 1-pixel grain despeckling for dramatically longer LZW runs
 * - Automatically adapts resolution/palette tier (720p -> 540p -> 450p) to stay under 9.4 MB.
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
  const baseCinematic = normalizeCinematicOptions(options.cinematic ?? false);
  // GIF exports stop right at the end of the finisher shot and omit the post-match celebration / winner close-up.
  const director = new CinematicDirector(ticks, bundle.replay.mapData, {
    killCam: baseCinematic.killCam,
    finisherCam: baseCinematic.finisherCam,
    winnerCam: false,
    killFx: baseCinematic.killFx,
  });

  const endPlaySimSec = endTickIndex * tickSec;
  const endPlayRealSec = director.simToReal(endPlaySimSec);
  const atMatchEnd = endTickIndex >= maxTickIdx && Boolean(ticks[maxTickIdx]?.over);
  const finisherEndRealSec = atMatchEnd ? director.getFinisherEndRealSec() : null;
  const outroRealSec = atMatchEnd
    ? finisherEndRealSec !== null
      ? Math.max(0, finisherEndRealSec - endPlayRealSec)
      : Math.max(
          NO_FINISHER_END_TAIL_SEC,
          director.simToReal(endPlaySimSec + NO_FINISHER_END_TAIL_SEC) - endPlayRealSec,
        )
    : 0;
  const totalEndRealSec = endPlayRealSec + outroRealSec;
  const startRealSec = Math.max(0, totalEndRealSec - maxDurationSec);
  const clipDurationSec = Math.max(tickSec, totalEndRealSec - startRealSec);
  const startPlaySimSec = director.realToSim(startRealSec);
  const totalFrames = Math.max(
    2,
    Math.min(Math.round(maxDurationSec * GIF_FPS), Math.round(clipDurationSec * GIF_FPS)),
  );
  const frameDt = 1 / GIF_FPS;

  const startTickIdx = Math.max(0, Math.min(maxTickIdx, Math.floor(startPlaySimSec / tickSec)));
  const warmupStartIdx = Math.max(0, startTickIdx - WARMUP_TICKS);

  // Pre-estimate camera-motion frame count in < 0.2ms so HQ clips packed with close-up camera pans
  // jump straight to compact 540p 6-bit encoding instead of wasting a pass on a doomed 720p stream!
  let movingCamFrames = 0;
  if (director.isEnabled()) {
    const dummyOvPos = { x: 9, y: 24, z: 22 };
    const dummyOvLook = { x: 9, y: 0, z: 6 };
    let prevX = dummyOvPos.x;
    let prevY = dummyOvPos.y;
    let prevZ = dummyOvPos.z;
    for (let f = 0; f < totalFrames; f++) {
      const realSec = Math.min(totalEndRealSec, startRealSec + f * frameDt);
      const simSec = director.realToSim(realSec);
      const pose = director.evaluate(simSec, dummyOvPos, dummyOvLook);
      const moved =
        Math.abs(pose.pos.x - prevX) + Math.abs(pose.pos.y - prevY) + Math.abs(pose.pos.z - prevZ);
      if (f > 0 && moved > 0.015) movingCamFrames++;
      prevX = pose.pos.x;
      prevY = pose.pos.y;
      prevZ = pose.pos.z;
    }
  }

  const startAttemptIdx =
    (options.graphicsQuality ?? 'high') === 'high' && movingCamFrames >= 55 ? 1 : 0;

  options.onProgress?.(0.02, '加载角色头像与离线渲染器...');
  const avatars = await Promise.all(bundle.summary.slots.map((s) => loadImage(s.avatar)));

  const encodeAtResolution = async (
    attempt: GifResolutionAttempt,
    isFinalAttempt: boolean,
  ): Promise<{ bytes: Uint8Array; exceededBudget: boolean }> => {
    const gifW = attempt.width;
    const gifH = attempt.height;
    const colorDepth = attempt.colorDepth;
    const transparentIdx = (1 << colorDepth) - 1; // 127 (7-bit) or 63 (6-bit)
    const errThreshSq = attempt.diffErrSq;
    const despeckleErrSq = attempt.despeckleErrSq;

    const webglCanvas = document.createElement('canvas');
    webglCanvas.width = gifW;
    webglCanvas.height = gifH;

    const compCanvas = document.createElement('canvas');
    compCanvas.width = gifW;
    compCanvas.height = gifH;
    const compCtx = compCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!compCtx) {
      throw new Error('无法初始化 2D 合成画布');
    }

    const silentSfx = new SoundFX();
    silentSfx.applySettings(false, 0);

    const offRenderer = new GameRenderer(
      webglCanvas,
      silentSfx,
      { width: gifW, height: gifH },
      options.sharedCharModelCache,
      options.graphicsQuality ?? 'high',
    );

    try {
      await offRenderer.setupMatch(
        bundle.replay.mapData,
        bundle.summary.mapTheme,
        bundle.summary.slots,
        ticks[0],
        -1,
        1.0,
      );

      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }

      offRenderer.setCinematicDirector(director);

      // Freeze background clouds, tall grass sway, waterfalls, and hide ambient falling petals/snow/leaves
      // while preserving hit-impact screen shake and winner close-up confetti ribbons!
      const staticGifEnvOpts = {
        pauseClouds: true,
        hideAmbient: true,
        pauseGrass: true,
        pauseWaterfall: true,
      };

      const resetAndWarmup = (): { processedIdx: number; prevSimSec: number } => {
        offRenderer.seekToReplayTick(ticks, warmupStartIdx);
        let processedIdx = warmupStartIdx;
        const warmStartSec = warmupStartIdx * tickSec;
        if (startPlaySimSec > warmStartSec + 1e-4) {
          const warmSteps = Math.max(1, Math.ceil((startPlaySimSec - warmStartSec) * GIF_FPS));
          const stepDt = (startPlaySimSec - warmStartSec) / warmSteps;
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
              ...staticGifEnvOpts,
              skipRender: true,
            });
          }
        }
        return { processedIdx, prevSimSec: startPlaySimSec };
      };

      const stepAndRenderFrame = (
        f: number,
        stateRef: { processedIdx: number; prevSimSec: number },
        skipRender: boolean,
      ): void => {
        const realSec = Math.min(totalEndRealSec, startRealSec + f * frameDt);
        const simSec = director.realToSim(realSec);
        const frameDtSim = Math.max(
          0,
          f === 0 ? frameDt * director.getSpeedScaleAtSim(simSec) : simSec - stateRef.prevSimSec,
        );
        stateRef.prevSimSec = simSec;
        const rawTickFloat = simSec / tickSec;

        let prevSnap: TickSnapshot;
        let currSnap: TickSnapshot;
        let alpha = 1.0;
        let gt = ticks[0].t;
        let outroAlpha = 0;

        if (rawTickFloat < maxTickIdx) {
          const targetIdx = Math.min(maxTickIdx, Math.floor(rawTickFloat) + 1);
          while (stateRef.processedIdx < targetIdx) {
            const nextIdx = stateRef.processedIdx + 1;
            offRenderer.processOfflineTickEvents(ticks[nextIdx - 1], ticks[nextIdx], nextIdx * tickSec);
            stateRef.processedIdx = nextIdx;
          }
          prevSnap = ticks[targetIdx - 1];
          currSnap = ticks[targetIdx];
          alpha = Math.max(0, Math.min(1, rawTickFloat - (targetIdx - 1)));
          gt = prevSnap.t + alpha;
        } else {
          while (stateRef.processedIdx < maxTickIdx) {
            const nextIdx = stateRef.processedIdx + 1;
            offRenderer.processOfflineTickEvents(ticks[nextIdx - 1], ticks[nextIdx], nextIdx * tickSec);
            stateRef.processedIdx = nextIdx;
          }
          const extraSimSec = Math.min(NO_FINISHER_END_TAIL_SEC, Math.max(0, simSec - maxTickIdx * tickSec));
          prevSnap = ticks[maxTickIdx];
          currSnap = ticks[maxTickIdx];
          alpha = 1.0;
          gt = currSnap.t + extraSimSec / tickSec;
          outroAlpha = 0;
        }

        const nameplates = offRenderer.renderOfflineFrame(prevSnap, currSnap, alpha, gt, frameDtSim, simSec, {
          ...staticGifEnvOpts,
          skipRender,
          realSec,
          realFrameDt: frameDt,
        });

        if (!skipRender) {
          compCtx.drawImage(webglCanvas, 0, 0, gifW, gifH);
          drawBroadcastOverlay(
            compCtx,
            gifW,
            gifH,
            bundle,
            currSnap,
            nameplates,
            avatars,
            1.0,
            outroAlpha,
          );
        }
      };

      // Pass 1: Sample up to 14 evenly spaced frames uniformly (stride 4) so overview,
      // eye-level kill-cam, and winner close-up all receive balanced palette coverage!
      options.onProgress?.(0.06, `采样 ${attempt.tag} 画面色彩并生成 ${transparentIdx + 1} 色调色板...`);
      const sampleCount = Math.min(14, totalFrames);
      const sampleFrameSet = new Set<number>();
      for (let s = 0; s < sampleCount; s++) {
        const fi = sampleCount === 1 ? 0 : Math.round((s / (sampleCount - 1)) * (totalFrames - 1));
        sampleFrameSet.add(fi);
      }

      const stride = 4;
      const pixelsPerSample = Math.ceil(gifW / stride) * Math.ceil(gifH / stride);
      const sampleBuf = new Uint8Array(sampleCount * pixelsPerSample * 4);
      let samplePtr = 0;

      const pass1State = resetAndWarmup();
      let lastYieldMs = performance.now();

      for (let f = 0; f < totalFrames; f++) {
        if (options.signal?.aborted) {
          throw new DOMException('已取消导出', 'AbortError');
        }
        const wantSample = sampleFrameSet.has(f);
        stepAndRenderFrame(f, pass1State, !wantSample);

        if (wantSample) {
          const imgData = compCtx.getImageData(0, 0, gifW, gifH).data;
          for (let y = 0; y < gifH; y += stride) {
            for (let x = 0; x < gifW; x += stride) {
              if (samplePtr + 4 > sampleBuf.length) break;
              const p = (y * gifW + x) << 2;
              sampleBuf[samplePtr++] = imgData[p];
              sampleBuf[samplePtr++] = imgData[p + 1];
              sampleBuf[samplePtr++] = imgData[p + 2];
              sampleBuf[samplePtr++] = 255;
            }
          }

          const now = performance.now();
          if (now - lastYieldMs >= 20) {
            lastYieldMs = now;
            const p01 = 0.06 + ((f + 1) / totalFrames) * 0.1;
            options.onProgress?.(p01, `采样 ${attempt.tag} 画面色彩并生成调色板...`);
            await new Promise((r) => window.setTimeout(r, 0));
          }
        }
      }

      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }

      const quantized = quantize(sampleBuf.subarray(0, samplePtr), transparentIdx, { format: 'rgb565' });
      const palette: PaletteColor[] = quantized.slice(0, transparentIdx);
      const activeColors = palette.length;
      while (palette.length < transparentIdx) {
        palette.push([0, 0, 0]);
      }
      palette.push([0, 0, 0]); // Final index reserved exclusively for transparent delta pixels

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

      // Isolated 1-pixel grain despeckle along horizontal LZW scanlines:
      // Snaps `A, B, A -> A, A, A` ONLY when B is perceptually close to A (preserves every sharp edge & HUD glyph!).
      const despeckleScanline = (buf: Uint8Array, yStart: number, yEnd: number, xStart: number, xEnd: number) => {
        if (xEnd - xStart < 2) return;
        for (let y = yStart; y <= yEnd; y++) {
          const row = y * gifW;
          for (let x = xStart + 1; x < xEnd; x++) {
            const idx = row + x;
            const c = buf[idx];
            if (c === transparentIdx) continue;
            const left = buf[idx - 1];
            if (left === c || left === transparentIdx) continue;
            if (buf[idx + 1] === left) {
              const dr = palR[c] - palR[left];
              const dg = palG[c] - palG[left];
              const db = palB[c] - palB[left];
              if (dr * dr + dg * dg + db * db <= despeckleErrSq) {
                buf[idx] = left;
              }
            }
          }
        }
      };

      // Pass 2: Stream-render all frames, perceptual transparent diff + despeckle + dirty sub-rect, LZW encode
      options.onProgress?.(0.18, `编码 ${attempt.tag} GIF 帧 0 / ${totalFrames}...`);
      await new Promise((r) => window.setTimeout(r, 0));

      const numPixels = gifW * gifH;
      const prevRgba32 = new Uint32Array(numPixels);
      const prevPaletteIdx = new Uint8Array(numPixels);
      const diffFull = new Uint8Array(numPixels);
      const cropBuf = new Uint8Array(numPixels);

      const gif = GIFEncoder({ initialCapacity: 4 * 1024 * 1024 });
      const pass2State = resetAndWarmup();
      lastYieldMs = performance.now();

      for (let f = 0; f < totalFrames; f++) {
        if (options.signal?.aborted) {
          throw new DOMException('已取消导出', 'AbortError');
        }

        stepAndRenderFrame(f, pass2State, false);

        const img = compCtx.getImageData(0, 0, gifW, gifH);
        const rgba = img.data;
        const curRgba32 = new Uint32Array(rgba.buffer, rgba.byteOffset, numPixels);
        const delay = FRAME_DELAYS_MS[f % FRAME_DELAYS_MS.length];

        if (f === 0) {
          for (let i = 0; i < numPixels; i++) {
            prevRgba32[i] = curRgba32[i];
            const p4 = i << 2;
            prevPaletteIdx[i] = mapRgbToPalette(rgba[p4], rgba[p4 + 1], rgba[p4 + 2]);
          }
          despeckleScanline(prevPaletteIdx, 0, gifH - 1, 0, gifW - 1);
          gif.writeFrame(prevPaletteIdx, gifW, gifH, {
            palette,
            repeat: 0,
            delay,
            colorDepth,
            dispose: 1,
            transparent: false,
          });
        } else {
          let minX = gifW;
          let minY = gifH;
          let maxX = -1;
          let maxY = -1;

          for (let y = 0; y < gifH; y++) {
            const row = y * gifW;
            for (let x = 0; x < gifW; x++) {
              const i = row + x;
              const c = curRgba32[i];
              if (c === prevRgba32[i]) {
                diffFull[i] = transparentIdx;
                continue;
              }
              prevRgba32[i] = c;
              const p4 = i << 2;
              const r = rgba[p4];
              const g = rgba[p4 + 1];
              const b = rgba[p4 + 2];

              // Compare against the ACTUAL currently displayed palette RGB so minor AA/lighting jitter
              // stays transparent without ever accumulating color drift!
              const prevIdx = prevPaletteIdx[i];
              const dr = r - palR[prevIdx];
              const dg = g - palG[prevIdx];
              const db = b - palB[prevIdx];
              if (dr * dr + dg * dg + db * db <= errThreshSq) {
                diffFull[i] = transparentIdx;
                continue;
              }

              const idx = mapRgbToPalette(r, g, b);
              if (idx === prevIdx) {
                diffFull[i] = transparentIdx;
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
            cropBuf[0] = transparentIdx;
            gif.writeFrame(cropBuf.subarray(0, 1), 1, 1, {
              delay,
              colorDepth,
              dispose: 1,
              transparent: true,
              transparentIndex: transparentIdx,
            });
          } else {
            // Despeckle 1-pixel grain inside dirty region & sync prevPaletteIdx so displayed pixel matches exact written pixel
            if (maxX - minX >= 2) {
              for (let y = minY; y <= maxY; y++) {
                const row = y * gifW;
                for (let x = minX + 1; x < maxX; x++) {
                  const idx = row + x;
                  const c = diffFull[idx];
                  if (c === transparentIdx) continue;
                  const left = diffFull[idx - 1];
                  if (left === c || left === transparentIdx) continue;
                  if (diffFull[idx + 1] === left) {
                    const dr = palR[c] - palR[left];
                    const dg = palG[c] - palG[left];
                    const db = palB[c] - palB[left];
                    if (dr * dr + dg * dg + db * db <= despeckleErrSq) {
                      diffFull[idx] = left;
                      prevPaletteIdx[idx] = left;
                    }
                  }
                }
              }
            }

            const dw = maxX - minX + 1;
            const dh = maxY - minY + 1;
            let dp = 0;
            for (let y = minY; y <= maxY; y++) {
              const srcRow = y * gifW + minX;
              cropBuf.set(diffFull.subarray(srcRow, srcRow + dw), dp);
              dp += dw;
            }

            const posBefore = gif.stream.bytesView().length;
            gif.writeFrame(cropBuf.subarray(0, dp), dw, dh, {
              delay,
              colorDepth,
              dispose: 1,
              transparent: true,
              transparentIndex: transparentIdx,
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

          // Bail out early if stream exceeds our 9.4 MB budget so we can step down cleanly to next tier!
          if (!isFinalAttempt && gif.stream.bytesView().length > TARGET_MAX_GIF_BYTES) {
            return { bytes: new Uint8Array(0), exceededBudget: true };
          }
        }

        const now = performance.now();
        if (now - lastYieldMs >= 20 || f === totalFrames - 1) {
          lastYieldMs = now;
          const pct = 0.18 + ((f + 1) / totalFrames) * 0.8;
          options.onProgress?.(pct, `渲染并编码 ${attempt.tag} GIF 帧 ${f + 1} / ${totalFrames}...`);
          await new Promise((r) => window.setTimeout(r, 0));
        }
      }

      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }

      options.onProgress?.(0.99, '封装 GIF 文件...');
      gif.finish();
      return { bytes: gif.bytes(), exceededBudget: false };
    } finally {
      offRenderer.dispose();
    }
  };

  let chosenAttempt = GIF_ATTEMPTS[startAttemptIdx];
  let outBytes: Uint8Array = new Uint8Array(0);
  for (let ai = startAttemptIdx; ai < GIF_ATTEMPTS.length; ai++) {
    const attempt = GIF_ATTEMPTS[ai];
    const isLast = ai === GIF_ATTEMPTS.length - 1;
    const res = await encodeAtResolution(attempt, isLast);
    if (!res.exceededBudget || isLast) {
      chosenAttempt = attempt;
      outBytes = res.bytes;
      break;
    }
    const nextTag = GIF_ATTEMPTS[ai + 1]?.tag || '450p';
    options.onProgress?.(0.05, `${attempt.tag} 超过 9.4 MB，自动切换 ${nextTag} 压缩导出...`);
  }

  const blob = new Blob([new Uint8Array(outBytes)], { type: 'image/gif' });
  const filename = buildGifFilename(bundle, startPlaySimSec, endPlaySimSec, chosenAttempt.tag);
  options.onProgress?.(1.0, '导出完成');

  return {
    blob,
    filename,
    width: chosenAttempt.width,
    height: chosenAttempt.height,
    fps: GIF_FPS,
    frameCount: totalFrames,
    startSec: startPlaySimSec,
    endSec: endPlaySimSec,
    durationSec: clipDurationSec,
    sizeBytes: blob.size,
  };
}

export function triggerGifDownload(blob: Blob, filename: string) {
  triggerMp4Download(blob, filename);
}
