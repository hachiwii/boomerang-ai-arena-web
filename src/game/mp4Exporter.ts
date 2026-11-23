import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { SoundFX } from '../audio/sfx';
import { GameRenderer, ProjectedNameplate } from '../render/renderer';
import { VoxelModelData } from '../render/voxelBuilder';
import { CinematicDirector } from './killCamDirector';
import { MatchReplayBundle } from './matchHistory';
import {
  CinematicOptions,
  ExportBitrateOption,
  ExportResolutionOption,
  ExportSpeedOption,
  getExportResolutionSpec,
  GraphicsQualityOption,
} from './settings';
import { DState, LOGIC_DT_MS, SlotConfig, TickSnapshot } from './types';

export interface Mp4ExportOptions {
  resolution: ExportResolutionOption;
  bitrateMbps: ExportBitrateOption;
  speed: ExportSpeedOption;
  soundEnabled: boolean;
  volumePct: number;
  graphicsQuality?: GraphicsQualityOption;
  cinematic?: boolean | Partial<CinematicOptions>;
  sharedCharModelCache?: Map<string, VoxelModelData>;
  signal?: AbortSignal;
  onProgress?: (progress01: number, phaseText: string) => void;
}

export interface Mp4ExportResult {
  blob: Blob;
  filename: string;
  width: number;
  height: number;
  durationSec: number;
  hasAudio: boolean;
  sizeBytes: number;
}

const EXPORT_FPS = 60;
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 128_000;
const LEAD_IN_SEC = 0.25;
const OUTRO_SEC = 1.45;

function dartBadgeInfo(st: number): { text: string; bg: string; fg: string } {
  switch (st) {
    case DState.HAND:
      return { text: '持镖', bg: 'rgba(76, 196, 128, 0.28)', fg: '#8af0b6' };
    case DState.OUT:
    case DState.BACK:
    case DState.CALL:
      return { text: '飞行', bg: 'rgba(255, 180, 50, 0.28)', fg: '#ffe08a' };
    case DState.GROUND:
      return { text: '落地', bg: 'rgba(255, 95, 95, 0.28)', fg: '#ffa6a6' };
    case DState.RISE:
      return { text: '召回', bg: 'rgba(88, 178, 255, 0.32)', fg: '#a8dcff' };
    default:
      return { text: '无镖', bg: 'rgba(255, 255, 255, 0.14)', fg: '#9ea8bf' };
  }
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

export function loadImage(src: string | null): Promise<HTMLImageElement | null> {
  if (!src) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function pickSupportedVideoConfig(
  width: number,
  height: number,
  bitrateBps: number,
): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoEncoder.isConfigSupported !== 'function') {
    return null;
  }

  const codecsByHeight =
    height >= 1440
      ? ['avc1.640033', 'avc1.640032', 'avc1.4d0033', 'avc1.4d0032', 'avc1.420033']
      : height >= 1080
        ? ['avc1.64002a', 'avc1.640032', 'avc1.4d002a', 'avc1.42002a']
        : height >= 720
          ? ['avc1.640020', 'avc1.64002a', 'avc1.4d0020', 'avc1.4d002a', 'avc1.420020']
          : ['avc1.64001f', 'avc1.640020', 'avc1.4d001f', 'avc1.42001f'];

  const hwModes: HardwareAcceleration[] = ['prefer-hardware', 'no-preference', 'prefer-software'];
  for (const hardwareAcceleration of hwModes) {
    for (const codec of codecsByHeight) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: bitrateBps,
        framerate: EXPORT_FPS,
        hardwareAcceleration,
        avc: { format: 'avc' },
      };
      try {
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) {
          return res.config || cfg;
        }
      } catch {
        // Try next codec
      }
    }
  }
  return null;
}

async function pickSupportedAudioConfig(): Promise<AudioEncoderConfig | null> {
  if (
    typeof AudioEncoder === 'undefined' ||
    typeof AudioEncoder.isConfigSupported !== 'function' ||
    typeof OfflineAudioContext === 'undefined'
  ) {
    return null;
  }
  const cfg: AudioEncoderConfig = {
    codec: 'mp4a.40.2',
    sampleRate: AUDIO_SAMPLE_RATE,
    numberOfChannels: AUDIO_CHANNELS,
    bitrate: AUDIO_BITRATE,
  };
  try {
    const res = await AudioEncoder.isConfigSupported(cfg);
    if (res.supported) return res.config || cfg;
  } catch {
    // Fallback to silent video-only MP4
  }
  return null;
}

function buildExportFilename(
  bundle: MatchReplayBundle,
  resolution: ExportResolutionOption,
  speed: number,
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
        : 'custom';
  const spdTag = speed === 1 ? '1x' : `${speed}x`;
  return `boomerang_${modeTag}_${summary.mapId}_${stamp}_${resolution}_${spdTag}.mp4`;
}

export function drawBroadcastOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bundle: MatchReplayBundle,
  state: TickSnapshot,
  nameplates: ProjectedNameplate[],
  avatars: (HTMLImageElement | null)[],
  speed: number,
  outroAlpha: number,
) {
  const s = height / 720;
  const fontStack = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", Roboto, sans-serif';
  const { summary, replay } = bundle;
  const slots: SlotConfig[] = summary.slots;

  ctx.save();
  ctx.textBaseline = 'middle';

  // 1. Floating 3D Nameplates
  for (const np of nameplates) {
    if (!np.visible) continue;
    const slot = slots[np.seat];
    if (!slot) continue;
    const isHuman = slot.kind === 'human';
    const fontSize = Math.round(11.5 * s);
    ctx.font = `700 ${fontSize}px ${fontStack}`;
    const txtW = ctx.measureText(slot.displayName).width;
    const dotR = 3.5 * s;
    const padX = 8 * s;
    const gap = 5 * s;
    const pillW = padX * 2 + dotR * 2 + gap + txtW;
    const pillH = 22 * s;
    const px = np.x - pillW * 0.5;
    const py = np.y - pillH;

    ctx.save();
    ctx.globalAlpha = np.opacity;
    drawRoundRect(ctx, px, py, pillW, pillH, pillH * 0.5);
    ctx.fillStyle = isHuman ? 'rgba(20, 42, 82, 0.90)' : 'rgba(14, 19, 32, 0.80)';
    ctx.fill();
    ctx.lineWidth = 1.1 * s;
    ctx.strokeStyle = isHuman ? '#66a3ff' : 'rgba(255, 255, 255, 0.22)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px + padX + dotR, py + pillH * 0.5, dotR, 0, Math.PI * 2);
    ctx.fillStyle = slot.ringAccent || slot.color;
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.fillText(slot.displayName, px + padX + dotR * 2 + gap, py + pillH * 0.52);
    ctx.restore();
  }

  // 2. Top-Left Player Cards
  const pad = 14 * s;
  const cardW = 146 * s;
  const cardH = 50 * s;
  const cardGap = 8 * s;
  const maxCols = Math.max(1, Math.min(slots.length, 2));
  for (let i = 0; i < slots.length && i < state.players.length; i++) {
    const slot = slots[i];
    const p = state.players[i];
    const d = state.darts[i];
    const col = i % maxCols;
    const row = Math.floor(i / maxCols);
    const x = pad + col * (cardW + cardGap);
    const y = pad + row * (cardH + cardGap);
    const alive = p.alive === 1;
    const accent = slot.ringAccent || slot.color;

    ctx.save();
    if (!alive) ctx.globalAlpha = 0.45;
    drawRoundRect(ctx, x, y, cardW, cardH, 10 * s);
    ctx.fillStyle = 'rgba(15, 21, 36, 0.84)';
    ctx.fill();
    ctx.lineWidth = 1.2 * s;
    ctx.strokeStyle = slot.kind === 'human' ? 'rgba(102, 163, 255, 0.65)' : 'rgba(255, 255, 255, 0.16)';
    ctx.stroke();

    // Colored left accent stripe
    ctx.save();
    drawRoundRect(ctx, x, y, cardW, cardH, 10 * s);
    ctx.clip();
    ctx.fillStyle = accent;
    ctx.fillRect(x, y, 4 * s, cardH);
    ctx.restore();

    // Avatar
    const avSize = 32 * s;
    const avX = x + 10 * s;
    const avY = y + (cardH - avSize) * 0.5;
    drawRoundRect(ctx, avX, avY, avSize, avSize, 7 * s);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.fill();
    const avImg = avatars[i];
    if (avImg) {
      ctx.save();
      drawRoundRect(ctx, avX, avY, avSize, avSize, 7 * s);
      ctx.clip();
      ctx.drawImage(avImg, avX, avY, avSize, avSize);
      ctx.restore();
    }

    const metaX = avX + avSize + 7 * s;
    const metaW = x + cardW - metaX - 8 * s;

    // Name (clipped cleanly to card)
    ctx.save();
    ctx.beginPath();
    ctx.rect(metaX, y + 4 * s, metaW, 18 * s);
    ctx.clip();
    ctx.font = `800 ${Math.round(12 * s)}px ${fontStack}`;
    ctx.fillStyle = '#f4f7ff';
    ctx.textAlign = 'left';
    ctx.fillText(slot.displayName, metaX, y + 14 * s);
    ctx.restore();

    // Dart status pill + kills
    const badge = alive
      ? dartBadgeInfo(d.st)
      : { text: '出局', bg: 'rgba(255, 255, 255, 0.14)', fg: '#9ea8bf' };
    const badgeFont = Math.round(9.5 * s);
    ctx.font = `800 ${badgeFont}px ${fontStack}`;
    const bTxtW = ctx.measureText(badge.text).width;
    const bW = bTxtW + 8 * s;
    const bH = 14 * s;
    const bY = y + 23 * s;
    drawRoundRect(ctx, metaX, bY, bW, bH, 4 * s);
    ctx.fillStyle = badge.bg;
    ctx.fill();
    ctx.fillStyle = badge.fg;
    ctx.textAlign = 'center';
    ctx.fillText(badge.text, metaX + bW * 0.5, bY + bH * 0.52);

    ctx.font = `700 ${Math.round(10.5 * s)}px ${fontStack}`;
    ctx.fillStyle = '#a8b5d1';
    ctx.textAlign = 'left';
    ctx.fillText(`${p.kills} 击杀`, metaX + bW + 5 * s, bY + bH * 0.52);

    // Dash CD bar
    const cdY = y + cardH - 8 * s;
    const cdH = 3 * s;
    drawRoundRect(ctx, metaX, cdY, metaW, cdH, cdH * 0.5);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.fill();
    const readyPct = alive ? Math.max(0, Math.min(1, 1 - p.cd / 20)) : 0;
    if (readyPct > 0) {
      drawRoundRect(ctx, metaX, cdY, metaW * readyPct, cdH, cdH * 0.5);
      ctx.fillStyle = accent;
      ctx.fill();
    }

    ctx.restore();
  }

  // 3. Top-Center Match Pill
  const modeTag =
    summary.matchMode === 'ranked-solo'
      ? 'SOLO 排位'
      : summary.matchMode === 'ranked-ffa'
        ? '混战排位'
        : '自定义';
  const topTitle = `${summary.mapTitle} · ${modeTag}`;
  const remSec = Math.max(0, (800 - state.t) / 20);
  const timerStr = `${remSec.toFixed(1)}s`;
  const colStart = replay.mapData.colStart ?? 240;
  let colStr = `已塌陷 ${state.fallen} 波`;
  let colWarn = false;
  if (state.warn >= 0) {
    colStr = `⚠ 第 ${state.warn + 1} 波即将塌陷!`;
    colWarn = true;
  } else if (state.t < colStart) {
    colStr = `塌陷倒计时 ${Math.ceil((colStart - state.t) / 20)}s`;
  }

  ctx.font = `700 ${Math.round(11 * s)}px ${fontStack}`;
  const titleW = ctx.measureText(topTitle).width;
  const colW = ctx.measureText(colStr).width;
  const centerW = Math.max(156 * s, Math.max(titleW, colW) + 34 * s);
  const centerH = 66 * s;
  const centerX = (width - centerW) * 0.5;
  const centerY = pad;

  drawRoundRect(ctx, centerX, centerY, centerW, centerH, 13 * s);
  ctx.fillStyle = 'rgba(15, 21, 36, 0.84)';
  ctx.fill();
  ctx.lineWidth = 1.2 * s;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.font = `700 ${Math.round(11 * s)}px ${fontStack}`;
  ctx.fillStyle = '#a8b5d1';
  ctx.fillText(topTitle, width * 0.5, centerY + 14 * s);

  ctx.font = `900 ${Math.round(21 * s)}px ${fontStack}`;
  ctx.fillStyle = remSec < 10 ? '#ff6b6b' : '#f4f7ff';
  ctx.fillText(timerStr, width * 0.5, centerY + 35 * s);

  ctx.font = `700 ${Math.round(11 * s)}px ${fontStack}`;
  ctx.fillStyle = colWarn ? '#ff8e47' : '#a6c4f0';
  ctx.fillText(colStr, width * 0.5, centerY + 54 * s);

  // 4. Top-Right Watermark Badge
  const spdLabel = Math.abs(speed - 1) > 0.01 ? ` · ${speed}x` : '';
  const wmText = `回旋镖大作战 · 观战回放${spdLabel}`;
  ctx.font = `800 ${Math.round(11.5 * s)}px ${fontStack}`;
  const wmW = ctx.measureText(wmText).width + 24 * s;
  const wmH = 28 * s;
  const wmX = width - pad - wmW;
  const wmY = pad;

  drawRoundRect(ctx, wmX, wmY, wmW, wmH, 9 * s);
  ctx.fillStyle = 'rgba(15, 21, 36, 0.78)';
  ctx.fill();
  ctx.lineWidth = 1.1 * s;
  ctx.strokeStyle = 'rgba(255, 206, 86, 0.38)';
  ctx.stroke();
  ctx.fillStyle = '#ffe299';
  ctx.textAlign = 'center';
  ctx.fillText(wmText, wmX + wmW * 0.5, wmY + wmH * 0.52);

  // 5. Post-Match Victory Banner (smooth fade-in during outro)
  if (outroAlpha > 0.01) {
    const winnerSlot = summary.winner >= 0 ? slots[summary.winner] : null;
    const headline = summary.earlyExit
      ? '对局提前结算'
      : winnerSlot
        ? `🏆 胜者：${winnerSlot.displayName}`
        : '🤝 平局结束';
    let subline = `${summary.mapTitle} · 用时 ${(summary.durationTicks / 20).toFixed(1)}s`;
    if (summary.matchMode !== 'custom' && summary.eloDelta !== null && summary.eloAfter !== null) {
      const sign = summary.eloDelta >= 0 ? `+${summary.eloDelta}` : `${summary.eloDelta}`;
      subline += ` · ELO ${sign} → ${summary.eloAfter}`;
    }

    ctx.save();
    ctx.globalAlpha = outroAlpha;
    ctx.font = `900 ${Math.round(20 * s)}px ${fontStack}`;
    const hW = ctx.measureText(headline).width;
    ctx.font = `700 ${Math.round(12.5 * s)}px ${fontStack}`;
    const sW = ctx.measureText(subline).width;
    const boxW = Math.max(250 * s, Math.max(hW, sW) + 52 * s);
    const boxH = 68 * s;
    const boxX = (width - boxW) * 0.5;
    const boxY = height - boxH - 28 * s;

    drawRoundRect(ctx, boxX, boxY, boxW, boxH, 16 * s);
    ctx.fillStyle = 'rgba(13, 19, 34, 0.90)';
    ctx.fill();
    ctx.lineWidth = 1.5 * s;
    ctx.strokeStyle = winnerSlot ? winnerSlot.ringAccent || winnerSlot.color : 'rgba(255, 206, 86, 0.6)';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = `900 ${Math.round(20 * s)}px ${fontStack}`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(headline, width * 0.5, boxY + 26 * s);

    ctx.font = `700 ${Math.round(12.5 * s)}px ${fontStack}`;
    ctx.fillStyle = '#b9ccf0';
    ctx.fillText(subline, width * 0.5, boxY + 49 * s);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Exports a recorded MatchReplayBundle into a true H.264 (+ AAC SFX when supported)
 * 60fps Constant-Frame-Rate MP4 video rendered offline at the exact configured
 * resolution, bitrate, and playback speed in spectator perspective.
 */
export async function exportReplayToMp4(
  bundle: MatchReplayBundle,
  options: Mp4ExportOptions,
): Promise<Mp4ExportResult> {
  const ticks = bundle.replay.ticks;
  if (!ticks || ticks.length === 0) {
    throw new Error('回放帧数据为空，无法导出');
  }

  const resSpec = getExportResolutionSpec(options.resolution);
  const width = resSpec.width;
  const height = resSpec.height;
  const bitrateBps = options.bitrateMbps * 1_000_000;
  const speed = Math.max(0.25, Math.min(2.0, options.speed || 1.0));

  options.onProgress?.(0.01, '检测浏览器 MP4 编码能力...');

  const videoConfig = await pickSupportedVideoConfig(width, height, bitrateBps);
  if (!videoConfig) {
    throw new Error('当前浏览器不支持 WebCodecs H.264 (MP4) 导出，请使用最新版 Chrome / Edge / Safari / Firefox。');
  }

  const wantAudio = options.soundEnabled && options.volumePct > 0;
  const audioConfig = wantAudio ? await pickSupportedAudioConfig() : null;
  const hasAudio = audioConfig !== null;

  const director = new CinematicDirector(ticks, bundle.replay.mapData, options.cinematic ?? false);
  const tickSec = LOGIC_DT_MS / 1000;
  const matchEndSimSec = Math.max(0, ticks.length - 1) * tickSec;
  const playDurationSec = director.simToReal(matchEndSimSec) / speed;
  const outroDurationSec = director.isEnabled()
    ? Math.max(OUTRO_SEC, director.getRecommendedOutroRealSec(OUTRO_SEC) / Math.min(speed, 1.5))
    : OUTRO_SEC;
  const totalDurationSec = LEAD_IN_SEC + playDurationSec + outroDurationSec;
  const totalFrames = Math.max(1, Math.ceil(totalDurationSec * EXPORT_FPS));

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: {
      codec: 'avc',
      width,
      height,
      frameRate: EXPORT_FPS,
    },
    audio: hasAudio
      ? {
          codec: 'aac',
          numberOfChannels: AUDIO_CHANNELS,
          sampleRate: AUDIO_SAMPLE_RATE,
        }
      : undefined,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  });

  let encodeError: Error | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err instanceof Error ? err : new Error(String(err));
    },
  });
  videoEncoder.configure(videoConfig);

  let audioEncoder: AudioEncoder | null = null;
  let offlineAudioCtx: OfflineAudioContext | null = null;
  if (hasAudio && audioConfig) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => {
        encodeError = err instanceof Error ? err : new Error(String(err));
      },
    });
    audioEncoder.configure(audioConfig);
    const totalSamples = Math.max(1024, Math.ceil(totalDurationSec * AUDIO_SAMPLE_RATE));
    offlineAudioCtx = new OfflineAudioContext(AUDIO_CHANNELS, totalSamples, AUDIO_SAMPLE_RATE);
  }

  // Dedicated offscreen WebGL canvas + 2D HUD compositor canvas
  const webglCanvas = document.createElement('canvas');
  webglCanvas.width = width;
  webglCanvas.height = height;

  const compCanvas = document.createElement('canvas');
  compCanvas.width = width;
  compCanvas.height = height;
  const compCtx = compCanvas.getContext('2d', { alpha: false });
  if (!compCtx) {
    videoEncoder.close();
    audioEncoder?.close();
    throw new Error('无法初始化 2D 合成画布');
  }

  const offlineSfx = new SoundFX();
  offlineSfx.applySettings(hasAudio, options.volumePct);

  const offRenderer = new GameRenderer(
    webglCanvas,
    offlineSfx,
    { width, height },
    options.sharedCharModelCache,
    options.graphicsQuality ?? 'high',
  );

  try {
    options.onProgress?.(0.04, '加载 3D 场景与角色模型...');
    const [avatars] = await Promise.all([
      Promise.all(bundle.summary.slots.map((s) => loadImage(s.avatar))),
      offRenderer.setupMatch(
        bundle.replay.mapData,
        bundle.summary.mapTheme,
        bundle.summary.slots,
        ticks[0],
        -1,
        speed,
      ),
    ]);

    if (options.signal?.aborted) {
      throw new DOMException('已取消导出', 'AbortError');
    }

    offRenderer.setCinematicDirector(director);

    const frameDtReal = 1 / EXPORT_FPS;
    let processedTickIdx = 0;
    let prevSimSec = 0;
    let lastYieldMs = performance.now();

    for (let f = 0; f < totalFrames; f++) {
      if (encodeError) throw encodeError;
      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }

      const videoTimeSec = f / EXPORT_FPS;

      let prevSnap: TickSnapshot;
      let currSnap: TickSnapshot;
      let alpha = 1.0;
      let gt = ticks[0].t;
      let outroAlpha = 0;
      let frameDtSim = frameDtReal * speed;
      let elapsedSimSec = videoTimeSec * speed;

      if (videoTimeSec < LEAD_IN_SEC || ticks.length === 1) {
        prevSnap = ticks[0];
        currSnap = ticks[0];
        alpha = 1.0;
        gt = ticks[0].t;
        prevSimSec = 0;
      } else {
        const playReal1xSec = (videoTimeSec - LEAD_IN_SEC) * speed;
        const simSec = director.realToSim(playReal1xSec);
        frameDtSim = Math.max(1e-4, simSec - prevSimSec);
        prevSimSec = simSec;
        elapsedSimSec = LEAD_IN_SEC * speed + simSec;

        const rawTickFloat = simSec / tickSec;
        const maxTickIdx = ticks.length - 1;

        if (rawTickFloat < maxTickIdx) {
          const targetIdx = Math.min(maxTickIdx, Math.floor(rawTickFloat) + 1);
          while (processedTickIdx < targetIdx) {
            const nextIdx = processedTickIdx + 1;
            const eventSimSec = (nextIdx - 1) * tickSec;
            const eventVideoTime = LEAD_IN_SEC + director.simToReal(eventSimSec) / speed;
            if (offlineAudioCtx) {
              offlineSfx.setOfflineTarget(offlineAudioCtx, eventVideoTime);
            }
            offRenderer.processOfflineTickEvents(
              ticks[nextIdx - 1],
              ticks[nextIdx],
              LEAD_IN_SEC * speed + eventSimSec,
            );
            processedTickIdx = nextIdx;
          }
          prevSnap = ticks[targetIdx - 1];
          currSnap = ticks[targetIdx];
          alpha = Math.max(0, Math.min(1, rawTickFloat - (targetIdx - 1)));
          gt = prevSnap.t + alpha;
        } else {
          // Ensure final tick events (including victory confetti + fanfare) have fired
          while (processedTickIdx < maxTickIdx) {
            const nextIdx = processedTickIdx + 1;
            const eventSimSec = (nextIdx - 1) * tickSec;
            const eventVideoTime = LEAD_IN_SEC + director.simToReal(eventSimSec) / speed;
            if (offlineAudioCtx) {
              offlineSfx.setOfflineTarget(offlineAudioCtx, eventVideoTime);
            }
            offRenderer.processOfflineTickEvents(
              ticks[nextIdx - 1],
              ticks[nextIdx],
              LEAD_IN_SEC * speed + eventSimSec,
            );
            processedTickIdx = nextIdx;
          }
          const extraSimSec = Math.max(0, simSec - matchEndSimSec);
          const extraVideoSec = Math.max(0, videoTimeSec - LEAD_IN_SEC - playDurationSec);
          prevSnap = ticks[maxTickIdx];
          currSnap = ticks[maxTickIdx];
          alpha = 1.0;
          gt = currSnap.t + extraSimSec / tickSec;
          const bannerDelaySec = director.hasWinnerCloseup() ? 0.72 / Math.min(speed, 1.5) : 0.2;
          outroAlpha = Math.max(0, Math.min(1, (extraVideoSec - bannerDelaySec) / 0.35));
        }
      }

      const nameplates = offRenderer.renderOfflineFrame(
        prevSnap,
        currSnap,
        alpha,
        gt,
        frameDtSim,
        elapsedSimSec,
      );

      compCtx.drawImage(webglCanvas, 0, 0, width, height);
      drawBroadcastOverlay(
        compCtx,
        width,
        height,
        bundle,
        currSnap,
        nameplates,
        avatars,
        speed,
        outroAlpha,
      );

      // Backpressure guard keeps RAM steady even at 1080p / 1440p
      while (videoEncoder.encodeQueueSize > 8) {
        if (encodeError) throw encodeError;
        if (options.signal?.aborted) {
          throw new DOMException('已取消导出', 'AbortError');
        }
        await new Promise((r) => window.setTimeout(r, 4));
      }

      const timestampUs = Math.round((f * 1_000_000) / EXPORT_FPS);
      const durationUs = Math.round(1_000_000 / EXPORT_FPS);
      const frame = new VideoFrame(compCanvas, {
        timestamp: timestampUs,
        duration: durationUs,
      });
      videoEncoder.encode(frame, { keyFrame: f % (EXPORT_FPS * 2) === 0 });
      frame.close();

      const now = performance.now();
      if (now - lastYieldMs >= 20 || f === totalFrames - 1) {
        lastYieldMs = now;
        const pct = 0.05 + ((f + 1) / totalFrames) * (hasAudio ? 0.85 : 0.90);
        options.onProgress?.(pct, `渲染并编码视频帧 ${f + 1} / ${totalFrames}...`);
        await new Promise((r) => window.setTimeout(r, 0));
      }
    }

    if (encodeError) throw encodeError;
    options.onProgress?.(hasAudio ? 0.91 : 0.96, '刷新视频编码队列...');
    await videoEncoder.flush();
    videoEncoder.close();

    if (hasAudio && offlineAudioCtx && audioEncoder) {
      if (options.signal?.aborted) {
        throw new DOMException('已取消导出', 'AbortError');
      }
      options.onProgress?.(0.94, '合成并编码游戏音效...');
      const renderedAudio = await offlineAudioCtx.startRendering();
      const ch0 = renderedAudio.getChannelData(0);
      const ch1 = renderedAudio.numberOfChannels > 1 ? renderedAudio.getChannelData(1) : ch0;
      const totalSamples = renderedAudio.length;
      const chunkFrames = 1024;

      for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
        if (encodeError) throw encodeError;
        const n = Math.min(chunkFrames, totalSamples - offset);
        const planar = new Float32Array(n * AUDIO_CHANNELS);
        for (let i = 0; i < n; i++) {
          planar[i] = Math.max(-0.98, Math.min(0.98, ch0[offset + i]));
          planar[n + i] = Math.max(-0.98, Math.min(0.98, ch1[offset + i]));
        }
        const audioData = new AudioData({
          format: 'f32-planar',
          sampleRate: AUDIO_SAMPLE_RATE,
          numberOfFrames: n,
          numberOfChannels: AUDIO_CHANNELS,
          timestamp: Math.round((offset * 1_000_000) / AUDIO_SAMPLE_RATE),
          data: planar,
        });
        audioEncoder.encode(audioData);
        audioData.close();
      }
      await audioEncoder.flush();
      audioEncoder.close();
    }

    if (encodeError) throw encodeError;
    options.onProgress?.(0.99, '封装 MP4 文件...');
    muxer.finalize();

    const blob = new Blob([target.buffer], { type: 'video/mp4' });
    const filename = buildExportFilename(bundle, options.resolution, speed);
    options.onProgress?.(1.0, '导出完成');

    return {
      blob,
      filename,
      width,
      height,
      durationSec: totalDurationSec,
      hasAudio,
      sizeBytes: blob.size,
    };
  } catch (err) {
    try {
      if (videoEncoder.state !== 'closed') videoEncoder.close();
    } catch {
      // Ignore cleanup error
    }
    try {
      if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close();
    } catch {
      // Ignore cleanup error
    }
    throw err;
  } finally {
    offlineSfx.setOfflineTarget(null, 0);
    offRenderer.dispose();
  }
}

export function triggerMp4Download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}
