# 回旋镖大作战 · Boomerang AI Arena (Web Edition)

基于 [meow-ai-arena](https://github.com/chen-006/meow-ai-arena) 第 11 集《回旋镖大作战》移植的浏览器可玩 3D Web 版，支持真人键鼠操控与 AI 同台竞技，或纯 AI 观战对决。

## 特性一览

- **权威规则引擎 + 全部官方 Bot 原汁原味编译为 WASM**：
  - 规则引擎 `dart.hpp` 逐位一致编译为 `public/wasm/engine.wasm`，在独立 Web Worker 中以 **固定 20 Hz 逻辑 tick** 运行。
  - 收录正赛 **13 位 AI 选手**（GPT-6.2 Astra、Claude Fable 5.2、Claude Opus 5.5、Gemini 4 Carbon、GPT-6.2 Sol、Gemini 4 Hydrogen、Grok 4.7、GLM 5.3、DeepSeek-V4.1-Flash、Kimi K3.1 Pro、千问 Qwen4-Max、MiMo V2.6 Pro、豆包 Seed-Evolving）及 **3 档官方陪练**（弱/中/强），全部由原版 C++17 源码编译为独立 `.wasm` 模块。
  - 每个 AI 席位运行在各自隔离的 Web Worker + 独立 WASM 线性内存中，**支持同一 AI 放入多份副本**（自动在名称后追加编号如 `Astra 1`、`Astra 2` 并配独立脚环区分），且完全不阻塞主线程渲染。
- **240 Hz+ 丝滑插值渲染**：
  - 20 Hz 逻辑 tick 之间进行连续位置、朝向、动作姿态与特效插值；实例化浮岛地形 + 对象池特效将单帧 CPU 渲染耗时压至 **< 1 ms**，默认以 **240 Hz+** 高频渲染运行（右上角支持随时在 `240Hz+ 解锁` 与 `高刷 VSync` 间切换）。
- **完整选图与参赛配置**：
  - 支持全部 **10 张官方定稿地图**（双湖、阴阳、石阵、天桥、古塔、裂冰，以及适配 2-4 人的沙漏、峡谷、老城、林地），带各自主题配色、塌陷波次预警与坠落动画。
  - 支持 **2～4 人** 自由组局；真人可参战（使用仓库自带的通用示范小人 `demo_blue` 蓝帽衫体素模型），也可切换为纯 AI 观战；一局结束后展示结算并自动返回主界面。
- **操作方式（真人参战）**：
  - `WASD` / 方向键：移动
  - `鼠标左键`：向鼠标方向扔回旋镖 / 镖落地时 **长按左键** 召回（松开中断）
  - `鼠标右键`：持镖时挥砍（可格挡正前方飞镖）/ 空手时踢人击退（冲刺途中可接冲刺斩/踢）
  - `Shift`：冲刺（可越坑；按住移动键时沿移动方向冲刺，否则朝鼠标方向冲刺）
  - `ESC`：随时返回主界面

## 快速运行

```bash
npm install
npm run dev
```

打开浏览器访问 `http://localhost:5173/` 即可游玩。

### 生产构建与预览

```bash
npm run build
npm run preview
```

### 重新编译 WASM（需要 Emscripten `em++`）

```bash
npm run build:wasm
node scripts/test_wasm_bots.mjs
```

## 开源许可与致谢

本项目沿用原仓库 [MIT License](https://github.com/chen-006/meow-ai-arena/blob/main/LICENSE)。
规则引擎、地图、体素小人与 AI 选手源码源自 [chen-006/meow-ai-arena](https://github.com/chen-006/meow-ai-arena)（角色形象设计参考：小叶子XIYZ；美术和制作：喵了个猫了个咪了个猫）。
