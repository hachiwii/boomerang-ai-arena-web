import { BotCompiler, CompileProgress } from '../game/customBots/botCompiler';
import {
  CUSTOM_BOT_COLORS,
  CUSTOM_BOT_NAME_MAX,
  customBotAvatar,
  CustomBotMeta,
  CustomBotStore,
  DuplicateBotError,
  normalizeHexColor,
  sanitizeBotName,
} from '../game/customBots/customBotStore';
import { CustomModelInput, MAX_MODEL_BYTES, parseCustomModel } from '../game/customBots/customModel';

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXT_RE = /\.(cpp|cc|cxx|c\+\+)$/i;

interface AddState {
  fileName: string;
  source: string;
  name: string;
  color: string;
  model: CustomModelInput | null;
  phase: 'form' | 'compiling' | 'error';
  progress: CompileProgress | null;
  startedAt: number;
  error: { title: string; detail: string } | null;
}

interface EditState {
  id: string;
  name: string;
  color: string;
  /** undefined = keep the current model, null = back to the default figure, object = newly uploaded */
  model: CustomModelInput | null | undefined;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
}

function formatKB(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STAGE_TITLES: Record<string, string> = {
  check: '源码检查没通过',
  compile: '编译失败',
  validate: '编译结果不能作为 Bot 运行',
  load: '编译器加载失败',
};

/**
 * Desktop "管理 Bot" panel: upload a single-file C++ bot, compile it in the browser, and enable / disable /
 * rename / recolour / delete the resulting custom bots.
 */
export class BotManagerModal {
  private readonly store: CustomBotStore;
  private readonly compiler: BotCompiler;
  private readonly onOpenChange?: (open: boolean) => void;
  private readonly backdrop: HTMLDivElement;
  private readonly countEl: HTMLElement;
  private readonly addPanelEl: HTMLDivElement;
  private readonly noticeEl: HTMLDivElement;
  private readonly listEl: HTMLDivElement;
  private readonly fileInput: HTMLInputElement;
  private readonly modelInput: HTMLInputElement;
  private modelTarget: 'add' | 'edit' | null = null;
  private openState = false;
  private add: AddState | null = null;
  private edit: EditState | null = null;
  private confirmDeleteId: string | null = null;
  private confirmTimer: number | null = null;
  private noticeTimer: number | null = null;
  private tickTimer: number | null = null;

  constructor(store: CustomBotStore, compiler: BotCompiler, opts?: { onOpenChange?: (open: boolean) => void }) {
    this.store = store;
    this.compiler = compiler;
    this.onOpenChange = opts?.onOpenChange;

    this.backdrop = document.createElement('div');
    this.backdrop.className = 'botmgr-backdrop hidden';
    this.backdrop.innerHTML = `
      <div class="botmgr-card" role="dialog" aria-label="管理 Bot">
        <div class="botmgr-head">
          <div class="botmgr-head-left">
            <h2>🤖 管理 Bot</h2>
            <span class="botmgr-count-pill" id="botmgr-count"></span>
          </div>
          <div class="botmgr-head-right">
            <button type="button" class="botmgr-add-btn" id="botmgr-add">＋ 添加 Bot</button>
            <button type="button" class="settings-close-btn" id="botmgr-close">完成</button>
          </div>
        </div>
        <div class="botmgr-note">自定义 Bot 在浏览器里编译，可用于自定义对局和斗蛐蛐；没有 ELO 分数，不出现在排位赛中。</div>
        <div id="botmgr-notice" class="hidden"></div>
        <div class="botmgr-body">
          <div id="botmgr-add-panel" class="hidden"></div>
          <div id="botmgr-list"></div>
        </div>
      </div>
    `;
    this.countEl = this.backdrop.querySelector<HTMLElement>('#botmgr-count')!;
    this.addPanelEl = this.backdrop.querySelector<HTMLDivElement>('#botmgr-add-panel')!;
    this.noticeEl = this.backdrop.querySelector<HTMLDivElement>('#botmgr-notice')!;
    this.listEl = this.backdrop.querySelector<HTMLDivElement>('#botmgr-list')!;

    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.cpp,.cc,.cxx,.c++,text/x-c++src';
    this.fileInput.className = 'hidden';
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.acceptFile(f);
    });
    this.backdrop.appendChild(this.fileInput);

    this.modelInput = document.createElement('input');
    this.modelInput.type = 'file';
    this.modelInput.accept = '.json,application/json';
    this.modelInput.className = 'hidden';
    this.modelInput.addEventListener('change', () => {
      const f = this.modelInput.files?.[0];
      this.modelInput.value = '';
      if (f) void this.acceptModel(f);
    });
    this.backdrop.appendChild(this.modelInput);
    document.body.appendChild(this.backdrop);

    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });
    this.backdrop.querySelector('#botmgr-close')!.addEventListener('click', () => this.close());
    this.backdrop.querySelector('#botmgr-add')!.addEventListener('click', () => this.pickFile());
    this.store.onChange(() => {
      if (this.edit && !this.store.get(this.edit.id)) this.edit = null;
      if (this.openState) this.renderList();
    });
  }

  public isOpen(): boolean {
    return this.openState;
  }

  public open() {
    if (this.openState) return;
    this.openState = true;
    this.backdrop.classList.remove('hidden');
    window.addEventListener('keydown', this.handleKeyDown);
    this.renderAddPanel();
    this.renderList();
    this.onOpenChange?.(true);
  }

  public close() {
    if (!this.openState) return;
    this.openState = false;
    this.backdrop.classList.add('hidden');
    window.removeEventListener('keydown', this.handleKeyDown);
    this.edit = null;
    this.confirmDeleteId = null;
    // A finished form / error is dropped; a compile in flight keeps running and adds the bot when done
    if (this.add && this.add.phase !== 'compiling') this.add = null;
    this.stopTick();
    this.onOpenChange?.(false);
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (this.edit) {
        this.edit = null;
        this.renderList();
      } else {
        this.close();
      }
    }
  };

  // ---------------------------------------------------------------- add flow

  private pickFile() {
    if (this.add?.phase === 'compiling') return;
    this.fileInput.click();
  }

  private async acceptFile(f: File) {
    if (!SOURCE_EXT_RE.test(f.name)) {
      this.showNotice(`请选择 C++ 源文件（.cpp），「${f.name}」不是`, 'err');
      return;
    }
    if (f.size > MAX_SOURCE_BYTES) {
      this.showNotice(`源文件太大（${formatKB(f.size)}），上限 ${formatKB(MAX_SOURCE_BYTES)}`, 'err');
      return;
    }
    let source: string;
    try {
      source = await f.text();
    } catch {
      this.showNotice(`读取「${f.name}」失败`, 'err');
      return;
    }
    if (source.includes('\u0000')) {
      this.showNotice(`「${f.name}」不是文本文件`, 'err');
      return;
    }
    const baseName = sanitizeBotName(f.name.replace(SOURCE_EXT_RE, '')) || '自定义 Bot';
    this.add = {
      fileName: f.name,
      source,
      name: baseName,
      color: this.suggestColor(),
      model: null,
      phase: 'form',
      progress: null,
      startedAt: 0,
      error: null,
    };
    this.renderAddPanel();
    this.addPanelEl.querySelector<HTMLInputElement>('#botmgr-add-name')?.select();
  }

  private pickModel(target: 'add' | 'edit') {
    if (target === 'add' && this.add?.phase === 'compiling') return;
    this.modelTarget = target;
    this.modelInput.click();
  }

  private async acceptModel(f: File) {
    const target = this.modelTarget;
    this.modelTarget = null;
    if (!/\.json$/i.test(f.name)) {
      this.showNotice(`请选择模型 JSON 文件，「${f.name}」不是`, 'err');
      return;
    }
    if (f.size > MAX_MODEL_BYTES) {
      this.showNotice(`模型文件太大（${formatKB(f.size)}），上限 ${formatKB(MAX_MODEL_BYTES)}`, 'err');
      return;
    }
    let model: CustomModelInput;
    try {
      model = await parseCustomModel(await f.text(), f.name);
    } catch (err) {
      this.showNotice(err instanceof Error ? err.message : String(err), 'err');
      return;
    }
    if (target === 'add' && this.add && this.add.phase !== 'compiling') {
      this.add.model = model;
      this.renderAddPanel();
    } else if (target === 'edit' && this.edit) {
      this.edit.model = model;
      this.renderList();
    }
  }

  private renderModelField(label: string, uploaded: boolean, disabled: boolean): string {
    return `
      <div class="botmgr-field">
        <span>模型</span>
        <div class="botmgr-model-row">
          <span class="botmgr-model-chip ${uploaded ? 'is-custom' : ''}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
          <button type="button" class="botmgr-link-btn" data-model-upload ${disabled ? 'disabled' : ''}>上传 JSON</button>
          ${uploaded ? `<button type="button" class="botmgr-link-btn" data-model-clear ${disabled ? 'disabled' : ''}>恢复默认</button>` : ''}
        </div>
      </div>`;
  }

  private static modelLabel(m: CustomModelInput): string {
    return `📦 ${m.name} · ${m.parts} 个部件 · ${m.voxels} 体素`;
  }

  private suggestColor(): string {
    const used = new Set(this.store.list().map((b) => b.color.toUpperCase()));
    return CUSTOM_BOT_COLORS.find((c) => !used.has(c)) ?? CUSTOM_BOT_COLORS[this.store.list().length % CUSTOM_BOT_COLORS.length];
  }

  private async startCompile() {
    const st = this.add;
    if (!st || st.phase === 'compiling') return;
    const name = sanitizeBotName(st.name);
    if (!name) {
      this.showNotice('请输入 Bot 名称', 'err');
      return;
    }
    st.name = name;
    st.phase = 'compiling';
    st.progress = null;
    st.error = null;
    st.startedAt = performance.now();
    this.renderAddPanel();
    this.startTick();

    const res = await this.compiler.compile(st.source, (p) => {
      st.progress = p;
      if (this.openState) this.syncProgress();
    });
    this.stopTick();
    if (this.add !== st) return;

    if (!res.ok) {
      st.phase = 'error';
      st.error = { title: STAGE_TITLES[res.stage] ?? '编译失败', detail: res.message };
      this.renderAddPanel();
      return;
    }
    const dup = this.store.findByHash(res.hash);
    if (dup) {
      st.phase = 'error';
      st.error = {
        title: '重复的 Bot',
        detail: `编译结果与已有的「${dup.name}」完全相同（SHA-256 ${res.hash.slice(0, 12)}…），没有重复添加。`,
      };
      this.renderAddPanel();
      return;
    }
    try {
      const meta = await this.store.add({
        name: st.name,
        color: st.color,
        sourceName: st.fileName,
        source: st.source,
        wasm: res.wasm,
        hash: res.hash,
        model: st.model,
      });
      this.add = null;
      this.renderAddPanel();
      this.showNotice(`已添加「${meta.name}」· 编译用时 ${(res.ms / 1000).toFixed(1)} 秒`, 'ok');
    } catch (err) {
      st.phase = 'error';
      st.error =
        err instanceof DuplicateBotError
          ? { title: '重复的 Bot', detail: err.message }
          : { title: '保存失败', detail: err instanceof Error ? err.message : String(err) };
      this.renderAddPanel();
    }
  }

  private startTick() {
    this.stopTick();
    this.tickTimer = window.setInterval(() => {
      if (this.openState) this.syncProgress();
    }, 250);
  }

  private stopTick() {
    if (this.tickTimer !== null) {
      window.clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private progressText(st: AddState): { text: string; frac: number | null } {
    const secs = ((performance.now() - st.startedAt) / 1000).toFixed(0);
    const p = st.progress;
    if (p?.stage === 'download' && p.total > 0 && p.done < p.total) {
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
      return { text: `首次编译，正在下载编译器 ${mb(p.done)} / ${mb(p.total)} MB`, frac: p.done / p.total };
    }
    if (p?.stage === 'download' && p.total > 0) {
      return { text: `编译器已下载，正在编译… ${secs}s`, frac: null };
    }
    if (!p && !this.compiler.isToolchainReady() && performance.now() - st.startedAt < 1500) {
      return { text: '正在启动编译器…', frac: null };
    }
    return { text: `编译中… ${secs}s`, frac: null };
  }

  private syncProgress() {
    const st = this.add;
    if (!st || st.phase !== 'compiling') return;
    const { text, frac } = this.progressText(st);
    const textEl = this.addPanelEl.querySelector<HTMLElement>('#botmgr-progress-text');
    const barEl = this.addPanelEl.querySelector<HTMLElement>('#botmgr-progress-bar');
    if (textEl) textEl.textContent = text;
    if (barEl) {
      barEl.classList.toggle('is-indeterminate', frac === null);
      barEl.style.setProperty('--p', frac === null ? '0' : String(Math.max(0, Math.min(1, frac))));
    }
  }

  private renderSwatches(selected: string, attr: string): string {
    const sel = selected.toUpperCase();
    const presets = CUSTOM_BOT_COLORS.map(
      (c) =>
        `<button type="button" class="botmgr-swatch ${c === sel ? 'is-selected' : ''}" ${attr}="${c}" style="--sw:${c}" title="${c}" aria-label="颜色 ${c}"></button>`,
    ).join('');
    const isCustom = !CUSTOM_BOT_COLORS.includes(sel);
    return `${presets}<label class="botmgr-swatch botmgr-swatch-custom ${isCustom ? 'is-selected' : ''}" title="自选颜色" style="--sw:${sel}">
        <input type="color" value="${sel.toLowerCase()}" ${attr}-picker />
      </label>`;
  }

  private renderAddPanel() {
    const st = this.add;
    if (!st) {
      this.addPanelEl.classList.add('hidden');
      this.addPanelEl.innerHTML = '';
      return;
    }
    this.addPanelEl.classList.remove('hidden');
    const busy = st.phase === 'compiling';
    const lines = st.source.split('\n').length;
    this.addPanelEl.innerHTML = `
      <div class="botmgr-add-panel ${busy ? 'is-busy' : ''}">
        <div class="botmgr-add-top">
          <img class="botmgr-avatar" id="botmgr-add-avatar" src="${st.model ? st.model.avatar : customBotAvatar(st.color)}" alt="" style="border-color:${st.color}" />
          <div class="botmgr-add-fields">
            <div class="botmgr-file-row">
              <span class="botmgr-file-chip" title="${escapeHtml(st.fileName)}">📄 ${escapeHtml(st.fileName)}</span>
              <span class="botmgr-file-meta">${formatKB(st.source.length)} · ${lines} 行</span>
              <button type="button" class="botmgr-link-btn" id="botmgr-repick" ${busy ? 'disabled' : ''}>重新选择</button>
            </div>
            <label class="botmgr-field">
              <span>名称</span>
              <input type="text" id="botmgr-add-name" maxlength="${CUSTOM_BOT_NAME_MAX}" value="${escapeHtml(st.name)}" ${busy ? 'disabled' : ''} placeholder="Bot 名称" autocomplete="off" spellcheck="false" />
            </label>
            <div class="botmgr-field">
              <span>颜色</span>
              <div class="botmgr-swatches ${busy ? 'is-disabled' : ''}">${this.renderSwatches(st.color, 'data-add-color')}</div>
            </div>
            ${this.renderModelField(st.model ? BotManagerModal.modelLabel(st.model) : '默认 · 按颜色染色的帽衫小人', !!st.model, busy)}
          </div>
        </div>
        ${
          busy
            ? `<div class="botmgr-progress">
                <div class="botmgr-progress-bar" id="botmgr-progress-bar"><span></span></div>
                <div class="botmgr-progress-text" id="botmgr-progress-text"></div>
              </div>`
            : ''
        }
        ${
          st.phase === 'error' && st.error
            ? `<div class="botmgr-error">
                <div class="botmgr-error-title">⚠️ ${escapeHtml(st.error.title)}</div>
                <pre class="botmgr-log">${escapeHtml(st.error.detail)}</pre>
              </div>`
            : ''
        }
        <div class="botmgr-add-actions">
          <button type="button" class="botmgr-secondary-btn" id="botmgr-add-cancel" ${busy ? 'disabled' : ''}>取消</button>
          <button type="button" class="botmgr-primary-btn" id="botmgr-add-go" ${busy ? 'disabled' : ''}>
            ${busy ? '编译中…' : st.phase === 'error' ? '重新编译' : '开始编译'}
          </button>
        </div>
      </div>
    `;
    if (busy) this.syncProgress();
    if (busy) return;

    const nameInput = this.addPanelEl.querySelector<HTMLInputElement>('#botmgr-add-name')!;
    nameInput.addEventListener('input', () => {
      st.name = nameInput.value;
    });
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.startCompile();
      }
    });
    const setColor = (c: string) => {
      const n = normalizeHexColor(c);
      if (!n) return;
      st.color = n;
      this.addPanelEl.querySelectorAll<HTMLElement>('[data-add-color]').forEach((el) =>
        el.classList.toggle('is-selected', el.dataset.addColor === n),
      );
      const customEl = this.addPanelEl.querySelector<HTMLElement>('.botmgr-swatch-custom');
      if (customEl) {
        customEl.classList.toggle('is-selected', !CUSTOM_BOT_COLORS.includes(n));
        customEl.style.setProperty('--sw', n);
      }
      const av = this.addPanelEl.querySelector<HTMLImageElement>('#botmgr-add-avatar');
      if (av) {
        if (!st.model) av.src = customBotAvatar(n);
        av.style.borderColor = n;
      }
    };
    this.addPanelEl.querySelector('[data-model-upload]')?.addEventListener('click', () => this.pickModel('add'));
    this.addPanelEl.querySelector('[data-model-clear]')?.addEventListener('click', () => {
      st.model = null;
      this.renderAddPanel();
    });
    this.addPanelEl.querySelectorAll<HTMLElement>('[data-add-color]').forEach((el) =>
      el.addEventListener('click', () => setColor(el.dataset.addColor || '')),
    );
    this.addPanelEl.querySelector<HTMLInputElement>('[data-add-color-picker]')?.addEventListener('input', (e) =>
      setColor((e.target as HTMLInputElement).value),
    );
    this.addPanelEl.querySelector('#botmgr-repick')?.addEventListener('click', () => this.pickFile());
    this.addPanelEl.querySelector('#botmgr-add-cancel')?.addEventListener('click', () => {
      this.add = null;
      this.renderAddPanel();
    });
    this.addPanelEl.querySelector('#botmgr-add-go')?.addEventListener('click', () => void this.startCompile());
  }

  // ---------------------------------------------------------------- list

  private renderList() {
    const bots = this.store.list();
    const enabled = bots.filter((b) => b.enabled).length;
    this.countEl.textContent = bots.length > 0 ? `${bots.length} 个 · ${enabled} 个已启用` : '暂无';
    if (bots.length === 0) {
      this.listEl.innerHTML = `
        <div class="botmgr-empty">
          <div class="botmgr-empty-icon">🤖</div>
          <div>还没有自定义 Bot</div>
          <div class="botmgr-empty-sub">点「添加 Bot」上传一个 C++ 源文件，编译成功后即可上场</div>
        </div>`;
      return;
    }
    this.listEl.innerHTML = `<div class="botmgr-list">${bots.map((b) => this.renderRow(b)).join('')}</div>`;
    this.bindList();
  }

  private renderRow(b: CustomBotMeta): string {
    const editing = this.edit?.id === b.id ? this.edit : null;
    const color = editing ? editing.color : b.color;
    // Model shown in this row: the pending edit's choice, else the bot's current one
    const editModel = editing?.model;
    const hasModel = editModel !== undefined ? editModel !== null : !!b.modelId;
    const avatar =
      editModel ? editModel.avatar : hasModel && b.modelAvatar ? b.modelAvatar : customBotAvatar(color);
    const modelLabel = editModel
      ? BotManagerModal.modelLabel(editModel)
      : hasModel
        ? `📦 ${b.modelName ?? '自定义模型'}`
        : '默认 · 按颜色染色的帽衫小人';
    const confirmDel = this.confirmDeleteId === b.id;
    const meta = [
      formatDate(b.createdAt),
      escapeHtml(b.sourceName),
      `wasm ${formatKB(b.wasmSize)}`,
      b.modelId ? `模型 ${escapeHtml(b.modelName ?? '')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    return `
      <div class="botmgr-row ${b.enabled ? '' : 'is-disabled'} ${editing ? 'is-editing' : ''}" data-bot-row="${b.id}">
        <div class="botmgr-row-main">
          <img class="botmgr-avatar" src="${avatar}" alt="" style="border-color:${color}" />
          <div class="botmgr-row-text">
            <div class="botmgr-row-name">
              <span class="botmgr-color-dot" style="background:${b.color}"></span>
              <span>${escapeHtml(b.name)}</span>
              ${b.enabled ? '' : '<span class="botmgr-off-pill">已禁用</span>'}
            </div>
            <div class="botmgr-row-meta" title="SHA-256 ${b.hash}">${meta}</div>
          </div>
          <div class="botmgr-row-actions">
            <button
              type="button"
              class="botmgr-toggle ${b.enabled ? 'is-on' : ''}"
              data-toggle-bot="${b.id}"
              role="switch"
              aria-checked="${b.enabled}"
              title="${b.enabled ? '已启用：可在自定义对局和斗蛐蛐中使用（点击禁用）' : '已禁用（点击启用）'}"
            ><span></span></button>
            <button type="button" class="botmgr-secondary-btn" data-edit-bot="${b.id}">${editing ? '收起' : '配置'}</button>
            <button type="button" class="botmgr-danger-btn ${confirmDel ? 'confirm' : ''}" data-delete-bot="${b.id}">${confirmDel ? '确认删除？' : '删除'}</button>
          </div>
        </div>
        ${
          editing
            ? `<div class="botmgr-edit">
                <label class="botmgr-field">
                  <span>名称</span>
                  <input type="text" data-edit-name maxlength="${CUSTOM_BOT_NAME_MAX}" value="${escapeHtml(editing.name)}" autocomplete="off" spellcheck="false" />
                </label>
                <div class="botmgr-field">
                  <span>颜色</span>
                  <div class="botmgr-swatches">${this.renderSwatches(editing.color, 'data-edit-color')}</div>
                </div>
                ${this.renderModelField(modelLabel, hasModel, false)}
                <div class="botmgr-add-actions">
                  <button type="button" class="botmgr-secondary-btn" data-edit-cancel>取消</button>
                  <button type="button" class="botmgr-primary-btn" data-edit-save>保存</button>
                </div>
              </div>`
            : ''
        }
      </div>`;
  }

  private bindList() {
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-toggle-bot]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const b = this.store.get(btn.dataset.toggleBot || '');
        if (b) void this.store.update(b.id, { enabled: !b.enabled });
      }),
    );
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-edit-bot]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const b = this.store.get(btn.dataset.editBot || '');
        if (!b) return;
        this.edit = this.edit?.id === b.id ? null : { id: b.id, name: b.name, color: b.color, model: undefined };
        this.renderList();
        this.listEl.querySelector<HTMLInputElement>('[data-edit-name]')?.focus();
      }),
    );
    this.listEl.querySelectorAll<HTMLButtonElement>('[data-delete-bot]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const id = btn.dataset.deleteBot || '';
        if (this.confirmDeleteId !== id) {
          this.confirmDeleteId = id;
          if (this.confirmTimer !== null) window.clearTimeout(this.confirmTimer);
          this.confirmTimer = window.setTimeout(() => {
            this.confirmDeleteId = null;
            this.confirmTimer = null;
            if (this.openState) this.renderList();
          }, 3500);
          this.renderList();
          return;
        }
        this.confirmDeleteId = null;
        const name = this.store.get(id)?.name ?? '';
        void this.store.remove(id).then(() => this.showNotice(`已删除「${name}」`, 'ok'));
      }),
    );

    const ed = this.edit;
    if (!ed) return;
    const row = this.listEl.querySelector<HTMLElement>(`[data-bot-row="${ed.id}"]`);
    if (!row) return;
    const nameInput = row.querySelector<HTMLInputElement>('[data-edit-name]');
    const save = () => {
      const name = sanitizeBotName(ed.name);
      if (!name) {
        this.showNotice('名称不能为空', 'err');
        return;
      }
      this.edit = null;
      void this.store
        .update(ed.id, { name, color: ed.color, ...(ed.model !== undefined ? { model: ed.model } : {}) })
        .catch((err) => this.showNotice(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'err'));
    };
    nameInput?.addEventListener('input', () => {
      ed.name = nameInput.value;
    });
    nameInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    const setColor = (c: string) => {
      const n = normalizeHexColor(c);
      if (!n) return;
      ed.color = n;
      row.querySelectorAll<HTMLElement>('[data-edit-color]').forEach((el) => el.classList.toggle('is-selected', el.dataset.editColor === n));
      const customEl = row.querySelector<HTMLElement>('.botmgr-swatch-custom');
      if (customEl) {
        customEl.classList.toggle('is-selected', !CUSTOM_BOT_COLORS.includes(n));
        customEl.style.setProperty('--sw', n);
      }
      const av = row.querySelector<HTMLImageElement>('.botmgr-avatar');
      const meta = this.store.get(ed.id);
      const keepsModel = ed.model !== undefined ? ed.model !== null : !!meta?.modelId;
      if (av) {
        if (!keepsModel) av.src = customBotAvatar(n);
        av.style.borderColor = n;
      }
    };
    row.querySelector('[data-model-upload]')?.addEventListener('click', () => this.pickModel('edit'));
    row.querySelector('[data-model-clear]')?.addEventListener('click', () => {
      ed.model = null;
      this.renderList();
    });
    row.querySelectorAll<HTMLElement>('[data-edit-color]').forEach((el) => el.addEventListener('click', () => setColor(el.dataset.editColor || '')));
    row.querySelector<HTMLInputElement>('[data-edit-color-picker]')?.addEventListener('input', (e) => setColor((e.target as HTMLInputElement).value));
    row.querySelector('[data-edit-cancel]')?.addEventListener('click', () => {
      this.edit = null;
      this.renderList();
    });
    row.querySelector('[data-edit-save]')?.addEventListener('click', save);
  }

  private showNotice(text: string, kind: 'ok' | 'err') {
    this.noticeEl.className = '';
    this.noticeEl.innerHTML = `<div class="botmgr-notice is-${kind}">${escapeHtml(text)}</div>`;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeEl.className = 'hidden';
      this.noticeEl.innerHTML = '';
      this.noticeTimer = null;
    }, 4200);
  }
}
