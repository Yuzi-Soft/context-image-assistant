# Context Image Assistant

**A SillyTavern extension that bridges the gap between roleplay chat and AI image generation.**

Context Image Assistant reads your ongoing chat context, uses an LLM to intelligently plan image generation prompts, and feeds them to ComfyUI — turning every scene into a visual, fully automatically.

> 🌐 Supports English, 简体中文, 繁體中文. Language follows SillyTavern's locale setting.

---

## ✨ Features

### 🤖 Smart Context-to-Image Pipeline

- **Auto Analyze** — Automatically analyzes chat context after each AI reply, extracting scene, characters, actions, environment, and composition into a structured JSON prompt.
- **Auto Generate** — Optionally triggers ComfyUI/SD image generation immediately after prompt planning completes.
- **Replan from Image** — Select any previously generated image and ask the LLM to rebuild or adjust the prompt. Supports **Adjust Mode** (modify based on original) and **Rewrite Mode** (fully rewrite from current context).
- **Short Reply Filter** — Optionally skips auto-generation when the AI reply is too short (configurable character threshold).

### 🔧 Flexible LLM Configuration

- **Use SillyTavern's main LLM** — Leverage whatever model you already have configured in ST.
- **Independent OpenAI-compatible endpoint** — Point to any local or remote API (e.g. Ollama, LM Studio, DeepSeek, GPT-4o-mini) with custom URL, API key, model, and temperature.
- **Fetch model list** — Auto-discovers available models from custom endpoints.
- **API Profile Management** — Save, load, and switch between multiple API configurations.
- **Bypass ST Prompt Formats** — For OpenAI-compatible APIs, optionally bypass SillyTavern's global roleplay format to send clean, direct prompts (runs asynchronously without blocking chat).

### 📋 Prompt & Schema Control

- **System Prompt Editor** — Full popup editor for the LLM planning instruction (defines output format, JSON structure, what to extract).
- **JSON Schema Enforcement** — Enforce structured JSON output via OpenAI `response_format` / JSON mode. Compatible with GPT-4o, Claude 3.5, etc.
- **Custom JSON Schema** — Define your own output variables (e.g. custom LoRAs, aspect ratios, style switches) via a visual card editor or raw JSON.
- **Schema Profile Management** — Save and switch between multiple JSON schema configurations.
- **Global Prepend / Quality Tags** — Fixed text prepended to all generated prompts (e.g. `masterpiece, extremely detailed, cinematic lighting`).
- **Restore Defaults** — One-click reset system prompt to factory settings.

### 🎭 Character Reference System

- **Per-character visual descriptors** — Define permanent appearance details (hairstyle, eye color, outfit, accessories) for each character or group.
- **Reference profiles** — Create, rename, save, delete, and switch between multiple character reference profiles.
- **Bind / Unbind** — Link a reference profile to the current chat context so it's automatically included in every prompt plan.
- **Reference prompt template** — Customizable instruction text telling the LLM how to prioritize character appearance vs. current scene.

### 🖼️ In-Chat Controls

- **Candidate JSON block** — Prompt plan is embedded directly in the chat message as a hidden code block, persisted with chat history.
- **Inline action buttons** on every AI message with a candidate:
  - 🎨 **Generate** — Trigger image generation from the candidate.
  - 📝 **View/Edit** — Open the interactive prompt editor popup (split view: raw JSON + segmented fields with sliders).
  - 🔄 **Replan** — Re-analyze the message to generate a new candidate.
  - ❌ **Cancel** — Abort ongoing analysis or generation.
- **Interactive Prompt Editor** — Dual-panel popup with real-time sync:
  - Left: Raw JSON editor
  - Right: Segmented fields (positive prompt, negative prompt, LoRA weight sliders)
  - Copy buttons for full JSON / positive / negative / LoRA weights
  - Bidirectional sync (edit either side, the other updates live)

### 🖼️ Gallery & Image Management

- **Session Gallery** — Browse all generated images across the current chat with thumbnail grid.
- **Recycle Bin** — Soft-delete images; restore or permanently delete later.
- **Favorites** — Heart-toggle to mark images as favorites, with "Favorites Only" filter.
- **Floor Filter** — Advanced filter syntax for gallery images:
  - Single floors: `3, 5, 10`
  - Ranges: `1-5`
  - Current floor: `CUR`
  - Exclusions: `1-100 \ 3, 5` (include 1–100 but exclude floors 3 and 5)
- **Large Grid View** — Fullscreen popup gallery with adjustable column count for both Gallery and Recycle Bin.
- **Collapsible sections** — Gallery and Recycle Bin panels can be collapsed to save space.
- **Auto Clear Unshown** — Automatically moves older, unshown image candidates to recycle bin when new images are generated.
- **Bulk operations** — Clean all unshown images in chat / Empty recycle bin.

### ⌨️ Slash Commands

| Command | Description |
|---------|-------------|
| `/cia status` | Show current extension status |
| `/cia on` | Enable auto-analysis |
| `/cia off` | Disable auto-analysis |
| `/cia toggle` | Toggle auto-analysis on/off |
| `/cia analyze` | Force analysis of the last assistant message |

### 🌐 i18n

- Full localization support via SillyTavern's native `data-i18n` and `t()` framework.
- Ships with **Simplified Chinese** (`zh-cn`) and **Traditional Chinese** (`zh-tw`).
- All other locales gracefully fall back to English.

---

## 📦 Installation

### Method 1: Download

1. Download or clone this repository.
2. Place the folder at:
   ```
   SillyTavern/public/scripts/extensions/third-party/context-image-assistant
   ```
3. Restart SillyTavern.

### Method 2: SillyTavern Extension Installer

1. In SillyTavern, go to **Extensions** → **Install Extension**.
2. Enter the repository URL and install.

---

## ⚙️ Quick Start

1. **Enable the extension** — Open SillyTavern's Extensions panel. The "Context Image Assistant" drawer appears.
2. **Configure LLM** — In the **LLM** tab, choose between SillyTavern's main model or set up an independent endpoint.
3. **Configure ComfyUI** — Make sure SillyTavern's image generation is configured for ComfyUI/SDXL.
4. **Start chatting** — Toggle "Auto Analyze after AI Reply" in the **Run** tab. Images will be planned and generated automatically.
5. **Manual mode** — Click "Generate Candidate for Last Reply" to analyze on demand.

---

## 📁 File Structure

```
context-image-assistant/
├── manifest.json          # Extension metadata & locale mappings
├── index.js               # Core logic (~5000 lines)
├── settings.html          # Settings panel UI (5-tab layout)
├── style.css              # All extension styles
├── locales/
│   ├── zh-cn.json         # Simplified Chinese translations
│   └── zh-tw.json         # Traditional Chinese translations
├── LICENSE                # MIT License
└── README.md              # This file
```

---

## 📝 Notes

- **ComfyUI required** — Image generation requires SillyTavern's image generation to be configured with a ComfyUI backend.
- **LLM JSON capability** — For best results, use an LLM that supports structured JSON output (GPT-4o, Claude 3.5+, DeepSeek, etc.).
- **Chat persistence** — Candidate prompts are stored in chat metadata and persist across sessions.
- **Backup recommended** — Always keep chat/settings backups enabled.

---

## 📜 License

[MIT](LICENSE)

---
---

# Context Image Assistant（上下文图像助手）

**一个连接角色扮演聊天与 AI 图像生成的 SillyTavern 扩展。**

Context Image Assistant 读取你正在进行的聊天上下文，利用 LLM 智能规划图像生成提示词，并将其发送到 ComfyUI —— 让每个场景都能自动变成画面。

> 🌐 支持 English、简体中文、繁體中文。语言跟随 SillyTavern 的语言设置自动切换。

---

## ✨ 功能特性

### 🤖 智能上下文到图像流水线

- **自动分析** — AI 每次回复后自动分析聊天上下文，提取场景、角色、动作、环境、构图等信息，生成结构化 JSON 提示词。
- **自动生图** — 提示词规划完成后可选自动触发 ComfyUI/SD 图像生成。
- **从图片重建** — 选择任意已生成的图片，让 LLM 重建或调整提示词。支持**调整模式**（基于原图修改）和**重写模式**（基于当前上下文全新生成）。
- **短回复过滤** — AI 回复过短时可选跳过自动生成（字数阈值可配置）。

### 🔧 灵活的 LLM 配置

- **使用 SillyTavern 主 LLM** — 直接复用你在 ST 中已配置好的模型。
- **独立 OpenAI 兼容端点** — 指向任意本地或远程 API（如 Ollama、LM Studio、DeepSeek、GPT-4o-mini），自定义 URL、API Key、模型名和温度。
- **获取模型列表** — 自动从自定义端点发现可用模型。
- **API 配置管理** — 保存、加载、切换多套 API 配置。
- **绕过 ST 提示词格式** — 对于 OpenAI 兼容 API，可选绕过 SillyTavern 全局角色扮演格式，发送干净的直接提示词（异步执行，不阻塞聊天）。

### 📋 提示词与 Schema 控制

- **系统提示词编辑器** — 完整弹窗编辑器，可编辑 LLM 规划指令（定义输出格式、JSON 结构、提取内容）。
- **JSON Schema 约束** — 强制结构化 JSON 输出，通过 OpenAI `response_format` / JSON mode。兼容 GPT-4o、Claude 3.5 等。
- **自定义 JSON Schema** — 通过可视化卡片编辑器或原始 JSON 定义自定义输出变量（如自定义 LoRA、宽高比、风格开关）。
- **Schema 配置管理** — 保存和切换多套 JSON Schema 配置。
- **全局前缀 / 质量标签** — 固定文本前缀，自动添加到所有生成提示词（如 `masterpiece, extremely detailed, cinematic lighting`）。
- **恢复默认值** — 一键重置系统提示词为出厂设置。

### 🎭 角色参考系统

- **角色视觉描述** — 为每个角色或群组定义持久化的外观细节（发型、瞳色、服装、配饰等）。
- **参考配置档** — 创建、重命名、保存、删除、切换多个角色参考配置。
- **绑定 / 解绑** — 将参考配置绑定到当前聊天上下文，每次规划提示词时自动包含。
- **参考提示词模板** — 可自定义的指令文本，告诉 LLM 如何在角色外观与当前场景之间取舍。

### 🖼️ 消息内控件

- **候选 JSON 块** — 提示词规划结果嵌入聊天消息中作为隐藏代码块，随聊天记录持久化保存。
- **消息内联操作按钮**（出现在每条包含候选提示词的 AI 消息上）：
  - 🎨 **生成** — 从候选提示词触发图像生成。
  - 📝 **查看/编辑** — 打开交互式提示词编辑弹窗（分屏视图：原始 JSON + 分段字段 + 滑块）。
  - 🔄 **重新规划** — 重新分析消息以生成新的候选提示词。
  - ❌ **取消** — 中止正在进行的分析或生成。
- **交互式提示词编辑器** — 双面板弹窗，实时同步：
  - 左侧：原始 JSON 编辑器
  - 右侧：分段字段（正向提示词、负向提示词、LoRA 权重滑块）
  - 复制按钮：完整 JSON / 正向 / 负向 / LoRA 权重
  - 双向同步（编辑任一侧，另一侧实时更新）

### 🖼️ 画廊与图像管理

- **会话画廊** — 以缩略图网格浏览当前聊天中所有已生成的图像。
- **回收站** — 软删除图像，可恢复或永久删除。
- **收藏** — 爱心按钮标记收藏图片，支持"仅显示收藏"筛选。
- **楼层过滤器** — 高级过滤语法：
  - 单楼层：`3, 5, 10`
  - 范围：`1-5`
  - 当前楼层：`CUR`
  - 排除：`1-100 \ 3, 5`（包含 1–100 但排除第 3、5 楼）
- **大网格视图** — 全屏弹窗画廊，可调列数，画廊和回收站均支持。
- **可折叠面板** — 画廊和回收站面板可折叠以节省空间。
- **自动清理未展示图片** — 生成新图像时自动将旧的、未展示的候选附件移入回收站。
- **批量操作** — 清理聊天中所有未展示图片 / 清空回收站。

### ⌨️ 斜杠命令

| 命令 | 说明 |
|------|------|
| `/cia status` | 显示当前扩展状态 |
| `/cia on` | 启用自动分析 |
| `/cia off` | 关闭自动分析 |
| `/cia toggle` | 切换自动分析开关 |
| `/cia analyze` | 强制分析最后一条 AI 消息 |

### 🌐 国际化

- 通过 SillyTavern 原生 `data-i18n` 和 `t()` 框架实现完整本地化支持。
- 内置**简体中文**（`zh-cn`）和**繁體中文**（`zh-tw`）翻译。
- 其他语言环境自动回退到英文。

---

## 📦 安装方式

### 方式一：手动下载

1. 下载或克隆本仓库。
2. 将文件夹放置到：
   ```
   SillyTavern/public/scripts/extensions/third-party/context-image-assistant
   ```
3. 重启 SillyTavern。

### 方式二：SillyTavern 扩展安装器

1. 在 SillyTavern 中进入 **扩展** → **安装扩展**。
2. 输入仓库地址并安装。

---

## ⚙️ 快速开始

1. **启用扩展** — 打开 SillyTavern 的扩展面板，找到 "Context Image Assistant" 抽屉。
2. **配置 LLM** — 在 **LLM** 标签页中选择使用 SillyTavern 主模型或设置独立端点。
3. **配置 ComfyUI** — 确保 SillyTavern 的图像生成已配置好 ComfyUI/SDXL 后端。
4. **开始聊天** — 在 **运行** 标签页中开启"AI 回复后自动分析"，即可自动规划和生成图像。
5. **手动模式** — 点击"为最后一条回复生成候选"按需分析。

---

## 📁 文件结构

```
context-image-assistant/
├── manifest.json          # 扩展元数据和语言映射
├── index.js               # 核心逻辑（约 5000 行）
├── settings.html          # 设置面板 UI（5 标签页布局）
├── style.css              # 所有扩展样式
├── locales/
│   ├── zh-cn.json         # 简体中文翻译
│   └── zh-tw.json         # 繁体中文翻译
├── LICENSE                # MIT 开源协议
└── README.md              # 本文件
```

---

## 📝 注意事项

- **需要 ComfyUI** — 图像生成功能需要 SillyTavern 的图像生成配置好 ComfyUI 后端。
- **LLM JSON 能力** — 为获得最佳效果，请使用支持结构化 JSON 输出的 LLM（GPT-4o、Claude 3.5+、DeepSeek 等）。
- **聊天持久化** — 候选提示词存储在聊天元数据中，跨会话持久保存。
- **建议备份** — 请始终保持聊天/设置备份功能开启。

---

## 📜 开源协议

[MIT](LICENSE)
