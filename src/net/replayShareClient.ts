// 分享对局的网络部分：把回放文本 POST 到中转服务器的 /share 换短 id，用 GET /share/<id> 取回（server/shares.ts）。
// 短链接是本站地址加 ?r=<id>；只有有中转服务器的站点（isPvpAvailable，镜像站没有）才能分享和打开。
import type { MatchReplayBundle } from '../game/matchHistory';
import { isShareCodecSupported, packReplay, SHARE_ID_RE, unpackReplay } from '../game/replayShare';
import { isPvpAvailable, relayHttpUrl } from './pvpConfig';

export const SHARE_QUERY_KEY = 'r';

/** 分享按钮显示的条件：有中转服务器，浏览器支持 gzip 压缩流。 */
export function isReplayShareAvailable(): boolean {
  return isPvpAvailable() && isShareCodecSupported();
}

export function shareUrlFor(id: string): string {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set(SHARE_QUERY_KEY, id);
  return url.toString();
}

/** 本页已经分享过的对局（bundle 的摘要 id → 短 id），再点分享不用重新上传。 */
const sharedIds = new Map<string, string>();

function sharedIdOf(bundle: MatchReplayBundle): string | null {
  const own = /^share-([0-9a-z]{10})$/.exec(bundle.summary.id);
  return own ? own[1] : (sharedIds.get(bundle.summary.id) ?? null);
}

function uploadError(status: number, error: unknown): string {
  if (status === 429) return '分享太频繁了，请过几分钟再试';
  if (status === 413 || error === 'too-large') return '这局数据太大，无法分享';
  if (status === 503) return error === 'disabled' ? '服务器没有开启分享功能' : '分享服务正忙，请稍后再试';
  if (status === 400) return '对局数据无法识别，分享失败';
  return `上传失败（HTTP ${status}）`;
}

/** 上传一局，返回短 id 和完整链接。 */
export async function uploadReplayShare(bundle: MatchReplayBundle): Promise<{ id: string; url: string }> {
  const known = sharedIdOf(bundle);
  if (known) return { id: known, url: shareUrlFor(known) };
  const endpoint = relayHttpUrl('/share');
  if (!endpoint || !isShareCodecSupported()) throw new Error('当前站点或浏览器不支持分享对局');
  const text = await packReplay(bundle);
  let resp: Response;
  try {
    // text/plain 是 CORS「简单请求」，不用预检
    resp = await fetch(endpoint, {
      method: 'POST',
      body: text,
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    });
  } catch {
    throw new Error('连不上分享服务，请检查网络后重试');
  }
  let body: { id?: unknown; error?: unknown } = {};
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    // 非 JSON（比如 CDN 的错误页）
  }
  if (!resp.ok) throw new Error(uploadError(resp.status, body.error));
  if (typeof body.id !== 'string' || !SHARE_ID_RE.test(body.id)) throw new Error('服务器返回的分享 id 无效');
  sharedIds.set(bundle.summary.id, body.id);
  return { id: body.id, url: shareUrlFor(body.id) };
}

/** 取回一局分享的回放（已解码、清洗）。 */
export async function fetchSharedReplay(id: string): Promise<MatchReplayBundle> {
  if (!SHARE_ID_RE.test(id)) throw new Error('分享链接无效');
  if (!isShareCodecSupported()) throw new Error('浏览器版本过旧，无法打开分享的回放');
  const endpoint = relayHttpUrl(`/share/${id}`);
  if (!endpoint) throw new Error('当前站点没有分享服务，无法打开分享的回放');
  let resp: Response;
  try {
    resp = await fetch(endpoint, { credentials: 'omit' });
  } catch {
    throw new Error('连不上分享服务，请检查网络后刷新重试');
  }
  if (resp.status === 404) throw new Error('这个分享不存在或已过期');
  if (!resp.ok) throw new Error(`读取分享失败（HTTP ${resp.status}）`);
  return unpackReplay(await resp.text(), id);
}

/** 地址栏里的 ?r=<id>（没有或格式不对时返回原样，交给 fetchSharedReplay 报错）。 */
export function readShareIdFromLocation(): string | null {
  try {
    return new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY);
  } catch {
    return null;
  }
}

/** 离开分享的回放后把 ?r= 去掉，刷新不会再进同一局。 */
export function clearShareIdFromLocation() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SHARE_QUERY_KEY)) return;
    url.searchParams.delete(SHARE_QUERY_KEY);
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // 不影响游戏
  }
}
