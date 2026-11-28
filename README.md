# 回旋镖大作战 · Boomerang AI Arena (Web)

一款纯前端浏览器运行的 3D 体素风《回旋镖大作战》对战网页版：内置原版确定性 C++ 规则引擎（WebAssembly）与 28 位 AI Bot 选手（含 13 位大语言模型编写的官方参赛 Bot + 10 位 5v5 团队赛终版 Bot + 2 位社区 Bot + 3 位陪练 Bot），支持人类玩家亲自下场挑战排位赛、5v5 团队赛或自定义对局，也可纯 AI 观战。

## 核心特性

- **100% 本地浏览器运行（WASM + Web Worker）**：规则引擎 `dart.hpp` 与 28 个 C++ Bot 全部通过 Emscripten 编译为独立 WebAssembly 模块，在隔离的 Web Worker 中并行决策，无需后端服务器。
- **排位赛 & 自定义对局**：
  - **排位赛**：支持 **SOLO (1v1)** 与 **四人混战 (4P)** 双独立 Elo 排行榜、分模式图池与近三场防重随机、按位次就近匹配、结算段位超车动画，以及 `R` 键一键重新匹配。
  - **自定义对局**：自由选择 2–4 人阵容（真人 / 自定义 / 社区 / 原版 AI / 陪练）、10 张官方主题地图、随机站位、`0.1x–2.0x` 对局倍速与纯 AI 观战。
- **5v5 团队赛**（上游第 12 集）：火山口 · 歼灭、三座栈桥 · 占点、双堡 · 刺王三张图三种模式。
  - 左右两队各五席，可选 Astra 队 / Fable 队的 10 位团队终版 Bot 或玩家；整队一键换成原版队伍，换掉一人为「冒充」，其他改动为「自定义」（允许重复角色，自动加 2、3…）。
  - 每席的战术按钮：占点选点和职责，刺王选职责，另有按该 Bot 原版队伍写法校验的高级指令；可一键套用原版 6 回合 36 套布阵与战术单，也能在地图上拖动调整出生点（占点里即复活点）。
  - 两队原版电台协议不同，引擎按收信方的协议翻译队友消息，混编和真人也能被队友“听到”；结束或（歼灭、刺王）出局后按 `R` 原配置重开。
- **高帧率 3D 渲染与操作优化**：
  - 20Hz 权威逻辑步进 + 帧间平滑插值渲染（支持 `VSync` / `60`–`360 Hz` / `240Hz+ 解锁`）。
  - 针对人类操作体验优化：3 秒开局倒计时、走路跌落防护开关、即将塌陷地板碎石音效提示、人类近战（挥砍/踢人）5 tick（250ms）判定窗口（Bot 严格保留原版 1 tick 判定与 0.2s 反应延迟）。
  - 完整设置中心：音效开关与音量、帧率上限、全操作双键位自定义（支持键盘与鼠标键，冲突自动转移，本地持久化）。

## 上游开源项目与致谢

本项目基于 **[chen-006/meow-ai-arena](https://github.com/chen-006/meow-ai-arena)**（AI 算法对抗大赛第 11 集 [`boomerang/`](https://github.com/chen-006/meow-ai-arena/tree/main/boomerang)《回旋镖大作战》）构建，使用了原仓库的：

- 规则引擎核心头文件（`dart.hpp`，含第 12 集 [`boomerang-team/`](https://github.com/chen-006/meow-ai-arena/tree/main/boomerang-team) 的 5v5 规则）与 10 张官方对战地图 + 3 张团队赛地图
- 13 位官方参赛 AI Bot 与 3 位陪练 Bot 的 C++ 源码及基准评分数据
- 第 12 集 10 位团队终版 Bot 的 C++ 源码，以及 6 回合正式与备选的布阵、战术单（`scripts/export_team_presets.py` 导出为 `public/assets/team/presets.json`）
- 体素小人角色模型与头像美术资源

原项目同样采用 MIT License 开源，感谢原作者与所有贡献者！

## 本地开发与构建

### 1. 安装依赖并启动开发服务器

```bash
npm install
npm run dev
```

打开浏览器访问 `http://localhost:5173/` 即可游玩。

### 2. 构建生产静态产物

```bash
npm run build
```

产物输出至 `dist/` 目录，可直接部署到任意静态托管或对象存储 + CDN（需部署在域名根路径 `/` 下，并保证 `.wasm` 文件的 `Content-Type` 为 `application/wasm`）。

### 3. 可选环境变量

复制 [.env.example](.env.example) 为 `.env.production.local`（已被 `.gitignore` 忽略，不会提交到仓库）：

```env
# 可选：填写后在主界面底部展示备案号并链接至工信部备案查询页；留空则不显示
VITE_ICP_NUMBER=

# 可选：在线 1v1（PvP），默认开启，填 0 关闭（镜像站即如此）。
# 中转服务器地址留空时默认连接与页面同一主机的 8787 端口：http 页面用 ws://，https 页面用 wss://。
# 服务器放在 CDN / 反向代理后面时填其公网地址，例如 wss://pvp.example.com/ws
VITE_PVP_ENABLED=
VITE_PVP_URL=
```

PvP 中转服务器代码在 [`server/`](server/README.md)（`npm ci --prefix server && npm run build --prefix server && npm start --prefix server`，默认监听 8787），协议与联机设计见 [`docs/pvp-design.md`](docs/pvp-design.md)。和静态站点部署在同一台机器上时，前端无需额外配置即可联机。

有中转服务器时，结算界面和回放里的「分享」按钮会把整局回放压缩成文本传到中转服务器，换回一个 `?r=<id>` 短链接，打开即进入这局回放（存储与清理见 [server/README.md 的 Shared replays](server/README.md#shared-replays)）；关闭 PvP 的构建（镜像站）没有这个按钮。

### 4. 重新编译 WASM 或重新导出资源（可选）

仓库包含编译好的规则引擎 `public/wasm/engine.{js,wasm}` 与导出好的 `public/assets/*`；Bot 只提交 C++ 源码（`wasm/bots/*.cpp`），编译产物 `public/wasm/bots/` 不进仓库。

- 克隆后首次运行、或修改了 `wasm/include/dart.hpp` / `wasm/bots/*.cpp` 时，编译 WASM（需本机安装 [Emscripten](https://emscripten.org/) `em++`）：
  ```bash
  npm run build:wasm
  ```
  只改了引擎时可用 `python3 scripts/build_wasm.py --engine-only`。
- 若需从上游仓库重新导出地图/角色资源：
  ```bash
  MEOW_AI_ARENA_DIR=/path/to/meow-ai-arena npm run export:assets
  ```

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
