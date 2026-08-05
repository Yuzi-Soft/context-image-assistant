import {
    appendMediaToMessage,
    chat,
    chat_metadata,
    event_types,
    eventSource,
    extractMessageFromData,
    formatCharacterAvatar,
    generateRaw,
    getCharacterAvatar,
    getCurrentChatId,
    getRequestHeaders,
    getUserAvatar,
    isGenerating,
    main_api,
    saveChatConditional,
    saveSettingsDebounced,
    substituteParams,
    this_chid,
    user_avatar,
} from '../../../../script.js';
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { selected_group } from '../../../group-chats.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR } from '../../../constants.js';
import { delay, getBase64Async, getStringHash } from '../../../utils.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { sendOpenAIRequest } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { t as i18nT, translate, applyLocale } from '../../../i18n.js';

// A compatible t function that supports both tagged template literals and normal string calls
function t(strings, ...values) {
    if (Array.isArray(strings)) {
        return i18nT(strings, ...values);
    }
    return translate(strings);
}

export { MODULE_NAME };

const MODULE_NAME = 'context_image_assistant';
const EXTENSION_PATH = 'third-party/context-image-assistant';
const MENU_ENTRY_ID = 'cia_menu_entry';
const PANEL_CONTAINER_ID = 'cia_settings_container';
const EXTRA_KEY = 'context_image_assistant';
const RECYCLE_BIN_KEY = 'cia_recycle_bin';
const GALLERY_UI_STATE_KEY = 'cia_gallery_ui_state';
const FAVORITE_ARCHIVE_KEY = 'cia_favorite_image_archive';
const FAVORITE_ARCHIVE_MIGRATION_KEY = 'cia_favorite_archive_migration';
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const CANDIDATE_JSON_BLOCK_LANG = 'cia-candidate-json';
const CANDIDATE_JSON_BLOCK_REGEX = /```cia-candidate-json\s*[\r\n]+[\s\S]*?```/gi;
const CANDIDATE_JSON_BODY_REGEX = /"prompt"\s*:/i;

const MINIMAL_SYSTEM_PROMPT = `You are SillyTavern's image generation prompt planner. Based on the current chat context provided by the user, extract suitable image generation parameters for ComfyUI/SDXL anime workflow.

Return ONLY a JSON object, no Markdown, no explanations, no code blocks. The JSON must contain:
{
  "prompt": "English image prompt, focusing on the current scene, characters, actions, composition, expressions, environment, camera lens, do not write as prose",
  "negative_prompt": "optional extra negative prompt; return empty string if none",
  "example_lora_1_strength": 0,
  "example_lora_2_strength": 0
}

The strength is the LoRA weight, ranging from [-1, 1]. Keep default value 0 if no obvious modification is needed.`;

const LEGACY_SYSTEM_PROMPT = `# 视觉构筑协议 v4.1 (VM-Prot-4.1)

<vm_meta>

- **协议版本**: 4.1
- **状态**: 已激活
- **适用模型**: 全学科视觉构筑专家及兼容的后续迭代版本
- **协议目标**: 建立一个高效、精准、可扩展的动漫生图提示词规划协议。
</vm_meta>

---

<global_rules>

1. **非人格化叙事 (Impersonal Narrative)**: 生成任何输出时，禁止使用"我"、"我的"、"我们"等第一人称代词，保持协议的纯粹指令性质。
2. **附加规则优先**: \`&lt;additional_rules&gt;\` 区块中的会话级偏好优先于本协议默认值；未提供时使用本协议默认行为。
</global_rules>

---

<additional_rules>
<!-- 当前没有附加规则。 -->
</additional_rules>

---

<task_definition>

**角色**: SillyTavern 的生图提示词规划器，根据用户消息中提供的当前对话上下文，提炼适合 ComfyUI/SDXL anime 工作流的生图参数。

**输出约束**: 只返回一个 JSON 对象，不要附加 Markdown，不要在 JSON 外部解释，不要代码块。必须在 JSON 的 \`reasoning\` 字段中完整记录 Step 0-8 的逐步思考、检查与修正过程；不得省略步骤或只给结论。具体字段与格式见 \`&lt;output_format&gt;\`。

**用户消息结构**（插件注入，按需出现）:
- \`&lt;conversation_context&gt;\` — 对话输入总容器
  - \`&lt;historical_interactions&gt;\` — 更早的历史交互，仅用于连续性、角色状态和上一张图焦点，不得取代当前场景
  - \`&lt;current_interaction&gt;\` — 最近一轮 user→assistant 交互，**当前画面的唯一场景来源**
    - \`&lt;current_user_input&gt;\` — 触发本轮回复的最新用户输入，仅用于理解意图、指代与场景变化要求
    - \`&lt;target_assistant_response&gt;\` — 本轮目标 AI 回复，提供本次可选的视觉场景
- \`&lt;additional_info&gt;\` — 补充信息（与 \`&lt;additional_rules&gt;\` 协同）
</task_definition>

---

<lora_config>
<!-- 当前没有 LoRA 配置。 -->
</lora_config>

---

<character_reference>
<!-- 当前没有角色或风格参考。 -->
</character_reference>

---

<visual_rules>

<visibility>

**核心原则 · 看到啥写啥（最高优先级）**: 只描述当前视角下实际可见的内容。与其他规则冲突时，此规则优先。

---

**POV 人数计数规则**:
- POV 视角人物本身**不计入**人数词。人数词只统计画面中实际可见的非视角角色。
  - 男性 POV + 1 女孩 → \`1girl\`（不是 \`2people\`）
  - 男性 POV + 2 女孩 → \`2girls\`
  - POV 场景中仅看到自身局部（手部、衣袖、随身物件等）→ 不写人数词，直接描述可见内容
- \`solo\` 标签：仅用于画面中**只有 1 个完整可见角色**且无 POV 隐式交互的场景。存在 POV 视角交互时不加 \`solo\`。

**POV 可见性推导框架**:
- 遇到 POV 场景，先代入该视角角色的身体进行推导：
  「POV 角色身体姿态 = [X]；视线朝向 = [Y]；视野范围内可见 = [清单 A]；视野盲区 / 侧后方不可见 = [清单 B]」
- 只将清单 A 的内容写进 prompt。清单 B 中的内容一律不写。

**第三人称镜头定位框架**:
- 遇到第三人称场景，先确定镜头位置：
  「镜头从 [正面/侧面/背面] [俯视/平视/仰视]，以 [远景/中景/近景/特写] 观察 [对象]，在此角度能看到 [清单]」
- 按镜头位置选用对应的构图 tag：
  - 方位: \`from behind\`, \`from side\`, \`from above\`, \`from below\`
  - 景别: \`close-up\`, \`upper body\`, \`full body\`, \`wide shot\`
  - 朝向: \`looking at viewer\`, \`facing away\`, \`profile\`

**视角专项规则**:
- **男性 POV**: 代入男方视角推导。可写视野内的手部、衣袖与随身物件；不写男方正脸、后脑、背部。
- **女性 POV**: 代入女方视角推导。最终 \`prompt\` 必须明确包含 \`female POV\`，不得只写笼统的 \`pov\`。可写视野内的手部、衣物边缘与随身物件；不写女方正脸和视野盲区。
- **背对镜头**: 只写背视图相关 tag（\`from behind, facing away, back\`）；不写正脸、眼神、胸前细节。
</visibility>

<weight_guide>
**说明**：以下配比只指导 Step 2 的描述丰富度，不得在最终输出中出现百分比数值。

**单人场景** (总配比 50%):
- 发型发色: 15%（含发色、长度、造型等）
- 面部表情: 10%（含眼睛、表情、妆容等）
- 体型特征: 5%（含身形、体态比例等）
- 服饰系统: 20%（含主服装、鞋袜、配饰等）
- 剩余 50% 分配给环境背景与镜头构图。

**双人场景** (总配比 70%):
- 角色 A 描述: 30%
- 角色 B 描述: 30%
- 互动特征: 10%
- 剩余 30% 分配给背景与镜头构图。

**动态调整**:
- 存在男性时，女性描述降 5% 转至男性。
- 多对象场景，背景权重最高降 10% 补偿。
</weight_guide>

<tag_format>

**语言**: 所有提示词必须使用英文，禁止出现中文字符。中文专有名词自动转译为罗马音或官方英文名；中文文化概念采用等效英文表达。

**质量词绝对禁令**: \`prompt\` 与 \`negative_prompt\` 两个字段都绝对禁止任何质量、评分或分辨率元标签，包括但不限于 \`masterpiece\`、\`best quality\`、\`worst quality\`、\`high quality\`、\`low quality\`、\`normal quality\`、\`highres\`、\`absurdres\`、\`score_*\`、\`rating_*\`。加括号、权重、下划线或其他格式变体仍视为同一禁词。具体画面缺陷词（如 \`bad anatomy\`、\`bad hands\`）不属于此类质量元标签。

**连接规则**: 提示词之间只能使用**半角逗号**连接，不得使用顿号（\`、\`）、空格或分号。
- 错误示例：\`1girl、full body、blue dress\`
- 正确示例：\`1girl,full body,blue dress\`

**下划线处理**: 常规 tag 中的下划线转换为空格，颜文字与 emoji 内部除外。
- 示例：\`black_hair\` → \`black hair\`；\`blush_face,^_^\` → \`blush face,^_^\`

**颜文字规则**: \`^_^\`、\`>_<\`、\`(*^__*)\` 等颜文字内部下划线不转换；每次输出最多使用 1 个。

**同人角色转义**: 系列名称括号必须反斜杠转义。
- 示例：\`lumine_(genshin)\` → \`lumine \\(genshin\\)\`

**同人角色完整格式**: \`角色类型,角色姓名\\(系列名称\\),角色特征描述\`
- 示例：\`1girl,reimu hakurei \\(touhou project\\),hakurei miko outfit,red-white shrine maiden dress,...\`

**原创角色完整格式**: \`角色类型,角色特征描述\`
- 示例：\`1girl,full body,blue dress,long hair,looking at viewer,smiling\`
</tag_format>

</visual_rules>

---

<break_syntax>
**适用方式**：仅在满足本区块多人条件时由 Step 4 启用。

### 启用与判定条件

**启用**（以下条件同时满足）:
- 当前画面中存在 2 个及以上需要独立描述的可见主体。POV 视角方默认不计入；仅当其身体主体在画面中明确可见且需要独立分区描述时才计入。
- 这些角色之间存在实质性的物理/动作交互（握手、拥抱、对视对峙、肢体搏斗、协作动作等）。

**禁用**（退回单人或常规连写模式）:
- 画面中仅 1 个需要独立描述的可见主体时禁用 BREAK；是否添加 \`solo, single_person\` 继续按 \`&lt;visibility&gt;\` 的 POV 隐式交互规则判断。
- 画面中虽有其他角色，但对方仅存在于背景/作为完全无互动的 POV 观察者。

### 格式模板

**双人原创（异性组合）**:
\`\`\`
2people(角色A类型,角色B类型),(共有标签，如背景和互动细节)
BREAK
people A:1girl,角色A类型,角色A特征描述...
BREAK
people B:1boy,角色B类型,角色B特征描述...
\`\`\`

**双人原创（同性别组合）**:
\`\`\`
2girls/2boys,(共有标签)
BREAK
girl/boy A:特征描述...
BREAK
girl/boy B:特征描述...
\`\`\`

**双人同人（异性组合）**:
\`\`\`
2people(同人A姓名,同人B姓名),(共有标签)
BREAK
people A:1girl,同人A姓名\\(系列名\\),同人A特征描述...
BREAK
people B:1boy,同人B姓名\\(系列名\\),同人B特征描述...
\`\`\`

**双人同人（同系列组合）**:
\`\`\`
2girls/2boys(同人A姓名,同人B姓名),(共有标签)
BREAK
girl/boy A:同人A姓名\\(系列名\\),同人A特征描述...
BREAK
girl/boy B:同人B姓名\\(系列名\\),同人B特征描述...
\`\`\`

**同人与原创混合组合**:
\`\`\`
2people(同人A姓名,原创B类型),(共有标签)
BREAK
people A:同人A类型,同人A姓名\\(系列名\\),同人A特征描述...
BREAK
people B:原创B类型,原创B特征描述...
\`\`\`

### 结构规范
- \`BREAK\` 分隔符必须**独占一行**，禁止行内换行。
- 共享标签（背景环境、互动细节）前置于第一行声明。
- 光影后缀 token 追加在**最后一个 BREAK 区块**的末尾。
- 每个角色区块内必须包含独立的人数/类型声明（如 \`1girl\`、\`1boy\`）。

### 分区纯粹性规则（防属性污染）
- **各分区只能**描述该角色独有的可见特征。严禁将对方角色的任何特征（发色、服装、动作、表情）写入本角色区块。
- **共有区（第一行）只允许**：背景环境 tag、双方对等参与的互动动作（\`hug\`, \`kiss\`, \`eye contact\`）、整体场景氛围 tag。
- **共有区禁止**：任何一方专属特征；有方向性的单方动作（如 \`gripping her waist\`、\`pushing her down\` 均有施力方，必须放进施力角色的分区，不能放共有区）。
- **自检**：写完每个区块后，检查「这一条 tag 是否只属于这个角色？」若答案是否，立即移走。
</break_syntax>

---

<think_format>
**执行要求**：必须执行以下全部步骤，并将完整过程写入 JSON 的 \`reasoning\` 字段；JSON 外不得输出任何推理或说明。

<think>

**Step 0 · 预处理 (Preprocessing)**

**0-A · 会话级约束读取**
读取 \`&lt;additional_rules&gt;\`，提取所有覆盖本协议默认行为的指令，将其记录为"会话级约束"。后续所有步骤优先遵从会话级约束，不可遗忘或覆盖。

**0-B · 焦点角色选择**（仅在画面存在多个候选主焦点角色时执行）

判断场景构成，按以下分支执行：

- **单人场景**（画面核心人物只有一名）
  → 焦点角色 = 该角色本身，作为画面主体，**无需选择，直接进入 Step 1**。
  → 严禁将该角色代入 POV 视角方导致画面中无可见角色。叙事上存在的"你"属于 POV 观察者，不影响焦点角色的可见性与人数计数。

- **双女主场景**（画面核心人物为两名女性，叙事上均为主角）
  1. 仅在 \`&lt;historical_interactions&gt;\` 中检索最近一条保留的图像 JSON，读取其 \`prompt\` 字段，判断上一次的焦点角色是谁；历史 JSON 的 \`reasoning\` 已由插件过滤，不得推测或复用旧推理
  2. 找到 → 本次切换到另一位角色作为焦点
  3. 未找到前文图像 JSON（首次生图）→ 随机选一位，或选叙事上更接近主角视角的角色

- **一男一（多）女场景**
  1. 读取 \`&lt;additional_rules&gt;\` 中的视角与焦点偏好声明（如有）
  2. 未指定 → 根据 \`&lt;target_assistant_response&gt;\` 中的动作量、情绪强度、叙事重要性和实际可见性选择焦点
  3. 根据上下文明示决定使用 POV 或第三人称，不因角色性别自动设定焦点

- **其他构成**（多男、群像等）
  → 按叙事上下文判断，聚焦对话量或动作量最多的一方

Step 0 结论（明确写出）：本次焦点角色 = [X]，将作为 Step 1 视角定位和 Step 2 权重分配的优先输入。

**0-C · 上下文解析 (Context Parsing)**

严格区分当前交互与历史交互：

- **当前场景选择**：\`&lt;current_user_input&gt;\` 只用于理解本轮意图、指代与要求；在 \`&lt;target_assistant_response&gt;\` 的叙事内容中自主判断并选择本轮最重要、最值得呈现的视觉场景。时间顺序可作为判断依据，但不得机械地只选择结尾场景。
- **选择范围**：本次场景必须来自 \`&lt;target_assistant_response&gt;\`；\`&lt;historical_interactions&gt;\` 不参与场景选择。
- **历史用途限制**：\`&lt;historical_interactions&gt;\` 只能补充连续性、人物身份、稳定外貌、地点演变及上一张图焦点；不能作为本次场景来源，不能复用其中的旧推理结论。
- **非叙事过滤**：跳过 CoT 推理块、规则复述、数值结算、状态更新和 JSON patch；这些内容只可帮助定位叙事正文，不可成为画面内容。
- **前文图像 JSON 识别**（仅供 Step 0-B 使用）：只扫描 \`&lt;historical_interactions&gt;\` 中包含 \`prompt\` 字段的最近一条精简 Candidate JSON，将其视为"上次生图记录"；只读取 \`prompt\` 判断焦点，不读取或复用其他字段。

**当前场景锚点（必须完整写入 reasoning）**：选定场景后，固定以下六项，不得省略：
- 时间 = [选定场景的时间]
- 地点 = [当前所在位置]
- 核心动作 = [选定场景中正在发生或刚刚完成的关键动作]
- 当前可见人物及位置 = [人物、相对位置、是否属于 POV 观察者]
- 当前服装状态 = [选定场景中实际穿着、脱下、移位或破损的服装]
- 当前身体状态 = [选定场景中的姿势、朝向及其他可见状态]

Step 1-8 必须以此锚点作为场景基准。历史信息只能补足锚点未说明的稳定事实；若与锚点冲突，以锚点为准。

---

**Step 1 · 场景切片 + 视角定位 (Scene Slicing & Viewpoint)**

从 Step 0-C 选定的“当前场景锚点”构建视觉瞬间。**必须执行对应的定位推导，仅贴标签而不推导视为步骤未完成**：

- **POV 视角** → 强制代入该角色身体逐步推导：
  「POV 角色身份 = [角色/性别]；身体姿态 = [具体描述]；视线方向 = [朝向]；
   能看到清单 A = [逐条列出]；
   视野盲区清单 B（绝对不写进 prompt）= [逐条列出]」
  → 人数词 = 清单 A 中完整可见的非视角角色数量，POV 本人不入 count。
  → 若 POV 角色为女性，构图 tag 必须使用 \`female POV\`，不能仅使用 \`pov\`。

- **第三人称** → 强制确定镜头参数：
  「镜头方位 = [正面/侧面/斜前/背面]；仰俯 = [仰/平/俯]；景别 = [特写/近景/中景/全身/远景]；
   在此角度能看到 = [逐条列出]」
  → 记录对应构图 tag（\`from behind\`/\`from above\`/\`close-up\`/\`upper body\` 等）。

Step 1 结论（明确写出）：镜头类型 = [单人/双人/多人]；角色身份 = [原创/同人]；可见角色数 = [N]。

---

**Step 2 · 视觉实体提取 (Entity Extraction)**

**严格基于 Step 1 的"能看到"清单**进行提取，禁止从角色记忆或设定中补充"应该存在"但当前视角无法确认的内容。

逐类提取（每条提取后自问：「这个要素在 Step 1 的可见清单里吗？」否则删除）：
- 人数（来自 Step 1 结论，不重新计算）
- 发型发色（确认当前视角可见）
- 瞳色（仅在脸部可见时提取）
- 服装（逐件：背视图不写前胸细节，近景上半身不写脚部，POV 不写视角盲区）
- 可见肢体与动作
- 面部表情（仅在脸部可见时提取）
- 背景环境
- 光线/天气

应用 \`&lt;weight_guide&gt;\` 控制各类 tag 的描述密度。

---

**Step 3 · 参考对齐 (Reference Alignment)**

- 若存在 \`&lt;character_reference&gt;\` 内容，将 Step 2 提取的角色特征逐项与参考标签比对，用标准 tag 替换泛泛描述，并遵守服装/外貌约束。
- 对同人角色执行设定一致性检验（发色/标志服装/标志物品），同人括号格式按 \`&lt;tag_format&gt;\` 完成转义。
- 无参考内容时跳过此步。

---

**Step 4 · 结构决策 (Structure Decision)**

**单人画面**（含 POV 中仅 1 个可见角色）：
- 若 POV 存在隐式交互 → 不加 \`solo\`
- 纯单人无 POV 交互 → 加 \`solo, single_person\`
- 按 构图→外貌→服装→动作→表情→背景 顺序组织 tag

**多人且存在实质交互** → 跳转 \`&lt;break_syntax&gt;\`，执行：
1. 选对应格式模板（原创异性 / 原创同性 / 同人 / 混合）
2. 第一行共有区：对每条 tag 问「这是否同时描述了两个角色？」→ 是则放入，否则移出
3. 各 BREAK 分区：对每条 tag 问「这个 tag 是否只属于这个角色？」→ 是则写入，否则移出；有方向性的单方动作（如 \`gripping\`/\`pushing\`/\`guiding\`）放进施力角色分区
4. 光影后缀 token 追加至最后一个 BREAK 区块末尾

---

**Step 5 · 负面词推导 (Negative Brainstorm)**

以下五个维度**必须逐一检查，不可因场景"看起来简单"而整体跳过**。每个维度给出具体判断：

**A · 可见性与遮挡风险**
当前哪些元素被遮挡、位于画面外或无法从当前角度确认？扩散模型最容易错误补全哪些细节？
→ 不可见且容易被错误补全的元素 → neg

**B · 服装与配饰漂移**
当前角色穿着什么服装/配饰？扩散模型会联想生成哪些同类但实际不该出现的单品？
→ 常见联想：制服→错误帽饰；手套→多余手链；长外套→错误腰带；旅行装→多余背包
→ 错误联想单品 → neg；pos 中有模糊表达时换成更精确的 tag

**C · 动作强度漂移**
当前动作和人物关系处于什么程度？扩散模型是否会自动升级成比实际更剧烈的动作？
→ 例：交谈→争吵；步行→奔跑；对峙→已经攻击；轻扶→用力拉扯
→ 升级后不该出现的动作 → neg

**D · 视角溢出**
当前构图/景别下，有哪些扩散模型会生成但实际视角看不到的内容？
→ 例：背视图→生成正面细节；上半身近景→生成脚部；POV→生成视角人物的正脸；远景→生成不合理的面部特写细节
→ 视角外高风险内容 → neg

**E · 场景联想**
当前地点、道具和氛围会让扩散模型联想到哪些不应出现的额外元素？
→ 例：车站→多余列车；厨房→多余餐具；雨景→无关雨伞；格斗场景→提前出现受伤结果
→ 场景联想出的风险元素 → neg

处理汇总：
- 不得把任何质量、评分或分辨率元标签写入 \`negative_prompt\`；此禁令无例外
- 已在 pos 明确 → 无需处理
- 应出现但 pos 模糊 → 换精确 tag 修改 pos
- 不应出现且有实际风险 → 写入 \`negative_prompt\`
- 五个维度均无风险 → \`negative_prompt\` 返回空字符串

---

**Step 6 · LoRA 赋值 (LoRA Assignment)**

读取 \`&lt;lora_config&gt;\` 中的**全部字段**，按照各字段列出的赋值规则，对每个字段逐一显式推理后赋值。**不允许不加思考全部赋默认值**，每个字段必须给出一句话理由。

**⚠️ 重要格式要求：**由于你当前处于强制 JSON 结构化输出模式，请将你所有的推理过程（即“\`字段名\`：[判断依据] → 赋值 [具体数值]（理由）”）写在 JSON 输出的 **\`reasoning\`** 字段中。**不要在 JSON 外部输出任何多余的纯文本，否则会导致格式崩溃！**

若 \`&lt;lora_config&gt;\` 中包含光影后缀 token 列表，判断当前光线环境选取对应 token 追加至 JSON 的 \`prompt\` 字段末尾；无适配项则不追加。

---

**Step 7 · 三级校验 (Triple Verification)**

逐项检查；每项检查结论、发现的问题和修正过程都写入 \`reasoning\`，但不得在 JSON 外输出说明：

*语法层*
- 同人角色括号全部转义？[是/否→修正]
- BREAK 分隔符独占一行？[是/否→修正]
- tag 总数 [N] 个，在限额（单人 25-35，多人 ≤40）内？[通过/超出→裁剪]
- 全部英文无中文字符？[是/否→修正]
- \`prompt\` 和 \`negative_prompt\` 是否都完全不含质量、评分或分辨率元标签及其格式变体？[是/否→全部删除]

*逻辑层*
- POV 人数计数正确（视角本人不入 count）？可见非 POV 角色 = [N] 人，写入人数词 = [X] → [正确/有误→修正]
- 女性 POV 是否已在 \`prompt\` 中明确写入 \`female POV\`，且未退化为笼统的 \`pov\`？[是/不适用/否→修正]
- BREAK 各分区通过单一归属检验？共有区有无单方向动作或角色专属特征？[通过/发现→移走]
- Step 5 的 neg 内容已写入 \`negative_prompt\`？[已写入/遗漏→补充]
- 服装与环境有无季节/逻辑冲突？[无/有→修正]

*美学层*
- 镜头构图 tag 与 Step 1 的视角/景别匹配？[匹配/不匹配→调整]
- 光影后缀与场景氛围一致？[一致/不一致→调整]

---

**Step 8 · 格式清洗 (Format Cleanse)**
- 所有下划线→空格（颜文字/emoji 内部除外）
- 清除所有中文字符，确认半角逗号连接，无中文标点
- 最终逐字扫描 \`prompt\` 与 \`negative_prompt\`：删除全部质量、评分和分辨率元标签及其括号、权重、下划线变体；两个字段均不得残留
- 人数词在 prompt 第一位（纯风景/无可见角色/纯局部 POV 画面除外）

</think>
</think_format>

---

<output_format>
<!-- 输出模板将在发送前根据当前 JSON Schema 生成。 -->
</output_format>

---

<examples>
**用途**：以下示例仅用于格式锚定，注意力优先级最低，不得覆盖前述规则。

### 案例 1 · 单人原创 · 日常室内 · 白天
**上下文**: 你走进苏言轻的房间，温暖的阳光透过窗帘洒在木地板上。她留着金色波浪长发，系着发带，亮蓝色眼睛，身穿蓝色长裙站在窗边，双手戴白色手套，朝你微微一笑。
**决策**: 单人原创女性，solo。
**prompt**:
\`\`\`
1girl,solo,single_person,full body,blue dress,long hair,looking at viewer,smiling,blue eyes,blonde hair,wavy hair,hair ribbon,white gloves,standing,elegant pose,soft lighting,indoors,cozy room,wooden floor,window,curtains,sunlight
\`\`\`

### 案例 2 · 单人同人 · 日常教室 · 白天
**上下文**: 原神世界的校园里，甘雨独自坐在课桌前，穿百褶裙制服，因作业太多显得烦躁，红色眼睛气鼓鼓地盯着你。
**决策**: 单人同人 \`ganyu \\(genshin impact\\)\`，solo。
**prompt**:
\`\`\`
1girl,solo,single_person,ganyu \\(genshin impact\\),full body,serafuku,pleated skirt,long hair,looking at viewer,annoyed,red eyes,sailor collar,light blue hair,indoors,classroom,window,chair,desk,bookshelf,chalkboard,sunlight
\`\`\`

### 案例 3 · 双人原创 · 雨夜车站协作 · 夜晚有灯
**上下文**: 雨夜的车站站台，两名成年旅客并肩等待列车。男性替女性撑伞，女性拿着车票和小型行李箱，暖色站灯映在湿润地面上。
**决策**: 双人原创协作场景，使用 BREAK 防止服装与道具属性污染。
**prompt**:
\`\`\`
2people(adult female,adult male),sharing umbrella,train station platform,rainy night,warm station lamps,wet pavement reflections,
BREAK
people A:1girl,adult female,beige trench coat,shoulder-length brown hair,holding travel ticket,small suitcase,relieved smile,
BREAK
people B:1boy,adult male,navy raincoat,short black hair,holding umbrella,backpack,looking toward arriving train,ootk56r,lamp,night
\`\`\`

### 案例 4 · 单人同人 · 动作施法 · 日落
**上下文**: 博丽神社广场，博丽灵梦手持御币，数枚阴阳玉和神符悬浮，眼神坚定，摆出施法姿势，迎着落日余晖守护神社。
**决策**: 单人同人 \`reimu hakurei \\(touhou project\\)\`，solo。
**prompt**:
\`\`\`
1girl,solo,single_person,reimu hakurei \\(touhou project\\),hakurei miko outfit,red-white shrine maiden dress,gohei in hand,yin-yang orbs floating,flowing black hair,red ribbon hair tie,determined expression,dynamic spellcasting pose,shrine grounds backdrop,glowing barrier patterns,paper talismans
\`\`\`

### 案例 5 · 双人原创 · 日常（拥抱）· 白天户外
**上下文**: 樱花飘落的学校庭院，两个JK女高中生深情拥抱，阳光透过树叶洒下，两人红着脸相视而笑。
**决策**: 双人女性原创，BREAK 语法防发色/校服属性污染。
**prompt**:
\`\`\`
2girls,hug,school courtyard,sakura petals falling,sunlight filtering through trees,
BREAK
girl A:sailor collar uniform,red ribbon tie,pleated skirt,thighhigh socks,chestnut bob cut,hair clip,smiling,blushing cheeks,
BREAK
girl B:navy blazer uniform,blue hair ribbon,twin tails with curls,kneehigh loafers,grinning,winking,heart-shaped earrings
\`\`\`

### 案例 6 · 双人原创 · 动作对峙 · 白天户外
**上下文**: 荒野室外，两名武士按剑对峙，眼神交汇，狂风落叶纷飞。
**决策**: 双人男性原创，BREAK 语法防装备属性污染。
**prompt**:
\`\`\`
2boys,outdoors,combat,eye contact,
BREAK
boy A:samurai,katana,black haori,white juban,dark blue hakama,scar across left cheek,topknot hairstyle,low stance,piercing gaze,bloodstained headband,wind-swept clothing,
BREAK
boy B:samurai,katana,grey kimono,brown tasuki cords,straw hat hanging back,unshaven face,crossed arms,torn sleeve revealing arm tattoos,smirk,crescent moon earring
\`\`\`

### 案例 7 · 双人同人 · 日常（拥抱）· 白天室内
**上下文**: 刀剑神域木屋室内，桐人和亚丝娜紧紧拥抱，额头相抵，阳光透过窗帘，玫瑰花瓣飞舞，两人温柔微笑。
**决策**: 双人同人异性，BREAK 语法。
**prompt**:
\`\`\`
2people(asuna,kirito),hug,forehead touching,intertwined fingers,floating rose petals,warm color palette,indoor,wooden floor,sunlight through curtains,gentle smile,
BREAK
people A:1girl,asuna \\(sword art online\\),white knight's uniform,red trim details,chestnut long hair,hair ribbon,thighhigh boots,blushing cheeks,
BREAK
people B:1boy,kirito \\(sword art online\\),black coat with silver accents,dual swords on back,spiky black hair,protective embrace pose
\`\`\`

### 案例 8 · 双人混合 · 魔法遗迹协作 · 夜晚无灯
**上下文**: 夜晚的古代遗迹中，旅行者荧与一名原创男性学者共同检查发光机关。荧持剑警戒，学者翻阅笔记并指向符文，两人合作寻找通路。
**决策**: 双人混合（同人+原创）协作场景，使用 BREAK 分离角色装备。
**prompt**:
\`\`\`
2people(lumine,adult male scholar),ancient ruins,examining magical mechanism,glowing runes,night,cooperative exploration,
BREAK
people A:1girl,lumine \\(genshin impact\\),white traveler dress,blonde hair,flower hair ornament,holding glowing sword,focused expression,
BREAK
people B:1boy,adult male scholar,brown expedition coat,leather satchel,round glasses,holding open notebook,pointing at runes,anee23k,dark,night,dim light,cozy lighting
\`\`\`

</examples>`;



const SYSTEM_PROMPT_DEFAULT = LEGACY_SYSTEM_PROMPT;
const DEFAULT_SYSTEM_PROMPT = SYSTEM_PROMPT_DEFAULT;



const DEFAULT_REFERENCE_PROMPT = 'This is character reference info. Prioritize maintaining these appearance, clothing, traits, and fixed settings; if in conflict with the current context, the current context prevails.';

const DEFAULT_CONTEXT_CLEANER_RULES = [
    {
        id: 'strip_thinking_blocks',
        label: 'Strip thinking blocks',
        enabled: true,
        find: '/<think\\b[^>]*>[\\s\\S]*?<\\/think>|<thinking\\b[^>]*>[\\s\\S]*?<\\/thinking>|<think\\b[^>]*>[\\s\\S]*$|<thinking\\b[^>]*>[\\s\\S]*$|<\\/?think\\b[^>]*>|<\\/?thinking\\b[^>]*>/gi',
        replace: '',
    },
    {
        id: 'strip_disclaimer_interleaving',
        label: 'Strip disclaimer/interleaving',
        enabled: true,
        find: '/<disclaimer\\b[^>]*>[\\s\\S]*?<\\/disclaimer>|<interleaving\\b[^>]*>[\\s\\S]*?<\\/interleaving>|<\\/?interleaving\\b[^>]*>/gi',
        replace: '',
    },
    {
        id: 'unwrap_details_summary',
        label: 'Unwrap details summary',
        enabled: true,
        find: '/<details\\b[^>]*>\\s*<summary\\b[^>]*>([\\s\\S]*?)<\\/summary>([\\s\\S]*?)<\\/details>/gi',
        replace: '$1\n$2',
    },
    {
        id: 'unwrap_summary_tags',
        label: 'Unwrap summary tags',
        enabled: true,
        find: '/<\\/?summary\\b[^>]*>/gi',
        replace: '',
    },
    {
        id: 'strip_html_ui_noise',
        label: 'Strip HTML UI noise',
        enabled: false,
        find: '/<!--[\\s\\S]*?-->|<script\\b[^>]*>[\\s\\S]*?<\\/script>|<style\\b[^>]*>[\\s\\S]*?<\\/style>|<\\/?(?:iframe|html|body|head|div|span|section|article|button|svg|path|defs|g|mask|filter|circle|rect)\\b[^>]*>/gi',
        replace: '',
    },
];

const DEFAULT_SETTINGS = {
    enabled: false,
    autoGenerate: false,
    useStPromptPreset: true,
    providerMode: 'st_current',
    customUrl: 'http://127.0.0.1:5000/v1',
    customModel: '',
    customApiKey: '',
    customTemperature: 0.3,
    responseTokens: 700,
    contextMessages: 12,
    contextChars: 8000,
    minPromptChars: 20,
    includeSystem: false,
    includeNames: true,
    enableContextCleaner: true,
    contextCleanerRules: DEFAULT_CONTEXT_CLEANER_RULES,
    useJsonSchema: true,
    useCustomJsonSchema: false,
    customJsonSchema: '',
    jsonSchemaProfiles: [],
    legacySystemPrompt: SYSTEM_PROMPT_DEFAULT,
    systemPrompt: SYSTEM_PROMPT_DEFAULT,
    prependMessage: '',
    additionalInstructionProfiles: [],
    activeAdditionalInstructionProfile: '',
    apiProfiles: [],
    referencePrompt: DEFAULT_REFERENCE_PROMPT,
    characterReferences: {},
    loraMin: -1,
    loraMax: 1,
    loraConfigContent: '',
    autoClear: false,
    autoGenerateOnRebuild: false,
    galleryCollapsed: false,
    recycleCollapsed: false,
    largeGridColumns: 3,
    preventShortLlmImages: false,
    shortLlmLengthThreshold: 10,
    filterCiaJsonFromMain: false,
    filterCiaJsonFromPlugin: false,
    promptRuleProfiles: {},
    activePromptRuleProfile: '',
    tagSeparator: ',',
};

const FIXED_SCHEMA_PROPERTIES = Object.freeze({
    reasoning: Object.freeze({
        type: 'string',
        description: 'Complete Step 0-8 reasoning, checks, corrections, and assignment rationale for every dynamic field.',
    }),
    prompt: Object.freeze({
        type: 'string',
        description: 'Positive image-generation prompt.',
    }),
    negative_prompt: Object.freeze({
        type: 'string',
        description: 'Negative image-generation prompt; use an empty string when unnecessary.',
    }),
});
const FIXED_SCHEMA_KEYS = Object.freeze(Object.keys(FIXED_SCHEMA_PROPERTIES));

const IMAGE_JSON_SCHEMA = {
    name: 'context_image_request',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        properties: {
            ...JSON.parse(JSON.stringify(FIXED_SCHEMA_PROPERTIES)),
            example_lora_1_strength: {
                type: 'number',
                title: 'Example Style LoRA 1 Strength',
                description: 'Controls the rendering strength of the first example style LoRA',
                minimum: -1,
                maximum: 1,
                default: 0,
            },
            example_lora_2_strength: {
                type: 'number',
                title: 'Example Style LoRA 2 Strength',
                description: 'Controls the rendering strength of the second example style LoRA',
                minimum: -1,
                maximum: 1,
                default: 0,
            },
        },
        required: [...FIXED_SCHEMA_KEYS, 'example_lora_1_strength', 'example_lora_2_strength'],
    },
};

const activeRequests = new Set();
const activeGenerations = new Set();
const pendingAutoAnalyze = new Set();
const queuedAutoAnalyze = [];
let autoAnalyzeWorkerRunning = false;
let autoAnalyzeRetryTimer = null;
const plannerAbortControllers = new Map();
const imageAbortControllers = new Map();
const cancelRequestedPlanner = new Set();
const cancelRequestedImage = new Set();
const runtimeState = {
    status: 'idle',
    lastResult: 'Not run yet',
};

function ensureSettings() {
    extension_settings[MODULE_NAME] ??= {};
    const settings = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value && typeof value === 'object' ? { ...value } : value;
        }
    }
    if (!settings.referencePrompt) {
        settings.referencePrompt = DEFAULT_REFERENCE_PROMPT;
    }
    if (!settings.characterReferences || typeof settings.characterReferences !== 'object' || Array.isArray(settings.characterReferences)) {
        settings.characterReferences = {};
    }
    if (!settings.promptRuleProfiles || typeof settings.promptRuleProfiles !== 'object' || Array.isArray(settings.promptRuleProfiles)) {
        settings.promptRuleProfiles = {};
    }
    if (!Array.isArray(settings.contextCleanerRules)) {
        settings.contextCleanerRules = DEFAULT_CONTEXT_CLEANER_RULES.map(rule => ({ ...rule }));
    } else {
        settings.contextCleanerRules = settings.contextCleanerRules.map((rule, index) => ({
            id: String(rule?.id || `rule_${Date.now()}_${index}`),
            label: String(rule?.label || `Rule ${index + 1}`),
            enabled: rule?.enabled !== false,
            find: String(rule?.find || ''),
            replace: String(rule?.replace || ''),
        }));
    }
    if (typeof settings.enableContextCleaner !== 'boolean') {
        settings.enableContextCleaner = DEFAULT_SETTINGS.enableContextCleaner;
    }
    if (typeof settings.tagSeparator !== 'string' || !settings.tagSeparator) {
        settings.tagSeparator = ',';
    }
    if (!settings.legacySystemPrompt) {
        settings.legacySystemPrompt = settings.systemPromptDefault || settings.systemPromptCustom || settings.systemPrompt || SYSTEM_PROMPT_DEFAULT;
    }
    settings.systemPrompt = getActiveSystemPrompt(settings);
    if (!Array.isArray(settings.apiProfiles)) {
        settings.apiProfiles = [];
    }
    if (!Array.isArray(settings.additionalInstructionProfiles)) {
        settings.additionalInstructionProfiles = [];
    } else {
        settings.additionalInstructionProfiles = settings.additionalInstructionProfiles
            .filter(profile => profile && typeof profile === 'object' && String(profile.name || '').trim())
            .map(profile => ({
                name: String(profile.name || '').trim(),
                content: String(profile.content || ''),
                updatedAt: String(profile.updatedAt || ''),
            }));
    }
    if (typeof settings.activeAdditionalInstructionProfile !== 'string') {
        settings.activeAdditionalInstructionProfile = '';
    }
    if (!Array.isArray(settings.jsonSchemaProfiles)) {
        settings.jsonSchemaProfiles = [];
    }
    if (!settings.customJsonSchema) {
        settings.customJsonSchema = JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
    }
    normalizeLoraRangeSettings(settings);
    // Migration: legacy provider option removed.
    if (settings.providerMode === 'st_custom_config') {
        settings.providerMode = 'custom_proxy';
    }
    if (settings.customJsonSchema) {
        settings.customJsonSchema = ensureSchemaConstraintsInString(settings.customJsonSchema);
    }
    if (Array.isArray(settings.jsonSchemaProfiles)) {
        for (const profile of settings.jsonSchemaProfiles) {
            if (profile.customJsonSchema) {
                profile.customJsonSchema = ensureSchemaConstraintsInString(profile.customJsonSchema);
            }
        }
    }
    const activeSchemaProfile = settings.jsonSchemaProfiles.find(profile =>
        String(profile?.customJsonSchema || '') === String(settings.customJsonSchema || ''),
    );
    if (activeSchemaProfile) {
        settings.loraConfigContent = buildLoraConfigContent(activeSchemaProfile);
    }
    return settings;
}

function normalizeLoraRangeSettings(settings) {
    settings.loraMin = clampNumber(settings.loraMin, -10, 10, DEFAULT_SETTINGS.loraMin);
    settings.loraMax = clampNumber(settings.loraMax, -10, 10, DEFAULT_SETTINGS.loraMax);
    if (settings.loraMin > settings.loraMax) {
        [settings.loraMin, settings.loraMax] = [settings.loraMax, settings.loraMin];
    }
}

function getLoraRange() {
    const settings = ensureSettings();
    return {
        min: settings.loraMin,
        max: settings.loraMax,
    };
}

function getCandidateStrengthSource(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return {};
    }
    return value.strengths || value.lora_strengths || value.lora || value;
}

function getCandidateStrength(value, key, fallback) {
    const source = getCandidateStrengthSource(value);
    return source?.[key] ?? value?.[key] ?? fallback;
}

function getCandidatePositivePrompt(value, fallback = '') {
    return String(value?.prompt ?? value?.positive_prompt ?? value?.image_prompt ?? fallback ?? '');
}

function getCandidateNegativePrompt(value, fallback = '') {
    return String(value?.negative_prompt ?? value?.negative ?? fallback ?? '');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;');
}

function escapeHtmlAttr(value) {
    return escapeHtml(value).replaceAll('`', '&#96;');
}

function escapeXmlTextContent(value) {
    return String(value ?? '')
        .replace(/&(?!#\d+;|#x[\da-f]+;|[a-z][\w.-]*;)/gi, '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function getActiveSystemPrompt(settings = ensureSettings()) {
    const basePrompt = String(settings.legacySystemPrompt || SYSTEM_PROMPT_DEFAULT);
    const loraContent = escapeXmlTextContent(settings.loraConfigContent).trim();
    if (loraContent) {
        return replaceXmlInterface(basePrompt, 'lora_config', loraContent);
    }
    return replaceXmlInterface(basePrompt, 'lora_config', '', '<!-- 当前没有 LoRA 配置。 -->');
}

function replaceXmlInterface(prompt, tagName, content, emptyContent = '') {
    const blockRegex = new RegExp(
        `^[\\t ]*(<${tagName}\\b[^>]*>)[\\t ]*$[\\s\\S]*?^[\\t ]*(<\\/${tagName}>)[\\t ]*$`,
        'im',
    );
    if (!blockRegex.test(prompt)) {
        return prompt;
    }

    const normalizedContent = String(content || '').trim() || String(emptyContent || '').trim();
    return prompt.replace(blockRegex, (_, open, close) => {
        return normalizedContent ? `${open}\n${normalizedContent}\n${close}` : `${open}\n${close}`;
    });
}

function getPlannerSystemPrompt(settings = ensureSettings()) {
    let prompt = getActiveSystemPrompt(settings);
    prompt = replaceXmlInterface(prompt, 'additional_rules', escapeXmlTextContent(settings.prependMessage), '<!-- 当前没有附加规则。 -->');

    const entry = getCurrentReferenceEntry();
    const referenceText = escapeXmlTextContent(entry?.text).trim();
    const referenceInstruction = escapeXmlTextContent(entry?.prompt || settings.referencePrompt || DEFAULT_REFERENCE_PROMPT).trim();
    const referenceContent = referenceText
        ? `<instruction>\n${referenceInstruction}\n</instruction>\n<profile>\n${referenceText}\n</profile>`
        : '';
    prompt = replaceXmlInterface(prompt, 'character_reference', referenceContent, '<!-- 当前没有角色或风格参考。 -->');
    prompt = replaceXmlInterface(prompt, 'output_format', escapeXmlTextContent(buildOutputFormatContent(settings)));
    return prompt;
}

function buildOutputFormatContent(settings) {
    const schema = getEffectiveJsonSchema(settings) || IMAGE_JSON_SCHEMA;
    const properties = schema?.value?.properties || schema?.schema?.properties || schema?.properties || {};
    const output = {};

    for (const [key, property] of Object.entries(properties)) {
        if (key === 'reasoning') {
            output[key] = '完整记录 Step 0-8 的逐步思考、检查、修正过程，以及每个动态字段的判断依据与赋值理由';
        } else if (key === 'prompt') {
            output[key] = '英文图像提示词';
        } else if (key === 'negative_prompt') {
            output[key] = '英文负面提示词；不需要时返回空字符串';
        } else if (property?.default !== undefined) {
            output[key] = property.default;
        } else if (property?.type === 'number' || property?.type === 'integer') {
            output[key] = 0;
        } else if (property?.type === 'boolean') {
            output[key] = false;
        } else if (property?.type === 'array') {
            output[key] = [];
        } else if (property?.type === 'object') {
            output[key] = {};
        } else {
            output[key] = '';
        }
    }

    return [
        '<!-- 此输出模板由插件根据当前 JSON Schema 动态生成；字段必须完整对应，不得增删或改名 -->',
        '```json',
        JSON.stringify(output, null, 2),
        '```',
    ].join('\n');
}

function getApiProfileList() {
    const settings = ensureSettings();
    return settings.apiProfiles
        .filter(x => x && typeof x === 'object' && String(x.name || '').trim())
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getJsonSchemaProfileList() {
    const settings = ensureSettings();
    return settings.jsonSchemaProfiles
        .filter(x => x && typeof x === 'object' && String(x.name || '').trim())
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function renderJsonSchemaProfileOptions() {
    const select = $('#cia_schema_profile_select');
    if (!select.length) {
        return;
    }

    const profiles = getJsonSchemaProfileList();
    const currentName = String(select.val() || '');
    select.empty();
    if (!profiles.length) {
        select.append($('<option></option>').val('').text(t`No saved formats`));
        select.prop('disabled', true);
        return;
    }

    for (const profile of profiles) {
        select.append($('<option></option>').val(profile.name).text(profile.name));
    }
    select.prop('disabled', false);
    const hasCurrent = profiles.some(x => x.name === currentName);
    select.val(hasCurrent ? currentName : profiles[0].name);
}


function removeJsonSchemaProfileByName(name) {
    const settings = ensureSettings();
    const before = settings.jsonSchemaProfiles.length;
    settings.jsonSchemaProfiles = settings.jsonSchemaProfiles.filter(x => String(x?.name || '') !== String(name || ''));
    return settings.jsonSchemaProfiles.length !== before;
}

function populateApiProfileSelect() {
    const select = $(`#${PANEL_CONTAINER_ID} #cia_api_profile_select`);
    if (!select.length) {
        return;
    }

    const profiles = getApiProfileList();
    const currentName = String(select.val() || '');
    select.empty();
    if (!profiles.length) {
        select.append($('<option></option>').val('').text(t`No profiles saved`));
        select.prop('disabled', true);
        return;
    }

    for (const profile of profiles) {
        select.append($('<option></option>').val(profile.name).text(profile.name));
    }
    select.prop('disabled', false);

    const settings = ensureSettings();
    if (currentName && profiles.some(x => String(x?.name || '') === currentName)) {
        select.val(currentName);
    } else if (settings.providerMode === 'custom_proxy') {
        const matched = profiles.find(x =>
            String(x.customUrl || '').trim() === String(settings.customUrl || '').trim() &&
            String(x.customModel || '').trim() === String(settings.customModel || '').trim(),
        );
        if (matched) {
            select.val(matched.name);
        }
    }
}

function upsertApiProfile(name) {
    const settings = ensureSettings();
    name = String(name || '').trim();
    if (!name) {
        throw new Error(t`Profile name cannot be empty.`);
    }

    const next = {
        name,
        customUrl: settings.customUrl,
        customModel: settings.customModel,
        customApiKey: settings.customApiKey,
        customTemperature: settings.customTemperature,
        responseTokens: settings.responseTokens,
        updatedAt: new Date().toISOString(),
    };
    const index = settings.apiProfiles.findIndex(x => String(x?.name || '') === name);
    if (index >= 0) {
        settings.apiProfiles[index] = next;
    } else {
        settings.apiProfiles.push(next);
    }
}

function applyApiProfileByName(name) {
    const settings = ensureSettings();
    name = String(name || '').trim();
    const profile = settings.apiProfiles.find(x => String(x?.name || '') === name);
    if (!profile) {
        throw new Error(t`Profile not found.`);
    }

    settings.providerMode = 'custom_proxy';
    settings.customUrl = String(profile.customUrl || '').trim();
    settings.customModel = String(profile.customModel || '').trim();
    settings.customApiKey = String(profile.customApiKey || '').trim();
    settings.customTemperature = clampNumber(profile.customTemperature, 0, 2, DEFAULT_SETTINGS.customTemperature);
    settings.responseTokens = clampInteger(profile.responseTokens, 64, 4096, DEFAULT_SETTINGS.responseTokens);
}

function removeApiProfileByName(name) {
    const settings = ensureSettings();
    const before = settings.apiProfiles.length;
    settings.apiProfiles = settings.apiProfiles.filter(x => String(x?.name || '') !== String(name || ''));
    return settings.apiProfiles.length !== before;
}

function updateStatusUi() {
    const settings = ensureSettings();
    $('#cia_enabled').prop('checked', settings.enabled);
    $('#cia_auto_generate').prop('checked', settings.autoGenerate);
    $('#cia_use_st_prompt_preset').prop('checked', settings.useStPromptPreset);
    $('#cia_use_json_schema').prop('checked', settings.useJsonSchema);
    $('#cia_use_custom_json_schema').prop('checked', settings.useCustomJsonSchema);
    $('#cia_provider_mode').val(settings.providerMode);
    $('#cia_response_tokens').val(settings.responseTokens);
    $('#cia_custom_url').val(settings.customUrl);
    $('#cia_custom_model').val(settings.customModel);
    $('#cia_custom_model_select').val('');
    $('#cia_custom_api_key').val(settings.customApiKey);
    $('#cia_custom_temperature').val(settings.customTemperature);
    $('#cia_context_messages').val(settings.contextMessages);
    $('#cia_context_chars').val(settings.contextChars);
    $('#cia_min_prompt_chars').val(settings.minPromptChars);

    $('#cia_include_system').prop('checked', settings.includeSystem);
    $('#cia_include_names').prop('checked', settings.includeNames);
    $('#cia_enable_context_cleaner').prop('checked', settings.enableContextCleaner);
    $('#cia_filter_cia_json_from_main').prop('checked', settings.filterCiaJsonFromMain);
    $('#cia_filter_cia_json_from_plugin').prop('checked', settings.filterCiaJsonFromPlugin);
    $('#cia_system_prompt').val(getActiveSystemPrompt(settings));
    $('#cia_prepend_message').val(settings.prependMessage);
    $('#cia_custom_json_schema').val(settings.customJsonSchema || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2));
    $('#cia_custom_api_block').toggle(settings.providerMode === 'custom_proxy');
    $('#cia_auto_clear').prop('checked', settings.autoClear);
    $('#cia_auto_generate_on_rebuild').prop('checked', settings.autoGenerateOnRebuild);
    $('#cia_prevent_short_llm_images').prop('checked', settings.preventShortLlmImages);
    $('#cia_short_llm_length_threshold').val(settings.shortLlmLengthThreshold);
    populateApiProfileSelect();
    renderJsonSchemaProfileOptions();
    $('#cia_status_value').text(runtimeState.status);
    $('#cia_last_result').text(runtimeState.lastResult);
    updateReferenceStatusUi();
}

function saveFromUi() {
    const settings = ensureSettings();
    const wasAutoAnalyzeEnabled = Boolean(settings.enabled);
    settings.enabled = !!$('#cia_enabled').prop('checked');
    settings.autoGenerate = !!$('#cia_auto_generate').prop('checked');
    settings.useStPromptPreset = !!$('#cia_use_st_prompt_preset').prop('checked');
    settings.useJsonSchema = !!$('#cia_use_json_schema').prop('checked');
    settings.useCustomJsonSchema = !!$('#cia_use_custom_json_schema').prop('checked');
    settings.providerMode = String($('#cia_provider_mode').val() || DEFAULT_SETTINGS.providerMode);
    settings.responseTokens = clampInteger($('#cia_response_tokens').val(), 64, 4096, DEFAULT_SETTINGS.responseTokens);
    settings.customUrl = String($('#cia_custom_url').val() || '').trim();
    settings.customModel = String($('#cia_custom_model').val() || '').trim();
    settings.customApiKey = String($('#cia_custom_api_key').val() || '').trim();
    settings.customTemperature = clampNumber($('#cia_custom_temperature').val(), 0, 2, DEFAULT_SETTINGS.customTemperature);
    settings.contextMessages = clampInteger($('#cia_context_messages').val(), 1, 200, DEFAULT_SETTINGS.contextMessages);
    settings.contextChars = clampInteger($('#cia_context_chars').val(), 0, 100000, DEFAULT_SETTINGS.contextChars);
    settings.minPromptChars = clampInteger($('#cia_min_prompt_chars').val(), 0, 1000, DEFAULT_SETTINGS.minPromptChars);
    normalizeLoraRangeSettings(settings);
    settings.includeSystem = !!$('#cia_include_system').prop('checked');
    settings.includeNames = !!$('#cia_include_names').prop('checked');
    settings.enableContextCleaner = !!$('#cia_enable_context_cleaner').prop('checked');
    settings.filterCiaJsonFromMain = !!$('#cia_filter_cia_json_from_main').prop('checked');
    settings.filterCiaJsonFromPlugin = !!$('#cia_filter_cia_json_from_plugin').prop('checked');

    settings.systemPrompt = getActiveSystemPrompt(settings);
    $('#cia_system_prompt').val(settings.systemPrompt);

    settings.prependMessage = String($('#cia_prepend_message').val() || '');
    settings.customJsonSchema = String($('#cia_custom_json_schema').val() || '').trim() || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
    settings.customJsonSchema = ensureSchemaConstraintsInString(settings.customJsonSchema);
    settings.autoClear = !!$('#cia_auto_clear').prop('checked');
    settings.autoGenerateOnRebuild = !!$('#cia_auto_generate_on_rebuild').prop('checked');
    settings.preventShortLlmImages = !!$('#cia_prevent_short_llm_images').prop('checked');
    settings.shortLlmLengthThreshold = clampInteger($('#cia_short_llm_length_threshold').val(), 1, 1000, DEFAULT_SETTINGS.shortLlmLengthThreshold || 10);
    if (wasAutoAnalyzeEnabled && !settings.enabled) {
        queuedAutoAnalyze.length = 0;
    }

    saveSettingsDebounced();
    $('#cia_custom_api_block').toggle(settings.providerMode === 'custom_proxy');
    populateApiProfileSelect();
    renderJsonSchemaProfileOptions();
    $('#cia_status_value').text(runtimeState.status);
    $('#cia_last_result').text(runtimeState.lastResult);
}


async function createSettingsUi() {
    if (!$(`#${PANEL_CONTAINER_ID}`).length) {
        const target = $('#extensions_settings2').length ? '#extensions_settings2' : '#extensions_settings';
        $(target).append(`<div id="${PANEL_CONTAINER_ID}" class="extension_container"></div>`);
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_PATH, 'settings');
    const panel = $(`#${PANEL_CONTAINER_ID}`);
    panel.off('.ciaSettings');
    panel.empty().append(html);

    $('#cia_enabled, #cia_auto_generate, #cia_use_st_prompt_preset, #cia_use_json_schema, #cia_use_custom_json_schema, #cia_include_system, #cia_include_names, #cia_enable_context_cleaner, #cia_filter_cia_json_from_main, #cia_filter_cia_json_from_plugin, #cia_auto_clear, #cia_auto_generate_on_rebuild, #cia_prevent_short_llm_images').on('change', saveFromUi);
    $('#cia_provider_mode, #cia_response_tokens, #cia_custom_url, #cia_custom_model, #cia_custom_api_key, #cia_custom_temperature, #cia_context_messages, #cia_context_chars, #cia_min_prompt_chars, #cia_system_prompt, #cia_prepend_message, #cia_custom_json_schema, #cia_short_llm_length_threshold').on('input change', saveFromUi);
    $('#cia_custom_model_select').on('change', function () {
        const value = String($(this).val() || '').trim();
        if (!value) {
            return;
        }
        $('#cia_custom_model').val(value);
        saveFromUi();
    });
    $('#cia_fetch_custom_models').on('click', async () => {
        await fetchCustomModels();
    });
    $('#cia_api_profile_save').on('click', async () => {
        const settings = ensureSettings();
        let host = 'api-config';
        try {
            host = new URL(normalizeCustomUrl(settings.customUrl) || 'http://127.0.0.1').host || host;
        } catch {
            // ignore invalid URL
        }
        const suggested = settings.customModel || host;
        const name = await Popup.show.input(t`Save API Profile`, t`Enter profile name`, suggested, { okButton: t`Save`, cancelButton: t`Cancel` });
        if (name === null) {
            return;
        }
        try {
            saveFromUi();
            upsertApiProfile(name);
            saveSettingsDebounced();
            populateApiProfileSelect();
            $('#cia_api_profile_select').val(String(name).trim());
            toastr.success(t`API configuration saved.`, 'Context Image Assistant');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    });
    $('#cia_api_profile_load').on('click', () => {
        const name = String($('#cia_api_profile_select').val() || '');
        if (!name) {
            return;
        }
        try {
            applyApiProfileByName(name);
            saveSettingsDebounced();
            updateStatusUi();
            toastr.success(t`Profile loaded: ${name}`, 'Context Image Assistant');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    });
    $('#cia_api_profile_delete').on('click', async () => {
        const name = String($('#cia_api_profile_select').val() || '');
        if (!name) {
            return;
        }
        const confirmed = await Popup.show.confirm(t`Delete API Profile`, t`Are you sure you want to delete API profile "${name}"?`);
        if (!confirmed) {
            return;
        }
        if (removeApiProfileByName(name)) {
            saveSettingsDebounced();
            populateApiProfileSelect();
            toastr.info(t`Profile deleted: ${name}`, 'Context Image Assistant');
        }
    });

    $('#cia_edit_system_prompt_btn').on('click', openSystemPromptEditor);
    $('#cia_edit_prepend_message_btn').on('click', openAdditionalImageInstructionsEditor);
    $('#cia_edit_json_schema_btn').on('click', openCustomJsonSchemaEditor);
    $('#cia_character_reference').on('click', openCharacterReferenceEditor);
    $('#cia_edit_prompt_rules_btn').on('click', openPromptRulesEditor);
    $('#cia_analyze_last').on('click', async () => {
        const messageId = getLastAssistantMessageId();
        if (messageId === null) {
            toastr.warning(t`No character reply available to analyze.`, 'Context Image Assistant');
            return;
        }
        await requestImageCandidate(messageId, { force: true, manual: true });
    });
    $('#cia_inspect_prompts').on('click', async () => {
        await showPromptInspector();
    });
    $('#cia_configure_context_cleaner').on('click', async () => {
        await openContextCleanerEditor();
    });
    $('#cia_clean_context_preview').on('click', async () => {
        await showCleanContextPreview();
    });


    panel.on('click.ciaSettings', '#cia_save_gallery', async function () {
        if (hasUnsavedGalleryChanges) {
            hasUnsavedGalleryChanges = false;
            $(`#${PANEL_CONTAINER_ID} #cia_save_gallery`).hide();
            await saveChatConditional();
            toastr.success(t`All favorite statuses successfully saved.`, 'Context Image Assistant');
        }
    });

    // Tab switching listener
    panel.on('click.ciaSettings', '.cia-tab-btn', function () {
        if (hasUnsavedGalleryChanges) {
            hasUnsavedGalleryChanges = false;
            $(`#${PANEL_CONTAINER_ID} #cia_save_gallery`).hide();
            void saveChatConditional();
        }
        const tabId = $(this).attr('data-tab');
        $(`#${PANEL_CONTAINER_ID} .cia-tab-btn`).removeClass('active');
        $(`#${PANEL_CONTAINER_ID} .cia-tab-content`).removeClass('active');
        $(this).addClass('active');
        $(`#${PANEL_CONTAINER_ID} #${tabId}`).addClass('active');

        const descriptions = {
            'tab-run': t`Basic switches and execution status. Control the auto image generation workflow, manually trigger planning analysis, and configure core character references here.`,
            'tab-llm': t`Configure AI model service endpoints, API keys, models, and save multiple custom API configurations.`,
            'tab-context': t`Control the number of recent chat history messages sent to the planner model and character filter settings.`,
            'tab-prompt': t`Write core system prompt instructions, custom JSON schema template structures, and prepended quality/visual prompts here.`,
            'tab-recycle': t`Preview, filter, and favorite all images generated in this session, or manage recovered/permanently deleted images in the recycle bin.`,
        };
        $(`#${PANEL_CONTAINER_ID} #cia_tab_desc`).text(descriptions[tabId] || '');

        if (tabId === 'tab-recycle') {
            renderRecycleBinList();
            renderGalleryList();
            void migrateExistingFavoriteArchiveCopies();
        }
    });

    // Collapsible sections click listener
    panel.on('click.ciaSettings', '.cia-collapse-header', function (e) {
        if ($(e.target).closest('button').length) {
            return;
        }
        const targetSelector = $(this).attr('data-target');
        const container = $(targetSelector);
        const arrow = $(this).find('.cia-collapse-arrow');
        const settings = ensureSettings();

        if (targetSelector === '#cia_gallery_grid_sub_container') {
            settings.galleryCollapsed = !settings.galleryCollapsed;
            arrow.toggleClass('collapsed', settings.galleryCollapsed);
            container.slideToggle(200, () => {
                renderGalleryList();
            });
        } else if (targetSelector === '#cia_recycle_grid_container') {
            settings.recycleCollapsed = !settings.recycleCollapsed;
            arrow.toggleClass('collapsed', settings.recycleCollapsed);
            container.slideToggle(200, () => {
                renderRecycleBinList();
            });
        }
        saveSettingsDebounced();
    });

    // Apply initial collapse states
    const settings = ensureSettings();
    if (settings.galleryCollapsed) {
        $(`#${PANEL_CONTAINER_ID} [data-target="#cia_gallery_grid_sub_container"] .cia-collapse-arrow`).addClass('collapsed');
        $(`#${PANEL_CONTAINER_ID} #cia_gallery_grid_sub_container`).hide();
    } else {
        $(`#${PANEL_CONTAINER_ID} [data-target="#cia_gallery_grid_sub_container"] .cia-collapse-arrow`).removeClass('collapsed');
        $(`#${PANEL_CONTAINER_ID} #cia_gallery_grid_sub_container`).show();
    }
    if (settings.recycleCollapsed) {
        $(`#${PANEL_CONTAINER_ID} [data-target="#cia_recycle_grid_container"] .cia-collapse-arrow`).addClass('collapsed');
        $(`#${PANEL_CONTAINER_ID} #cia_recycle_grid_container`).hide();
    } else {
        $(`#${PANEL_CONTAINER_ID} [data-target="#cia_recycle_grid_container"] .cia-collapse-arrow`).removeClass('collapsed');
        $(`#${PANEL_CONTAINER_ID} #cia_recycle_grid_container`).show();
    }

    applyGalleryUiStateToFilters();

    // Bind filters
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).on('change', () => {
        saveGalleryFilterStateFromUi();
        renderGalleryList();
    });
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).on('input', () => {
        saveGalleryFilterStateFromUi();
        scheduleGalleryFilterRender();
    });
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_help`).on('click', () => {
        showGalleryFilterHelp();
    });

    // Bind large grid buttons
    panel.on('click.ciaSettings', '#cia_open_gallery_large_grid', () => {
        showGalleryLargeGridPreview('gallery');
    });
    panel.on('click.ciaSettings', '#cia_open_large_grid', () => {
        showGalleryLargeGridPreview('recycle');
    });


    // Bind sweep / empty buttons
    $(`#${PANEL_CONTAINER_ID} #cia_clear_current_chat`).on('click', async () => {
        let sweptAny = false;
        for (const message of chat) {
            if (sweepMessage(message)) {
                sweptAny = true;
            }
        }
        if (sweptAny) {
            await saveChatWhenGeneratorIdle();
            renderAllMessageControls();
            renderRecycleBinList();
            renderGalleryList();
            toastr.success(t`All unshown images in current session cleared and moved to Recycle Bin.`, 'Context Image Assistant');
        } else {
            toastr.info(t`No images need to be cleared.`, 'Context Image Assistant');
        }
    });

    $(`#${PANEL_CONTAINER_ID} #cia_empty_recycle`).on('click', async () => {
        const bin = getRecycleBin();
        if (bin.length === 0) {
            toastr.info(t`Recycle Bin is already empty.`, 'Context Image Assistant');
            return;
        }
        const confirm = await Popup.show.confirm(t`Permanently empty Recycle Bin`, t`Are you sure you want to permanently delete all images in the Recycle Bin? This action is irreversible and will physically delete the files from your disk.`);
        if (!confirm) {
            return;
        }
        const failedItems = [];
        const itemsByUrl = new Map();
        for (const item of bin) {
            const url = String(item?.url || '');
            const group = itemsByUrl.get(url) || [];
            group.push(item);
            itemsByUrl.set(url, group);
        }
        const ignoredRecycleKeys = new Set(bin.map(getRecycleItemKey));
        for (const [url, items] of itemsByUrl) {
            if (!await deletePhysicalImageIfUnreferenced(url, ignoredRecycleKeys)) {
                failedItems.push(...items);
            }
        }
        saveRecycleBin(failedItems);
        await saveChatWhenGeneratorIdle();
        renderRecycleBinList();
        renderGalleryList();
        if (failedItems.length > 0) {
            toastr.error(t`${failedItems.length} images could not be deleted and remain in the Recycle Bin.`, 'Context Image Assistant');
        } else {
            toastr.success(t`Cleared Recycle Bin and deleted related disk files.`, 'Context Image Assistant');
        }
    });

    updateStatusUi();

    // If the recycle/gallery tab is already selected, trigger a render
    if ($(`#${PANEL_CONTAINER_ID} .cia-tab-btn[data-tab="tab-recycle"]`).hasClass('active')) {
        renderRecycleBinList();
        renderGalleryList();
        void migrateExistingFavoriteArchiveCopies();
    }
}

async function fetchCustomModels() {
    const settings = ensureSettings();
    if (!settings.customUrl) {
        toastr.warning(t`Please fill in the custom endpoint URL first.`, 'Context Image Assistant');
        return;
    }

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                chat_completion_source: 'custom',
                custom_url: normalizeCustomUrl(settings.customUrl),
                custom_include_headers: buildCustomApiKeyHeaders(settings.customApiKey),
            }),
            cache: 'no-cache',
        });
        if (!response.ok) {
            throw new Error(await response.text());
        }
        const data = await response.json();
        const models = Array.isArray(data?.data) ? data.data : [];
        const ids = models.map(x => String(x?.id || '').trim()).filter(Boolean);
        const select = $('#cia_custom_model_select');
        select.empty();
        select.append($('<option></option>').val('').text(ids.length ? t`Select Model (${ids.length})` : t`No models found`));
        for (const id of ids) {
            select.append($('<option></option>').val(id).text(id));
        }
        if (ids.includes(settings.customModel)) {
            select.val(settings.customModel);
        }
        if (!settings.customModel && ids.length) {
            $('#cia_custom_model').val(ids[0]);
            saveFromUi();
            select.val(ids[0]);
        }
        toastr.success(ids.length ? t`Retrieved ${ids.length} models.` : t`Endpoint is online, but returned no models.`, 'Context Image Assistant');
    } catch (error) {
        toastr.error(String(error?.message || error), 'Context Image Assistant');
    }
}

function createMenuEntry() {
    if ($(`#${MENU_ENTRY_ID}`).length) {
        return;
    }

    $('#extensionsMenu').append(`
        <div id="${MENU_ENTRY_ID}" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-image extensionsMenuExtensionButton"></div>
            <span>Context Image Assistant</span>
        </div>
    `);

    $(`#${MENU_ENTRY_ID}`).on('click', scrollToPanel);
}

function scrollToPanel() {
    const panel = $(`#${PANEL_CONTAINER_ID}`);
    if (!panel.length) {
        return;
    }

    const drawer = panel.find('.inline-drawer-content');
    const header = panel.find('.inline-drawer-header');
    if (drawer.is(':hidden') && header.length) {
        header.trigger('click');
    }

    const block = $('#rm_extensions_block');
    if (block.length) {
        block.animate({
            scrollTop: panel.offset().top - block.offset().top + block.scrollTop(),
        }, 300);
    }
}

function clampInteger(value, min, max, fallback) {
    const number = Number.parseInt(String(value), 10);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(Math.max(number, min), max);
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return fallback;
    }
    return Math.min(Math.max(number, min), max);
}

function getLastAssistantMessageId() {
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message && !message.is_user && !message.is_system) {
            return i;
        }
    }
    return null;
}

function getMessageText(message) {
    const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
    if (swipeId !== null && Array.isArray(message?.swipes) && typeof message.swipes[swipeId] === 'string') {
        return message.swipes[swipeId];
    }
    return String(message?.mes || '');
}

function setMessageText(message, text) {
    const value = String(text || '');
    const swipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
    if (swipeId !== null && Array.isArray(message?.swipes) && swipeId >= 0 && swipeId < message.swipes.length) {
        message.swipes[swipeId] = value;
    }
    message.mes = value;
}

function createMessageSnapshot(messageId) {
    const message = chat[messageId];
    if (!message) {
        return null;
    }

    return {
        ref: message,
        swipeId: Number.isInteger(message?.swipe_id) ? message.swipe_id : null,
        text: getMessageText(message),
        checkText: false,
    };
}

function resolveMessageTarget(messageId, expectedSnapshot = null) {
    if (expectedSnapshot?.ref) {
        const id = chat.indexOf(expectedSnapshot.ref);
        if (id < 0) {
            return null;
        }
        const message = chat[id];
        if (!message || message.is_user || message.is_system) {
            return null;
        }

        const currentSwipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
        if (expectedSnapshot.swipeId !== null && currentSwipeId !== expectedSnapshot.swipeId) {
            return null;
        }
        if (expectedSnapshot.checkText && typeof expectedSnapshot.text === 'string' && getMessageText(message) !== expectedSnapshot.text) {
            return null;
        }
        return { messageId: id, message };
    }

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) {
        return null;
    }
    return { messageId, message };
}

function normalizeTag(tag) {
    if (typeof tag !== 'string') return '';
    return tag.trim().toLowerCase().replace(/_/g, ' ');
}

function tokenizeCondition(cond) {
    if (!cond) return [];
    // Negative lookahead ensures we don't consume operators (AND, OR, NOT, &&, ||, !, parentheses) when matching multi-word tags
    const tokenRegex = /"[^"]+"|'[^']+'|\(|\)|&&|\|\||!|\bAND\b|\bOR\b|\bNOT\b|[^()&|!\s]+(?:\s+(?!\b(?:AND|OR|NOT)\b|&&|\|\||[()!])[^()&|!\s]+)*/gi;
    const tokens = [];
    let match;
    while ((match = tokenRegex.exec(cond)) !== null) {
        let t = match[0].trim();
        if (!t) continue;
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
            t = t.slice(1, -1).trim();
        }
        if (t) {
            tokens.push(t);
        }
    }
    return tokens;
}

function evaluateTriggerCondition(condition, positivePrompt, negativePrompt, separator) {
    if (!condition || !condition.trim()) {
        return true;
    }
    const sep = separator || ',';
    const cleanPos = String(positivePrompt || '').toLowerCase();
    const cleanNeg = String(negativePrompt || '').toLowerCase();

    const normPos = cleanPos.replace(/_/g, ' ');
    const normNeg = cleanNeg.replace(/_/g, ' ');
    const normCombined = normPos + ' ' + normNeg;

    const posTags = cleanPos.split(sep).map(x => normalizeTag(x)).filter(Boolean);
    const negTags = cleanNeg.split(sep).map(x => normalizeTag(x)).filter(Boolean);
    const allTags = [...posTags, ...negTags];

    const tokens = tokenizeCondition(condition);
    const resultTokens = [];

    for (const token of tokens) {
        const upperToken = token.toUpperCase();
        if (upperToken === 'AND' || token === '&&') {
            resultTokens.push('&&');
        } else if (upperToken === 'OR' || token === '||') {
            resultTokens.push('||');
        } else if (upperToken === 'NOT' || token === '!') {
            resultTokens.push('!');
        } else if (token === '(' || token === ')') {
            resultTokens.push(token);
        } else {
            const term = normalizeTag(token);
            const matched = allTags.includes(term) || normCombined.includes(term);
            resultTokens.push(matched ? 'true' : 'false');
        }
    }

    const expr = resultTokens.join(' ');
    if (!expr) return true;
    if (/^[truefals&|!()\s]+$/.test(expr)) {
        try {
            return Function(`return (${expr});`)();
        } catch (e) {
            console.error('[CIA] Error evaluating condition:', expr, e);
            return false;
        }
    }
    return false;
}

function applyPromptRules(prompt, negativePrompt) {
    const settings = ensureSettings();
    const activeProfile = settings.activePromptRuleProfile;
    if (!activeProfile) {
        return { prompt, negative_prompt: negativePrompt };
    }
    const profile = settings.promptRuleProfiles[activeProfile];
    if (!profile || !Array.isArray(profile.rules) || profile.rules.length === 0) {
        return { prompt, negative_prompt: negativePrompt };
    }

    let activePos = String(prompt || '');
    let activeNeg = String(negativePrompt || '');
    const sep = settings.tagSeparator || ',';

    const rules = profile.rules.filter(r => r && r.enabled);

    for (const rule of rules) {
        const target = rule.target || 'positive';
        const type = rule.type || 'delete';

        const isTriggered = evaluateTriggerCondition(rule.trigger, activePos, activeNeg, sep);
        if (!isTriggered) {
            continue;
        }

        const ruleTags = String(rule.tags || '').split(sep).map(x => x.trim()).filter(Boolean);
        if (ruleTags.length === 0) continue;

        // Deduplicate rule tags from itself
        const uniqueRuleTags = [];
        for (const tag of ruleTags) {
            const norm = normalizeTag(tag);
            if (!uniqueRuleTags.some(t => normalizeTag(t) === norm)) {
                uniqueRuleTags.push(tag);
            }
        }

        const processPrompt = (txt, isDelete) => {
            let tags = txt.split(sep).map(x => x.trim()).filter(Boolean);
            if (isDelete) {
                const lowerDeletes = uniqueRuleTags.map(x => normalizeTag(x));
                tags = tags.filter(tag => !lowerDeletes.includes(normalizeTag(tag)));
            } else {
                const normalizedExisting = tags.map(x => normalizeTag(x));
                const toAdd = uniqueRuleTags.filter(tag => !normalizedExisting.includes(normalizeTag(tag)));
                if (toAdd.length > 0) {
                    let insertIndex = -1;
                    const anchor = String(rule.insertAfter || '').trim();
                    if (anchor) {
                        insertIndex = tags.findIndex(tag => normalizeTag(tag) === normalizeTag(anchor));
                    } else {
                        const triggerTokens = tokenizeCondition(rule.trigger);
                        if (triggerTokens.length === 1) {
                            const possibleAnchor = triggerTokens[0];
                            insertIndex = tags.findIndex(tag => normalizeTag(tag) === normalizeTag(possibleAnchor));
                        }
                    }

                    if (insertIndex >= 0) {
                        tags.splice(insertIndex + 1, 0, ...toAdd);
                    } else {
                        tags.push(...toAdd);
                    }
                }
            }
            return tags.join(sep + ' ');
        };

        if (target === 'positive' || target === 'both') {
            activePos = processPrompt(activePos, type === 'delete');
        }
        if (target === 'negative' || target === 'both') {
            activeNeg = processPrompt(activeNeg, type === 'delete');
        }
    }

    return { prompt: activePos, negative_prompt: activeNeg };
}

function stripCandidateJsonBlocks(text) {
    return String(text || '').replace(CANDIDATE_JSON_BLOCK_REGEX, '').trimEnd();
}

function sanitizeCandidateJsonBlocksForPlanner(text) {
    return String(text || '').replace(CANDIDATE_JSON_BLOCK_REGEX, block => {
        const jsonText = block
            .replace(/^```cia-candidate-json\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
        try {
            const parsed = JSON.parse(jsonText);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return block;
            }
            delete parsed.reasoning;
            return buildCandidateJsonBlock(parsed);
        } catch {
            return block;
        }
    });
}

function buildCandidateJsonBlock(parsed) {
    return [
        `\`\`\`${CANDIDATE_JSON_BLOCK_LANG}`,
        JSON.stringify(parsed, null, 2),
        '```',
    ].join('\n');
}

function writeCandidateJsonToMessage(messageId, parsed) {
    const message = chat[messageId];
    if (!message || !parsed || typeof parsed !== 'object') {
        return;
    }

    const filtered = applyPromptRules(parsed.prompt, parsed.negative_prompt);
    parsed.prompt = filtered.prompt;
    parsed.negative_prompt = filtered.negative_prompt;

    const baseText = stripCandidateJsonBlocks(getMessageText(message));
    const block = buildCandidateJsonBlock(parsed);
    const merged = baseText ? `${baseText}\n\n${block}` : block;
    setMessageText(message, merged);
}

function findCandidateJsonBlock(messageElement) {
    const langClass = `language-${CANDIDATE_JSON_BLOCK_LANG}`;
    const code = messageElement.find(`.mes_text code.${langClass}, .mes_text code[class*="${langClass}"]`).first();
    if (code.length) {
        const pre = code.closest('pre');
        if (pre.length) {
            return pre;
        }
    }

    return messageElement.find('.mes_text pre').filter((_, element) => {
        const text = $(element).text();
        return CANDIDATE_JSON_BODY_REGEX.test(String(text || ''));
    }).first();
}

function buildContext(messageId) {
    const settings = ensureSettings();
    const start = Math.max(0, messageId - settings.contextMessages + 1);
    const entries = [];

    for (let i = start; i <= messageId; i++) {
        const message = chat[i];
        if (!message) {
            continue;
        }
        if (message.is_system && !settings.includeSystem) {
            continue;
        }

        const role = message.is_user ? 'user' : message.is_system ? 'system' : 'assistant';
        const name = settings.includeNames && message.name ? `${message.name} ` : '';
        let text = getMessageText(message).trim();
        if (settings.filterCiaJsonFromPlugin) {
            text = stripCandidateJsonBlocks(text);
        } else {
            text = sanitizeCandidateJsonBlocksForPlanner(text);
        }
        text = cleanPlannerContextText(text);
        if (!text) {
            continue;
        }
        entries.push({
            messageId: i,
            role,
            text: `#${i} ${role} ${name}`.trim() + `:\n${text}`,
        });
    }

    let currentStart = entries.map(entry => entry.role).lastIndexOf('user');
    if (currentStart < 0) {
        currentStart = Math.max(0, entries.length - 1);
    }
    let historicalText = entries.slice(0, currentStart).map(entry => entry.text).join('\n\n');
    let currentUserText = entries[currentStart]?.role === 'user' ? entries[currentStart].text : '';
    let targetAssistantText = entries.slice(currentStart + (currentUserText ? 1 : 0)).map(entry => entry.text).join('\n\n');

    const renderContext = (history, currentUser, targetAssistant) => [
        '<historical_interactions>',
        history,
        '</historical_interactions>',
        '',
        '<current_interaction>',
        '<current_user_input>',
        currentUser,
        '</current_user_input>',
        '',
        '<target_assistant_response>',
        targetAssistant,
        '</target_assistant_response>',
        '</current_interaction>',
    ].join('\n');

    let context = renderContext(historicalText, currentUserText, targetAssistantText);
    if (settings.contextChars > 0 && context.length > settings.contextChars) {
        const emptyHistoryLength = renderContext('', currentUserText, targetAssistantText).length;
        if (emptyHistoryLength <= settings.contextChars) {
            const marker = '[Historical context truncated from top]\n';
            const historyBudget = Math.max(0, settings.contextChars - emptyHistoryLength - marker.length);
            historicalText = historyBudget > 0 ? `${marker}${historicalText.slice(-historyBudget)}` : '';
        } else {
            historicalText = '';
            const emptyUserLength = renderContext('', '', targetAssistantText).length;
            if (emptyUserLength <= settings.contextChars) {
                const marker = '[Current user input truncated from top]\n';
                const userBudget = Math.max(0, settings.contextChars - emptyUserLength - marker.length);
                currentUserText = userBudget > 0 ? `${marker}${currentUserText.slice(-userBudget)}` : '';
            } else {
                const marker = '[Target assistant response truncated from top]\n';
                const emptyLength = renderContext('', '', '').length;
                const assistantBudget = Math.max(0, settings.contextChars - emptyLength - marker.length);
                currentUserText = '';
                targetAssistantText = assistantBudget > 0 ? `${marker}${targetAssistantText.slice(-assistantBudget)}` : '';
            }
        }
        context = renderContext(historicalText, currentUserText, targetAssistantText);
    }

    return context;
}

function parseRegexLiteral(pattern) {
    const text = String(pattern || '').trim();
    const literal = text.match(/^\/([\s\S]*)\/([a-z]*)$/i);
    if (literal) {
        return { source: literal[1], flags: literal[2] };
    }
    return { source: text, flags: 'gi' };
}

function compileCleanerRule(rule) {
    const parsed = parseRegexLiteral(rule?.find);
    if (!parsed.source) {
        throw new Error(t`Cleaner rule pattern cannot be empty.`);
    }
    const flags = Array.from(new Set(String(parsed.flags || 'gi').split(''))).join('');
    return new RegExp(parsed.source, flags.includes('g') ? flags : `${flags}g`);
}

function applyContextCleanerRules(text, { collectStats = false } = {}) {
    const settings = ensureSettings();
    let value = String(text || '');
    const stats = [];

    if (!settings.enableContextCleaner) {
        return collectStats ? { text: value, stats } : value;
    }

    const rules = Array.isArray(settings.contextCleanerRules) ? settings.contextCleanerRules : [];
    for (const rule of rules) {
        if (!rule?.enabled) continue;
        try {
            const regex = compileCleanerRule(rule);
            let hits = 0;
            value = value.replace(regex, (...args) => {
                hits++;
                return String(rule.replace || '').replace(/\$(\d+)/g, (_match, index) => String(args[Number(index)] || ''));
            });
            if (collectStats) {
                stats.push({
                    id: rule.id || rule.label || t`Unnamed Rule`,
                    label: rule.label || rule.id || t`Unnamed Rule`,
                    hits,
                });
            }
        } catch (error) {
            console.warn('[CIA] Invalid context cleaner rule:', rule, error);
            if (collectStats) {
                stats.push({
                    id: rule?.id || rule?.label || t`Invalid Rule`,
                    label: rule?.label || rule?.id || t`Invalid Rule`,
                    hits: 0,
                    error: String(error?.message || error),
                });
            }
        }
    }

    value = value
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return collectStats ? { text: value, stats } : value;
}

function cleanPlannerContextText(text) {
    return applyContextCleanerRules(text);
}

function buildCleanPlannerContext(messageId) {
    const settings = ensureSettings();
    const start = Math.max(0, messageId - settings.contextMessages + 1);
    const rawLines = [];
    const cleanedLines = [];
    let originalChars = 0;
    let cleanedChars = 0;
    let changedMessages = 0;
    const ruleHits = {};
    const ruleErrors = {};

    for (let i = start; i <= messageId; i++) {
        const message = chat[i];
        if (!message) continue;
        if (message.is_system && !settings.includeSystem) continue;

        const role = message.is_user ? 'user' : message.is_system ? 'system' : 'assistant';
        const name = settings.includeNames && message.name ? `${message.name} ` : '';
        const header = `#${i} ${role} ${name}`.trim();
        let rawText = getMessageText(message).trim();
        if (settings.filterCiaJsonFromPlugin) {
            rawText = stripCandidateJsonBlocks(rawText).trim();
        } else {
            rawText = sanitizeCandidateJsonBlocksForPlanner(rawText).trim();
        }
        const cleaned = applyContextCleanerRules(rawText, { collectStats: true });
        const cleanedText = cleaned.text;
        for (const stat of cleaned.stats) {
            const key = stat.id || stat.label;
            if (!ruleHits[key]) {
                ruleHits[key] = { label: stat.label || key, hits: 0 };
            }
            ruleHits[key].hits += stat.hits || 0;
            if (stat.error) {
                ruleErrors[key] = stat.error;
            }
        }
        if (!rawText && !cleanedText) continue;

        originalChars += rawText.length;
        cleanedChars += cleanedText.length;
        if (rawText !== cleanedText) changedMessages++;
        if (rawText) rawLines.push(`${header}:\n${rawText}`);
        if (cleanedText) cleanedLines.push(`${header}:\n${cleanedText}`);
    }

    let rawContext = rawLines.join('\n\n');
    let cleanedContext = cleanedLines.join('\n\n');
    const truncated = settings.contextChars > 0 && cleanedContext.length > settings.contextChars;
    if (settings.contextChars > 0 && rawContext.length > settings.contextChars) {
        rawContext = `[Context truncated from top]\n${rawContext.slice(-settings.contextChars)}`;
    }
    if (truncated) {
        cleanedContext = `[Context truncated from top]\n${cleanedContext.slice(-settings.contextChars)}`;
    }

    return {
        rawContext,
        cleanedContext,
        originalChars,
        cleanedChars,
        changedMessages,
        truncated,
        messageCount: cleanedLines.length,
        ruleHits,
        ruleErrors,
    };
}

function getComfyPlaceholderDefault(name, fallback = 0, range = null) {
    const value = extension_settings.sd?.comfy_placeholders?.find(x => x?.find === name)?.replace;
    const fallbackRange = getLoraRange();
    const min = Number.isFinite(Number(range?.min)) ? Number(range.min) : fallbackRange.min;
    const max = Number.isFinite(Number(range?.max)) ? Number(range.max) : fallbackRange.max;
    return clampNumber(value, min, max, fallback);
}

function buildUserPrompt(messageId, { imageReference = null } = {}) {
    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    const defaultsStr = numericProps.map(prop => {
        const defaultVal = getComfyPlaceholderDefault(prop.key, prop.default, prop);
        return `${prop.key}=${defaultVal}`;
    }).join(', ');

    const parts = [];
    const editReference = isImageEditReference(imageReference) ? imageReference : null;
    parts.push(
        '<image_generation_request>',
        '<conversation_context>',
        buildContext(messageId),
        '</conversation_context>',
    );
    if (editReference) {
        parts.push(
            '',
            '<edit_request>',
            '<instruction>Modify the image-generation plan according to the user requirements below. Preserve details that the user did not ask to change.</instruction>',
            buildImageReferenceBlock(editReference),
            '<user_requirements>',
            String(editReference.extraInstruction || '').trim(),
            '</user_requirements>',
            '</edit_request>',
        );
    }
    if (defaultsStr) {
        parts.push('', '<runtime_defaults>', defaultsStr, '</runtime_defaults>');
    }
    parts.push('</image_generation_request>');
    return parts.join('\n');
}

function isImageEditReference(imageReference) {
    return Boolean(
        imageReference
        && (imageReference.mode || 'adjust') === 'adjust'
        && String(imageReference.extraInstruction || '').trim()
        && String(imageReference.prompt || '').trim()
    );
}

function buildImageReferenceBlock(imageReference) {
    if (!imageReference?.prompt) {
        return '';
    }

    const lines = [
        '<previous_candidate>',
        `<prompt>${imageReference.prompt}</prompt>`,
        `<negative_prompt>${imageReference.negative_prompt || ''}</negative_prompt>`,
        '<parameters>',
    ];

    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    for (const prop of numericProps) {
        const val = imageReference[prop.key] !== undefined ? imageReference[prop.key] : prop.default;
        lines.push(`<parameter name="${prop.key}">${val}</parameter>`);
    }
    lines.push('</parameters>');

    const extraInstruction = String(imageReference.extraInstruction || '').trim();
    if (extraInstruction) {
        lines.push('<user_instruction>', extraInstruction, '</user_instruction>');
    }

    lines.push('</previous_candidate>');
    return lines.join('\n');
}

function getCurrentReferenceTarget() {
    const context = getContext();
    if (context.groupId) {
        const group = context.groups?.find(x => String(x.id) === String(context.groupId));
        return {
            key: `group:${context.groupId}`,
            label: group?.name ? t`Group: ${group.name}` : t`Group: ${context.groupId}`,
        };
    }

    const character = context.characters?.[context.characterId];
    if (context.characterId !== undefined && character) {
        const stableId = character.avatar || context.characterId;
        return {
            key: `character:${stableId}`,
            label: character.name ? t`Character: ${character.name}` : t`Character: ${stableId}`,
        };
    }

    const chatId = context.chatId || context.getCurrentChatId?.() || 'current';
    return {
        key: `chat:${chatId}`,
        label: t`Current Chat: ${chatId}`,
    };
}

function getCurrentReferenceEntry() {
    const settings = ensureSettings();
    const target = getCurrentReferenceTarget();
    return settings.characterReferences[target.key] || null;
}

function updateReferenceStatusUi() {
    const status = $('#cia_reference_status');
    if (!status.length) {
        return;
    }

    const target = getCurrentReferenceTarget();
    const entry = getCurrentReferenceEntry();
    const hasReference = Boolean(String(entry?.text || '').trim());
    const statusText = hasReference ? t`Character reference saved.` : t`No character reference saved.`;
    status.text(`${target.label}: ${statusText}`);
}

function getSavedReferenceEntries() {
    const references = ensureSettings().characterReferences;
    return Object.entries(references)
        .filter(([, entry]) => entry && typeof entry === 'object')
        .sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}


async function openSystemPromptEditor() {
    const settings = ensureSettings();

    const content = $(applyLocale(`
        <div class="cia-prompt-editor-wrapper">
            <div class="cia-ref-toolbar-row" style="margin-bottom: 4px; display: flex; justify-content: space-between; align-items: center;">
                <div class="cia-ref-selector-group" style="display: flex; align-items: center; gap: 8px;">
                    <i class="fa-solid fa-gears" style="color: var(--SmartThemeQuoteColor, #78beff); margin-right: 6px;"></i>
                    <span style="font-size: 1.05em; font-weight: 600;" data-i18n="System Instructions Configuration (System Prompt)">System Instructions Configuration (System Prompt)</span>
                </div>
            </div>

            <div class="cia-ref-status-banner" style="gap: 10px; padding: 10px 14px;">
                <i class="fa-solid fa-circle-info" style="color: var(--SmartThemeQuoteColor, #78beff); font-size: 1.1em; flex-shrink: 0;"></i>
                <div class="context-label" style="font-size: 0.88em; line-height: 1.45; opacity: 0.85;" data-i18n="This instruction block serves as the core system prompt for the prompt planner model. It defines how the model generates prompts, what format it returns, and the range of values for parameter weights.">
                    This instruction block serves as the core system prompt for the prompt planner model. It defines how the model generates prompts, what format it returns, and the range of values for parameter weights.
                </div>
            </div>

            <textarea id="cia_prompt_editor_textarea" class="cia-monospace-textarea cia-system-prompt-textarea" data-i18n="[placeholder]Please enter system prompt..." placeholder="Please enter system prompt..."></textarea>
        </div>
    `));

    content.find('#cia_prompt_editor_textarea').val(settings.legacySystemPrompt || SYSTEM_PROMPT_DEFAULT);

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        leftAlign: true,
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const edited = String(content.find('#cia_prompt_editor_textarea').val() || '').trim();
    settings.legacySystemPrompt = edited;
    settings.systemPrompt = getActiveSystemPrompt(settings);

    $('#cia_system_prompt').val(settings.systemPrompt);
    saveFromUi();
    toastr.success(t`System prompt saved successfully.`, 'Context Image Assistant');
}

async function openAdditionalImageInstructionsEditor() {
    const settings = ensureSettings();
    const initialDraft = String(settings.prependMessage || '');
    const content = $(applyLocale(`
        <div class="cia-prompt-editor-wrapper cia-additional-instructions-wrapper">
            <div class="cia-ref-toolbar-row" style="margin-bottom: 4px; display: flex; align-items: center; gap: 8px;">
                <i class="fa-solid fa-list-check" style="color: var(--SmartThemeQuoteColor, #78beff);"></i>
                <span style="font-size: 1.05em; font-weight: 600;" data-i18n="Additional Image Instructions">Additional Image Instructions</span>
            </div>
            <div class="cia-additional-profile-row">
                <label class="cia-additional-profile-selector" for="cia_additional_profile_select">
                    <span data-i18n="Instruction Configuration">Instruction Configuration</span>
                    <select id="cia_additional_profile_select" class="text_pole"></select>
                </label>
                <div class="cia-ref-toolbar">
                    <button id="cia_additional_profile_save" class="cia-icon-btn" type="button" data-i18n="[title]Save instruction configuration" title="Save instruction configuration"><i class="fa-solid fa-floppy-disk"></i></button>
                    <button id="cia_additional_profile_rename" class="cia-icon-btn" type="button" data-i18n="[title]Rename instruction configuration" title="Rename instruction configuration"><i class="fa-solid fa-pen-to-square"></i></button>
                    <button id="cia_additional_profile_new" class="cia-icon-btn" type="button" data-i18n="[title]Create instruction configuration" title="Create instruction configuration"><i class="fa-solid fa-plus"></i></button>
                    <button id="cia_additional_profile_delete" class="cia-icon-btn" type="button" data-i18n="[title]Delete instruction configuration" title="Delete instruction configuration"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
            <div class="cia-ref-status-banner" style="gap: 10px; padding: 10px 14px;">
                <i class="fa-solid fa-circle-info" style="color: var(--SmartThemeQuoteColor, #78beff); font-size: 1.1em; flex-shrink: 0;"></i>
                <div class="context-label" style="font-size: 0.88em; line-height: 1.45; opacity: 0.85;" data-i18n="Additional Image Instructions Intro">
                    These instructions are injected into the planner system prompt and take priority over its default behavior. Leave empty when no additional rules are needed.
                </div>
            </div>
            <textarea id="cia_additional_instructions_editor" class="cia-monospace-textarea cia-additional-instructions-textarea" data-i18n="[placeholder]Additional Image Instructions Placeholder" placeholder="e.g. Prefer close compositions; keep background characters indistinct."></textarea>
        </div>
    `));
    const select = content.find('#cia_additional_profile_select');
    const textarea = content.find('#cia_additional_instructions_editor');

    const getProfiles = () => settings.additionalInstructionProfiles
        .filter(profile => String(profile?.name || '').trim())
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

    const populateProfiles = (selectedName = '') => {
        const profiles = getProfiles();
        select.empty().append($('<option></option>')
            .val('')
            .text(initialDraft.trim() ? t`Current unsaved instructions` : t`No active instructions`));
        for (const profile of profiles) {
            select.append($('<option></option>').val(profile.name).text(profile.name));
        }
        const exists = profiles.some(profile => profile.name === selectedName);
        select.val(exists ? selectedName : '');
    };

    const loadSelectedProfile = () => {
        const name = String(select.val() || '');
        const profile = settings.additionalInstructionProfiles.find(item => item.name === name);
        textarea.val(profile ? profile.content : initialDraft);
        content.find('#cia_additional_profile_rename, #cia_additional_profile_delete').prop('disabled', !profile);
    };

    const createProfile = async () => {
        const name = await Popup.show.input(t`New Instruction Configuration`, t`Please enter the name of the new instruction configuration:`);
        const trimmedName = String(name || '').trim();
        if (!trimmedName) return '';
        if (settings.additionalInstructionProfiles.some(profile => profile.name === trimmedName)) {
            toastr.error(t`An instruction configuration with this name already exists.`, 'Context Image Assistant');
            return '';
        }
        settings.additionalInstructionProfiles.push({
            name: trimmedName,
            content: String(textarea.val() || '').trim(),
            updatedAt: new Date().toISOString(),
        });
        saveSettingsDebounced();
        populateProfiles(trimmedName);
        loadSelectedProfile();
        toastr.success(t`Instruction configuration created.`, 'Context Image Assistant');
        return trimmedName;
    };

    const activeName = settings.additionalInstructionProfiles.some(profile => profile.name === settings.activeAdditionalInstructionProfile)
        ? settings.activeAdditionalInstructionProfile
        : '';
    populateProfiles(activeName);
    loadSelectedProfile();

    select.on('change', loadSelectedProfile);

    content.find('#cia_additional_profile_new').on('click', createProfile);

    content.find('#cia_additional_profile_save').on('click', async () => {
        let name = String(select.val() || '');
        if (!name) {
            name = await createProfile();
            if (!name) return;
        }
        const profile = settings.additionalInstructionProfiles.find(item => item.name === name);
        if (!profile) return;
        profile.content = String(textarea.val() || '').trim();
        profile.updatedAt = new Date().toISOString();
        saveSettingsDebounced();
        populateProfiles(name);
        loadSelectedProfile();
        toastr.success(t`Instruction configuration saved.`, 'Context Image Assistant');
    });

    content.find('#cia_additional_profile_rename').on('click', async () => {
        const oldName = String(select.val() || '');
        if (!oldName) return;
        const newName = await Popup.show.input(t`Rename Instruction Configuration`, t`Please enter the new instruction configuration name:`, oldName);
        const trimmedName = String(newName || '').trim();
        if (!trimmedName || trimmedName === oldName) return;
        if (settings.additionalInstructionProfiles.some(profile => profile.name === trimmedName)) {
            toastr.error(t`An instruction configuration with this name already exists.`, 'Context Image Assistant');
            return;
        }
        const profile = settings.additionalInstructionProfiles.find(item => item.name === oldName);
        if (!profile) return;
        profile.name = trimmedName;
        profile.updatedAt = new Date().toISOString();
        if (settings.activeAdditionalInstructionProfile === oldName) {
            settings.activeAdditionalInstructionProfile = trimmedName;
        }
        saveSettingsDebounced();
        populateProfiles(trimmedName);
        loadSelectedProfile();
        toastr.success(t`Instruction configuration renamed.`, 'Context Image Assistant');
    });

    content.find('#cia_additional_profile_delete').on('click', async () => {
        const name = String(select.val() || '');
        if (!name) return;
        const confirm = await Popup.show.confirm(t`Delete Instruction Configuration`, t`Are you sure you want to permanently delete this instruction configuration?`);
        if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;
        settings.additionalInstructionProfiles = settings.additionalInstructionProfiles.filter(profile => profile.name !== name);
        if (settings.activeAdditionalInstructionProfile === name) {
            settings.activeAdditionalInstructionProfile = '';
        }
        saveSettingsDebounced();
        populateProfiles();
        loadSelectedProfile();
        toastr.info(t`Instruction configuration deleted.`, 'Context Image Assistant');
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        leftAlign: true,
    });
    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const value = String(content.find('#cia_additional_instructions_editor').val() || '').trim();
    const selectedProfileName = String(select.val() || '');
    const selectedProfile = settings.additionalInstructionProfiles.find(profile => profile.name === selectedProfileName);
    if (selectedProfile) {
        selectedProfile.content = value;
        selectedProfile.updatedAt = new Date().toISOString();
    }
    settings.activeAdditionalInstructionProfile = selectedProfile ? selectedProfileName : '';
    $('#cia_prepend_message').val(value);
    settings.prependMessage = value;
    saveFromUi();
    toastr.success(t`Additional image instructions saved.`, 'Context Image Assistant');
}

function ensureSchemaConstraints(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    let schemaValue = null;
    if (schema.value && typeof schema.value === 'object' && !Array.isArray(schema.value)) {
        schemaValue = schema.value;
    } else if (schema.schema && typeof schema.schema === 'object' && !Array.isArray(schema.schema)) {
        schemaValue = schema.schema;
    } else if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
        schemaValue = schema;
    }

    const properties = schemaValue?.properties;
    if (schemaValue && properties && typeof properties === 'object' && !Array.isArray(properties)) {
        schemaValue.type = 'object';
        schemaValue.additionalProperties = false;
        for (const key of FIXED_SCHEMA_KEYS) {
            properties[key] = JSON.parse(JSON.stringify(FIXED_SCHEMA_PROPERTIES[key]));
        }

        for (const [key, prop] of Object.entries(properties)) {
            if (FIXED_SCHEMA_KEYS.includes(key)) {
                continue;
            }
            if (prop && typeof prop === 'object' && (prop.type === 'number' || prop.type === 'integer')) {
                if (prop.minimum === undefined) {
                    prop.minimum = -1;
                }
                if (prop.maximum === undefined) {
                    prop.maximum = 1;
                }
            }
        }

        const existingRequired = Array.isArray(schemaValue.required) ? schemaValue.required : [];
        schemaValue.required = [
            ...FIXED_SCHEMA_KEYS,
            ...existingRequired.filter(key => !FIXED_SCHEMA_KEYS.includes(key) && properties[key] !== undefined),
            ...Object.keys(properties).filter(key => !FIXED_SCHEMA_KEYS.includes(key) && !existingRequired.includes(key)),
        ];
    }
    if (schema.value) {
        schema.name = String(schema.name || 'context_image_request');
        schema.strict = true;
    }
    return schema;
}

function ensureSchemaConstraintsInString(schemaStr) {
    if (!schemaStr) return schemaStr;
    try {
        const parsed = JSON.parse(schemaStr);
        const normalized = ensureSchemaConstraints(parsed);
        return JSON.stringify(normalized, null, 2);
    } catch (e) {
        return schemaStr;
    }
}

function stripSchemaConstraints(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    const cloned = JSON.parse(JSON.stringify(schema));
    let properties = null;
    if (cloned.value && typeof cloned.value === 'object' && !Array.isArray(cloned.value)) {
        properties = cloned.value.properties;
    } else if (cloned.properties && typeof cloned.properties === 'object' && !Array.isArray(cloned.properties)) {
        properties = cloned.properties;
    }

    if (properties && typeof properties === 'object') {
        for (const prop of Object.values(properties)) {
            if (prop && typeof prop === 'object') {
                delete prop.minimum;
                delete prop.maximum;
            }
        }
    }
    return cloned;
}

function validateSchemaString(rawText) {
    const raw = String(rawText || '').trim();
    if (!raw) {
        throw new Error(t`JSON Schema content cannot be empty.`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        throw new Error(t`Content is not a valid JSON format.`);
    }

    const schemaValue = parsed.value || parsed.schema || null;
    if (schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue)) {
        if (!schemaValue.properties || typeof schemaValue.properties !== 'object') {
            throw new Error(t`JSON Schema value/properties format is invalid.`);
        }
        ensureSchemaConstraints(parsed);
        return parsed;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (!parsed.properties || typeof parsed.properties !== 'object') {
            throw new Error(t`JSON Schema properties format is invalid.`);
        }
        ensureSchemaConstraints(parsed);
        return parsed;
    }

    throw new Error(t`JSON Schema outer structure must be an object.`);
}

function createLoraCardHtml(key, title, description, min, max, defaultValue, guide = '') {
    return applyLocale(`
        <div class="cia-schema-lora-card" data-key="${key}">
            <div class="cia-schema-lora-card-header">
                <div class="cia-schema-lora-key-group">
                    <span data-i18n="Parameter Key (Key)">Parameter Key (Key)</span>
                    <input type="text" class="text_pole cia-schema-lora-key" value="${key}" data-i18n="[placeholder]e.g., style_lora_strength" placeholder="e.g., style_lora_strength" />
                </div>
                <button class="cia-icon-btn cia-schema-delete-lora-btn" type="button" data-i18n="[title]Delete parameter" title="Delete parameter">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
            <div class="cia-schema-lora-card-body">
                <div class="cia-schema-lora-field-group">
                    <div class="cia-schema-field-item">
                        <span data-i18n="Display Title (Title)">Display Title (Title)</span>
                        <input type="text" class="text_pole cia-schema-lora-title" value="${title}" data-i18n="[placeholder]e.g., Style Strength" placeholder="e.g., Style Strength" />
                    </div>
                    <div class="cia-schema-field-item">
                        <span data-i18n="Description (Description)">Description (Description)</span>
                        <input type="text" class="text_pole cia-schema-lora-desc" value="${description}" data-i18n="[placeholder]e.g., Controls the rendering strength" placeholder="e.g., Controls the rendering strength" />
                    </div>
                </div>
                <div class="cia-schema-lora-numeric-group">
                    <div class="cia-schema-numeric-item">
                        <span data-i18n="Minimum (Min)">Minimum (Min)</span>
                        <input type="number" step="0.05" class="text_pole cia-schema-lora-min" value="${min}" />
                    </div>
                    <div class="cia-schema-numeric-item">
                        <span data-i18n="Maximum (Max)">Maximum (Max)</span>
                        <input type="number" step="0.05" class="text_pole cia-schema-lora-max" value="${max}" />
                    </div>
                    <div class="cia-schema-numeric-item">
                        <span data-i18n="Default (Default)">Default (Default)</span>
                        <input type="number" step="0.05" class="text_pole cia-schema-lora-default" value="${defaultValue}" />
                    </div>
                </div>
                <div class="cia-schema-field-item" style="margin-top: 8px;">
                    <span data-i18n="Usage Guide (AI Instructions)">Usage Guide (AI Instructions)</span>
                    <textarea class="text_pole cia-schema-lora-guide" rows="3" data-i18n="[placeholder]e.g., Set -1 for dark scenes, 0 for normal, describes when/how AI should pick values" placeholder="e.g., Set -1 for dark scenes, 0 for normal, describes when/how AI should pick values">${guide}</textarea>
                </div>
            </div>
        </div>
    `);
}

function serializeVisualToSchemaObj(content) {
    const properties = {};
    const required = [];

    try {
        const srcStr = String(content.find('#cia_schema_source_textarea').val() || '{}');
        const srcObj = JSON.parse(srcStr);
        const srcProps = srcObj?.value?.properties || srcObj?.properties || {};
        const srcReq = Array.isArray(srcObj?.value?.required) ? srcObj.value.required : (Array.isArray(srcObj?.required) ? srcObj.required : []);
        for (const [k, v] of Object.entries(srcProps)) {
            if (!FIXED_SCHEMA_KEYS.includes(k) && v && v.type === 'string') {
                properties[k] = v;
                if (srcReq.includes(k)) required.push(k);
            }
        }
    } catch (e) {}

    for (const key of FIXED_SCHEMA_KEYS) {
        properties[key] = JSON.parse(JSON.stringify(FIXED_SCHEMA_PROPERTIES[key]));
    }
    required.push(...FIXED_SCHEMA_KEYS);

    let valid = true;
    let errorMessage = '';

    content.find('.cia-schema-lora-card').each(function () {
        const card = $(this);
        const rawKey = String(card.find('.cia-schema-lora-key').val() || '').trim();
        if (!rawKey) {
            valid = false;
            errorMessage = t`LoRA parameter key cannot be empty.`;
            return false;
        }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(rawKey)) {
            valid = false;
            errorMessage = t`LoRA parameter key "${rawKey}" is invalid. It must start with a letter or underscore, and only contain letters, numbers, and underscores.`;
            return false;
        }
        if (FIXED_SCHEMA_KEYS.includes(rawKey)) {
            valid = false;
            errorMessage = t`LoRA parameter key cannot be the reserved keyword "${rawKey}".`;
            return false;
        }
        if (properties[rawKey]) {
            valid = false;
            errorMessage = t`LoRA parameter key "${rawKey}" is duplicated.`;
            return false;
        }

        const title = String(card.find('.cia-schema-lora-title').val() || '').trim();
        const desc = String(card.find('.cia-schema-lora-desc').val() || '').trim();
        const minVal = parseFloat(card.find('.cia-schema-lora-min').val());
        const maxVal = parseFloat(card.find('.cia-schema-lora-max').val());
        const defVal = parseFloat(card.find('.cia-schema-lora-default').val());

        const propObj = { type: 'number' };
        if (title) propObj.title = title;
        if (desc) propObj.description = desc;
        if (!isNaN(minVal)) propObj.minimum = minVal;
        if (!isNaN(maxVal)) propObj.maximum = maxVal;
        if (!isNaN(defVal)) propObj.default = defVal;

        properties[rawKey] = propObj;
        required.push(rawKey);
    });

    if (!valid) {
        throw new Error(errorMessage);
    }

    return {
        name: 'context_image_request',
        strict: true,
        value: {
            type: 'object',
            additionalProperties: false,
            properties,
            required,
        },
    };
}

function deserializeSchemaObjToVisual(schemaObj, loraListContainer, loraGuides = {}) {
    loraListContainer.empty();
    const properties = schemaObj?.value?.properties || schemaObj?.properties;
    if (!properties || typeof properties !== 'object') {
        return;
    }

    for (const [key, prop] of Object.entries(properties)) {
        if (FIXED_SCHEMA_KEYS.includes(key)) {
            continue;
        }
        if (prop && (prop.type === 'number' || prop.type === 'integer')) {
            const title = prop.title || '';
            const desc = prop.description || '';
            const min = prop.minimum !== undefined ? prop.minimum : '';
            const max = prop.maximum !== undefined ? prop.maximum : '';
            const defVal = prop.default !== undefined ? prop.default : '';
            const guide = String(loraGuides[key] || '');

            const cardHtml = createLoraCardHtml(key, title, desc, min, max, defVal, guide);
            loraListContainer.append(cardHtml);
        }
    }
}

/** Reads the usage guide text from each LoRA card in the popup. */
function extractLoraGuides(content) {
    const guides = {};
    content.find('.cia-schema-lora-card').each(function () {
        const card = $(this);
        const key = String(card.find('.cia-schema-lora-key').val() || '').trim();
        const guide = String(card.find('.cia-schema-lora-guide').val() || '').trim();
        if (key) guides[key] = guide;
    });
    return guides;
}

/** Compiles the text content to inject between <lora_config> tags from a saved profile. */
function buildLoraConfigContent(profile) {
    if (!profile) return '';
    const schemaStr = profile.customJsonSchema || '';
    if (!schemaStr) return '';

    let schemaObj;
    try { schemaObj = validateSchemaString(schemaStr); } catch (e) { return ''; }

    const properties = schemaObj?.value?.properties || schemaObj?.properties || {};
    const guides = profile.loraGuides || {};
    const extra = String(profile.loraConfigExtra || '').trim();

    const lines = [];
    const fieldLines = [];
    for (const [key, prop] of Object.entries(properties)) {
        if (FIXED_SCHEMA_KEYS.includes(key)) continue;
        if (!prop || (prop.type !== 'number' && prop.type !== 'integer')) continue;
        const title = prop.title || key;
        const min = prop.minimum !== undefined ? prop.minimum : '?';
        const max = prop.maximum !== undefined ? prop.maximum : '?';
        const defVal = prop.default !== undefined ? prop.default : 0;
        fieldLines.push(`- \`${key}\` — ${title}，范围 [\`${min}\`, \`${max}\`]，默认值 \`${defVal}\``);
        const guide = String(guides[key] || '').trim();
        if (guide) fieldLines.push(`  赋值规则: ${guide}`);
    }

    if (fieldLines.length > 0) {
        lines.push('**JSON 输出字段与赋值规则**:', ...fieldLines);
    }
    if (extra) {
        if (lines.length > 0) lines.push('');
        lines.push(extra);
    }
    return lines.join('\n');
}

function savePopupStateToProfile(profileName, schemaStr, loraGuides = {}, loraConfigExtra = '') {
    const settings = ensureSettings();
    const normalizedSchema = JSON.stringify(validateSchemaString(schemaStr), null, 2);
    const index = settings.jsonSchemaProfiles.findIndex(x => String(x?.name || '') === profileName);
    const next = {
        name: profileName,
        useCustomJsonSchema: true,
        customJsonSchema: normalizedSchema,
        loraGuides,
        loraConfigExtra,
        updatedAt: new Date().toISOString(),
    };
    if (index >= 0) {
        settings.jsonSchemaProfiles[index] = next;
    } else {
        settings.jsonSchemaProfiles.push(next);
    }
}

async function openCustomJsonSchemaEditor() {
    const settings = ensureSettings();
    const currentSchema = settings.customJsonSchema || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);

    const content = $(applyLocale(`
        <div class="cia-custom-schema-popup-wrapper">
            <!-- Profile Management Toolbar -->
            <div class="cia-ref-toolbar-row" style="margin-bottom: 4px;">
                <div class="cia-ref-selector-group">
                    <span data-i18n="Schema Profile:">Schema Profile:</span>
                    <select id="cia_schema_popup_profile_select" class="text_pole"></select>
                </div>
                <div class="cia-ref-toolbar">
                    <button id="cia_schema_popup_save_btn" class="cia-icon-btn" type="button" data-i18n="[title]Save current schema profile" title="Save current schema profile">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </button>
                    <button id="cia_schema_popup_rename_btn" class="cia-icon-btn" type="button" data-i18n="[title]Rename current schema profile" title="Rename current schema profile">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button id="cia_schema_popup_new_btn" class="cia-icon-btn" type="button" data-i18n="[title]Create new schema profile" title="Create new schema profile">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button id="cia_schema_popup_delete_btn" class="cia-icon-btn" type="button" data-i18n="[title]Delete current schema profile" title="Delete current schema profile">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </div>

            <div class="cia-schema-tabs">
                <button class="cia-schema-tab-btn active" data-tab="visual" type="button" data-i18n="Visual Editor">
                    <i class="fa-solid fa-square-poll-vertical"></i> Visual Editor
                </button>
                <button class="cia-schema-tab-btn" data-tab="source" type="button" data-i18n="JSON Source Code">
                    <i class="fa-solid fa-code"></i> JSON Source Code
                </button>
            </div>

            <div class="cia-schema-tab-content active" id="cia-schema-tab-visual">
                <div class="cia-schema-visual-container">
                    <div class="cia-schema-section-title" data-i18n="Fixed Fields (Read Only)">Fixed Fields (Read Only)</div>
                    <div class="cia-schema-fixed-fields">
                        <div class="cia-schema-fixed-card">
                            <span class="cia-schema-card-key">reasoning</span>
                            <span class="cia-schema-card-type">string</span>
                            <span class="cia-schema-card-desc" data-i18n="Complete Step 0-8 reasoning used by the prompt planner.">Complete Step 0-8 reasoning used by the prompt planner.</span>
                        </div>
                        <div class="cia-schema-fixed-card">
                            <span class="cia-schema-card-key">prompt</span>
                            <span class="cia-schema-card-type">string</span>
                            <span class="cia-schema-card-desc" data-i18n="Prompt to generate generated by AI planning.">Prompt to generate generated by AI planning.</span>
                        </div>
                        <div class="cia-schema-fixed-card">
                            <span class="cia-schema-card-key">negative_prompt</span>
                            <span class="cia-schema-card-type">string</span>
                            <span class="cia-schema-card-desc" data-i18n="Negative prompt generated by AI planning.">Negative prompt generated by AI planning.</span>
                        </div>
                    </div>

                    <div class="cia-schema-section-title" style="margin-top: 15px;">
                        <span data-i18n="Custom Parameter / LoRA Values">Custom Parameter / LoRA Values</span>
                        <button id="cia_schema_add_lora_btn" class="cia-icon-btn" type="button" data-i18n="[title]Add new LoRA parameter" title="Add new LoRA parameter">
                            <i class="fa-solid fa-plus"></i>
                        </button>
                    </div>

                    <div class="cia-schema-lora-list" id="cia_schema_lora_list"></div>

                    <div class="cia-schema-section-title" style="margin-top: 20px;">
                        <span data-i18n="Additional LoRA Config Info">附加 LoRA 配置说明</span>
                    </div>
                    <div class="cia-editor-desc" style="font-size: 0.85em; opacity: 0.7; margin-bottom: 6px;">注入到 &lt;lora_config&gt; 块的补充说明文本（如光影后缀 token 列表、全局赋值规则等），随当前配置文件保存。</div>
                    <textarea id="cia_schema_lora_config_extra" class="text_pole" style="min-height: 100px;" rows="5" data-i18n="[placeholder]e.g. Lighting suffix tokens: anee23k = night, ddyk89t = day" placeholder="例如：光影后缀 token：anee23k = 夜晚无灯，ddyk89t = 白天"></textarea>
                </div>
            </div>

            <div class="cia-schema-tab-content" id="cia-schema-tab-source">
                <div class="cia-editor-desc" style="font-size: 0.9em; opacity: 0.75; margin-bottom: 8px;" data-i18n="Edit JSON schema template constraining the output.">Edit JSON schema template constraining the output.</div>
                <textarea id="cia_schema_source_textarea" class="cia-monospace-textarea cia-schema-source-textarea"></textarea>
            </div>
        </div>
    `));

    // Function to populate profiles select
    const populateSchemaSelect = (currentName) => {
        const select = content.find('#cia_schema_popup_profile_select');
        select.empty();
        const profiles = getJsonSchemaProfileList();
        if (!profiles.length) {
            select.append($('<option></option>').val('').text(t`No profiles saved`));
            select.prop('disabled', true);
            return;
        }
        select.prop('disabled', false);
        for (const profile of profiles) {
            select.append($('<option></option>').val(profile.name).text(profile.name));
        }
        if (currentName && profiles.some(x => x.name === currentName)) {
            select.val(currentName);
        } else {
            select.val(profiles[0].name);
        }
    };

    // Function to load profile settings to editor
    const loadSelectedSchemaProfile = () => {
        const selectVal = content.find('#cia_schema_popup_profile_select').val();
        if (!selectVal) return;
        const profiles = getJsonSchemaProfileList();
        const profile = profiles.find(x => x.name === selectVal);
        if (!profile) return;

        const schemaStr = profile.customJsonSchema || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
        content.find('#cia_schema_source_textarea').val(schemaStr);
        content.find('#cia_schema_lora_config_extra').val(profile.loraConfigExtra || '');

        const activeTab = content.find('.cia-schema-tab-btn.active').attr('data-tab');
        try {
            const schemaObj = validateSchemaString(schemaStr);
            deserializeSchemaObjToVisual(schemaObj, content.find('#cia_schema_lora_list'), profile.loraGuides || {});
        } catch (e) {
            if (activeTab === 'visual') {
                content.find('.cia-schema-tab-btn[data-tab="source"]').click();
            }
        }
    };

    // Set initial text from settings
    content.find('#cia_schema_source_textarea').val(currentSchema);
    try {
        const schemaObj = validateSchemaString(currentSchema);
        deserializeSchemaObjToVisual(schemaObj, content.find('#cia_schema_lora_list'));
    } catch (e) {
        content.find('.cia-schema-tab-btn[data-tab="source"]').click();
    }

    // Try matching current schema to one of the profiles to select it by name
    const profiles = getJsonSchemaProfileList();
    const matchedProfile = profiles.find(x => x.customJsonSchema && x.customJsonSchema.trim() === currentSchema.trim());
    populateSchemaSelect(matchedProfile?.name || '');
    if (matchedProfile) {
        loadSelectedSchemaProfile();
    }

    // Dropdown change binding
    content.find('#cia_schema_popup_profile_select').on('change', () => {
        loadSelectedSchemaProfile();
    });

    // Tab buttons click bindings
    content.find('.cia-schema-tab-btn').on('click', function () {
        const btn = $(this);
        if (btn.hasClass('active')) {
            return;
        }

        const targetTab = btn.attr('data-tab');
        const currentActiveBtn = content.find('.cia-schema-tab-btn.active');
        const currentTab = currentActiveBtn.attr('data-tab');

        if (currentTab === 'visual' && targetTab === 'source') {
            try {
                const schemaObj = serializeVisualToSchemaObj(content);
                content.find('#cia_schema_source_textarea').val(JSON.stringify(schemaObj, null, 2));
            } catch (err) {
                toastr.error(err.message, 'Context Image Assistant');
                return;
            }
        } else if (currentTab === 'source' && targetTab === 'visual') {
            try {
                const selectVal = content.find('#cia_schema_popup_profile_select').val();
                const existingProfile = settings.jsonSchemaProfiles.find(x => x.name === selectVal);
                const guides = existingProfile ? (existingProfile.loraGuides || {}) : {};
                const rawText = content.find('#cia_schema_source_textarea').val();
                const schemaObj = validateSchemaString(rawText);
                deserializeSchemaObjToVisual(schemaObj, content.find('#cia_schema_lora_list'), guides);
            } catch (err) {
                toastr.error(err.message, 'Context Image Assistant');
                return;
            }
        }

        currentActiveBtn.removeClass('active');
        btn.addClass('active');

        content.find('.cia-schema-tab-content').removeClass('active');
        content.find(`#cia-schema-tab-${targetTab}`).addClass('active');
    });

    // Toolbar - Save profile click
    content.find('#cia_schema_popup_save_btn').on('click', () => {
        const selectVal = content.find('#cia_schema_popup_profile_select').val();
        const activeTab = content.find('.cia-schema-tab-btn.active').attr('data-tab');
        let schemaStr = '';

        try {
            if (activeTab === 'visual') {
                const schemaObj = serializeVisualToSchemaObj(content);
                schemaStr = JSON.stringify(schemaObj, null, 2);
            } else {
                const schemaObj = validateSchemaString(content.find('#cia_schema_source_textarea').val());
                schemaStr = JSON.stringify(schemaObj, null, 2);
                content.find('#cia_schema_source_textarea').val(schemaStr);
            }
        } catch (err) {
            toastr.error(err.message, 'Context Image Assistant');
            return;
        }

        if (!selectVal) {
            content.find('#cia_schema_popup_new_btn').click();
            return;
        }

        const existingProfile = settings.jsonSchemaProfiles.find(x => x.name === selectVal);
        const guides = activeTab === 'visual' ? extractLoraGuides(content) : (existingProfile ? existingProfile.loraGuides : {});
        const extra = String(content.find('#cia_schema_lora_config_extra').val() || '').trim();

        savePopupStateToProfile(selectVal, schemaStr, guides, extra);
        const savedProfile = settings.jsonSchemaProfiles.find(x => x.name === selectVal);
        settings.loraConfigContent = buildLoraConfigContent(savedProfile);

        // Sync to main UI so it doesn't revert on next open
        $('#cia_custom_json_schema').val(schemaStr).trigger('input');
        saveFromUi();

        toastr.success(t`Format "${selectVal}" saved.`, 'Context Image Assistant');

        populateSchemaSelect(selectVal);
        loadSelectedSchemaProfile();
    });

    // Toolbar - Rename profile click
    content.find('#cia_schema_popup_rename_btn').on('click', async () => {
        const selectVal = content.find('#cia_schema_popup_profile_select').val();
        if (!selectVal) return;

        const newName = await Popup.show.input(t`Rename Format Configuration`, t`Please enter the new name of the format configuration "${selectVal}":`, selectVal);
        if (!newName || newName.trim() === selectVal) return;

        const trimmedNewName = newName.trim();
        const profiles = getJsonSchemaProfileList();
        if (profiles.some(x => x.name === trimmedNewName)) {
            toastr.error(t`Format profile named "${trimmedNewName}" already exists.`, 'Context Image Assistant');
            return;
        }

        const index = settings.jsonSchemaProfiles.findIndex(x => String(x?.name || '') === selectVal);
        if (index >= 0) {
            settings.jsonSchemaProfiles[index].name = trimmedNewName;
            settings.jsonSchemaProfiles[index].updatedAt = new Date().toISOString();

            saveSettingsDebounced();
            populateSchemaSelect(trimmedNewName);
            loadSelectedSchemaProfile();
            toastr.success(t`Format profile renamed to "${trimmedNewName}".`, 'Context Image Assistant');
        }
    });

    // Toolbar - New profile click
    content.find('#cia_schema_popup_new_btn').on('click', async () => {
        const name = await Popup.show.input(t`New Custom Format`, t`Please enter the name of the new format configuration:`);
        if (!name) return;

        const activeTab = content.find('.cia-schema-tab-btn.active').attr('data-tab');
        let schemaStr = '';
        try {
            if (activeTab === 'visual') {
                const schemaObj = serializeVisualToSchemaObj(content);
                schemaStr = JSON.stringify(schemaObj, null, 2);
            } else {
                const schemaObj = validateSchemaString(content.find('#cia_schema_source_textarea').val());
                schemaStr = JSON.stringify(schemaObj, null, 2);
                content.find('#cia_schema_source_textarea').val(schemaStr);
            }
        } catch (e) {
            schemaStr = JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
        }

        const guides = activeTab === 'visual' ? extractLoraGuides(content) : {};
        const extra = String(content.find('#cia_schema_lora_config_extra').val() || '').trim();
        savePopupStateToProfile(name, schemaStr, guides, extra);
        saveSettingsDebounced();

        populateSchemaSelect(name);
        loadSelectedSchemaProfile();
        toastr.success(t`Format "${name}" created successfully.`, 'Context Image Assistant');
    });

    // Toolbar - Delete profile click
    content.find('#cia_schema_popup_delete_btn').on('click', async () => {
        const selectVal = content.find('#cia_schema_popup_profile_select').val();
        if (!selectVal) return;

        const confirm = await Popup.show.confirm(t`Delete format configuration`, t`Are you sure you want to permanently delete format configuration "${selectVal}"?`);
        if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;

        removeJsonSchemaProfileByName(selectVal);
        saveSettingsDebounced();

        populateSchemaSelect();
        loadSelectedSchemaProfile();
        toastr.info(t`Format "${selectVal}" deleted.`, 'Context Image Assistant');
    });

    // Add lora parameter button
    content.find('#cia_schema_add_lora_btn').on('click', () => {
        const defaultKey = `custom_lora_${Date.now() % 1000}`;
        const cardHtml = createLoraCardHtml(defaultKey, '', '', '', '', '');
        content.find('#cia_schema_lora_list').append(cardHtml);
        const container = content.find('.cia-schema-visual-container');
        container.scrollTop(container[0].scrollHeight);
    });

    // Delete lora parameter button
    content.find('#cia_schema_lora_list').on('click', '.cia-schema-delete-lora-btn', function () {
        $(this).closest('.cia-schema-lora-card').remove();
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        leftAlign: true,
        onClosing: async (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            const activeTab = content.find('.cia-schema-tab-btn.active').attr('data-tab');
            let schemaStr = '';

            try {
                if (activeTab === 'visual') {
                    const schemaObj = serializeVisualToSchemaObj(content);
                    schemaStr = JSON.stringify(schemaObj, null, 2);
                } else {
                    const schemaObj = validateSchemaString(content.find('#cia_schema_source_textarea').val());
                    schemaStr = JSON.stringify(schemaObj, null, 2);
                    content.find('#cia_schema_source_textarea').val(schemaStr);
                }

                // Sync current value to select profile
                const selectVal = content.find('#cia_schema_popup_profile_select').val();
                const existingProfile = settings.jsonSchemaProfiles.find(x => x.name === selectVal);
                const guides = activeTab === 'visual' ? extractLoraGuides(content) : (existingProfile ? existingProfile.loraGuides : {});
                const extra = String(content.find('#cia_schema_lora_config_extra').val() || '').trim();
                if (selectVal) {
                    savePopupStateToProfile(selectVal, schemaStr, guides, extra);
                    // Compile and store lora_config injection content
                    const savedProfile = settings.jsonSchemaProfiles.find(x => x.name === selectVal);
                    settings.loraConfigContent = buildLoraConfigContent(savedProfile);
                }

                $('#cia_custom_json_schema').val(schemaStr).trigger('input');
                saveFromUi();
                toastr.success(t`Custom JSON Schema saved.`, 'Context Image Assistant');
                return true;
            } catch (err) {
                toastr.error(err.message, 'Context Image Assistant');
                return false;
            }
        },
    });

    await popup.show();
}

async function openCharacterReferenceEditor() {
    const target = getCurrentReferenceTarget();
    const settings = ensureSettings();

    const content = $(applyLocale(`
        <div class="cia-character-reference-wrapper">
            <div class="cia-ref-status-banner">
                <div class="context-label"><span data-i18n="Current Context:">Current Context:</span> <strong id="cia_ref_context_name"></strong></div>
                <div class="cia-ref-status-badge" id="cia_ref_status_badge">
                    <i></i> <span id="cia_ref_badge_text"></span>
                </div>
            </div>

            <div class="cia-ref-toolbar-row">
                <div class="cia-ref-selector-group">
                    <span data-i18n="Profile:">Profile:</span>
                    <select id="cia_ref_profile_select" class="text_pole"></select>
                </div>
                <div class="cia-ref-toolbar">
                    <button id="cia_ref_save_btn" class="cia-icon-btn" type="button" data-i18n="[title]Save current character reference profile" title="Save current character reference profile">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </button>
                    <button id="cia_ref_rename_btn" class="cia-icon-btn" type="button" data-i18n="[title]Rename current character reference profile" title="Rename current character reference profile">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button id="cia_ref_new_btn" class="cia-icon-btn" type="button" data-i18n="[title]Create new character reference profile" title="Create new character reference profile">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button id="cia_ref_delete_btn" class="cia-icon-btn" type="button" data-i18n="[title]Delete current character reference profile" title="Delete current character reference profile">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                    <button id="cia_ref_link_btn" class="cia-icon-btn" type="button" data-i18n="[title]Bind active profile to current context" title="Bind active profile to current context">
                        <i class="fa-solid fa-link"></i>
                    </button>
                    <button id="cia_ref_unlink_btn" class="cia-icon-btn" type="button" data-i18n="[title]Unbind profile from current context" title="Unbind profile from current context">
                        <i class="fa-solid fa-link-slash"></i>
                    </button>
                </div>
            </div>

            <div class="cia-ref-field">
                <span data-i18n="System Prompt Template for Reference">System Prompt Template for Reference</span>
                <textarea id="cia_ref_prompt_textarea" class="text_pole cia-ref-prompt-textarea" data-i18n="[placeholder]e.g., Character reference descriptors as follows..." placeholder="e.g., Character reference descriptors as follows..."></textarea>
            </div>
            <div class="cia-ref-field">
                <span data-i18n="Character Visual Baseline Descriptors">Character Visual Baseline Descriptors</span>
                <textarea id="cia_ref_text_textarea" class="text_pole cia-ref-descriptors-textarea" data-i18n="[placeholder]Enter hairstyle, eyes, attire details here, one per line..." placeholder="Enter hairstyle, eyes, attire details here, one per line..."></textarea>
            </div>
        </div>
    `));

    content.find('#cia_ref_context_name').text(target.label);

    const updateStatusDisplay = () => {
        const currentEntry = settings.characterReferences[target.key];
        const hasText = Boolean(String(currentEntry?.text || '').trim());
        const badge = content.find('#cia_ref_status_badge');
        const badgeText = content.find('#cia_ref_badge_text');
        const badgeIcon = badge.find('i');

        if (hasText) {
            badge.removeClass('unbound').addClass('bound');
            badgeText.text(t`Character reference bound`);
            badgeIcon.removeClass().addClass('fa-solid fa-circle-check');
        } else {
            badge.removeClass('bound').addClass('unbound');
            badgeText.text(t`No character reference bound`);
            badgeIcon.removeClass().addClass('fa-solid fa-circle-minus');
        }
    };

    const populateSelect = (currentKey) => {
        const select = content.find('#cia_ref_profile_select');
        select.empty();
        const saved = getSavedReferenceEntries();

        let hasActiveTarget = false;
        for (const [key] of saved) {
            if (key === target.key) {
                hasActiveTarget = true;
                break;
            }
        }

        if (!hasActiveTarget) {
            select.append($('<option></option>')
                .val(target.key)
                .text(t`Current context: ${target.label} (Empty)`));
        }

        for (const [key, entry] of saved) {
            const prefix = key === target.key ? t`Current context: ` : '';
            select.append($('<option></option>')
                .val(key)
                .text(`${prefix}${entry.label || key}`));
        }

        if (currentKey) {
            select.val(currentKey);
        } else if (hasActiveTarget) {
            select.val(target.key);
        } else {
            select.val(select.find('option:first').val());
        }
    };

    const loadSelectedProfile = () => {
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return;
        const entry = settings.characterReferences[selectVal] || {};
        content.find('#cia_ref_prompt_textarea').val(entry.prompt || settings.referencePrompt || DEFAULT_REFERENCE_PROMPT);
        content.find('#cia_ref_text_textarea').val(entry.text || '');
    };

    updateStatusDisplay();
    populateSelect();
    loadSelectedProfile();

    content.find('#cia_ref_profile_select').on('change', () => {
        loadSelectedProfile();
    });

    const saveSelectedProfile = ({ notify = false } = {}) => {
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return false;

        const prompt = String(content.find('#cia_ref_prompt_textarea').val() || '').trim() || DEFAULT_REFERENCE_PROMPT;
        const text = String(content.find('#cia_ref_text_textarea').val() || '').trim();
        const label = settings.characterReferences[selectVal]?.label || (selectVal === target.key ? target.label : selectVal);

        settings.characterReferences[selectVal] = {
            label,
            prompt,
            text,
            updatedAt: new Date().toISOString(),
        };

        saveSettingsDebounced();
        updateStatusDisplay();
        populateSelect(selectVal);
        loadSelectedProfile();
        updateReferenceStatusUi();

        if (notify) {
            toastr.success(t`Profile "${label}" saved.`, 'Context Image Assistant');
        }

        return true;
    };

    content.find('#cia_ref_rename_btn').on('click', async () => {
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return;

        const entry = settings.characterReferences[selectVal] || {};
        const currentLabel = entry.label || (selectVal === target.key ? target.label : selectVal);

        const newName = await Popup.show.input(t`Rename Character Reference Configuration`, t`Please enter the new name of character reference configuration "${currentLabel}":`, currentLabel);
        if (!newName || newName.trim() === currentLabel) return;

        const trimmedNewName = newName.trim();
        if (!settings.characterReferences[selectVal]) {
            settings.characterReferences[selectVal] = {
                label: trimmedNewName,
                prompt: settings.referencePrompt || DEFAULT_REFERENCE_PROMPT,
                text: '',
                updatedAt: new Date().toISOString(),
            };
        } else {
            settings.characterReferences[selectVal].label = trimmedNewName;
            settings.characterReferences[selectVal].updatedAt = new Date().toISOString();
        }

        saveSettingsDebounced();
        populateSelect(selectVal);
        loadSelectedProfile();
        updateReferenceStatusUi();
        toastr.success(t`Character reference renamed to "${trimmedNewName}".`, 'Context Image Assistant');
    });

    content.find('#cia_ref_save_btn').on('click', () => {
        saveSelectedProfile({ notify: true });
    });

    content.find('#cia_ref_new_btn').on('click', async () => {
        const name = await Popup.show.input(t`New Character Reference Configuration`, t`Please enter the name of the new character reference configuration:`);
        if (!name) return;

        const newKey = `profile:${Date.now()}`;
        settings.characterReferences[newKey] = {
            label: name,
            prompt: settings.referencePrompt || DEFAULT_REFERENCE_PROMPT,
            text: '',
            updatedAt: new Date().toISOString(),
        };

        saveSettingsDebounced();
        populateSelect(newKey);
        loadSelectedProfile();
        toastr.success(t`Profile "${name}" created successfully.`, 'Context Image Assistant');
    });

    content.find('#cia_ref_delete_btn').on('click', async () => {
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return;

        const entry = settings.characterReferences[selectVal];
        const label = entry?.label || selectVal;

        const confirm = await Popup.show.confirm(t`Delete Character Reference`, t`Are you sure you want to permanently delete character reference configuration "${label}"?`);
        if (confirm !== POPUP_RESULT.AFFIRMATIVE) return;

        delete settings.characterReferences[selectVal];
        saveSettingsDebounced();
        updateStatusDisplay();
        populateSelect();
        loadSelectedProfile();
        updateReferenceStatusUi();
        toastr.info(t`Profile "${label}" deleted.`, 'Context Image Assistant');
    });

    content.find('#cia_ref_link_btn').on('click', () => {
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return;
        if (selectVal === target.key) {
            toastr.info(t`The selected profile is already active for this context.`, 'Context Image Assistant');
            return;
        }

        const prompt = String(content.find('#cia_ref_prompt_textarea').val() || '').trim() || DEFAULT_REFERENCE_PROMPT;
        const text = String(content.find('#cia_ref_text_textarea').val() || '').trim();

        if (!text) {
            toastr.warning(t`Cannot bind empty content. Please write some visual descriptors in the editor.`, 'Context Image Assistant');
            return;
        }

        settings.characterReferences[target.key] = {
            label: target.label,
            prompt,
            text,
            updatedAt: new Date().toISOString(),
        };

        saveSettingsDebounced();
        updateStatusDisplay();
        populateSelect(target.key);
        loadSelectedProfile();
        updateReferenceStatusUi();
        toastr.success(t`Successfully applied and bound to current context.`, 'Context Image Assistant');
    });

    content.find('#cia_ref_unlink_btn').on('click', () => {
        if (!settings.characterReferences[target.key]) {
            toastr.info(t`No profile is currently bound to this context.`, 'Context Image Assistant');
            return;
        }

        delete settings.characterReferences[target.key];
        saveSettingsDebounced();
        updateStatusDisplay();
        populateSelect();
        loadSelectedProfile();
        updateReferenceStatusUi();
        toastr.info(t`Unbound active profile from this context.`, 'Context Image Assistant');
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        leftAlign: true,
        onClosing: async (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            saveSelectedProfile();
            return true;
        },
    });

    await popup.show();
}

async function openPromptRulesHelp() {
    const helpContent = $(applyLocale(`
        <div class="cia-filter-help-wrapper" style="font-size: 0.92em; line-height: 1.6; max-height: 70vh; overflow-y: auto; padding: 10px 15px; color: var(--text-color); font-family: system-ui, -apple-system, sans-serif;">
            <p style="margin-top: 0; opacity: 0.85; font-size: 1.05em;" data-i18n="Prompt Rules Help Intro">You can configure prompt tag filtering and addition rules to dynamically modify generator prompts (positive and negative):</p>

            <div style="display: flex; flex-direction: column; gap: 12px; margin: 16px 0;">
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;" data-i18n="Trigger Condition Guide Title">1. Trigger Condition Boolean Syntax</div>
                    <div style="opacity: 0.9; font-size: 0.9em;">
                        <span data-i18n="Trigger Condition Guide Intro">Supports tag presence checks in the prompt using logical operators (case-insensitive):</span>
                        <ul style="margin: 6px 0 0 16px; padding: 0;">
                            <li><strong style="color: #ef4444;">${t('Logical Operator NOT')}</strong>: <span>${t("Negation. e.g. <code>!indoor</code> triggers when prompt does not contain 'indoor'.")}</span></li>
                            <li><strong style="color: #10b981;">${t('Logical Operator AND')}</strong>: <span>${t("Conjunction. e.g. <code>swimsuit AND outdoor</code> triggers when both swimsuit and outdoor are present.")}</span></li>
                            <li><strong style="color: #3b82f6;">${t('Logical Operator OR')}</strong>: <span>${t("Disjunction. e.g. <code>beach OR pool</code> triggers when either beach or pool is present.")}</span></li>
                            <li><strong>${t('Logical Operator Parentheses')}</strong>: <span>${t("Precedence control. e.g. <code>(beach OR pool) AND NOT indoor</code>.")}</span></li>
                            <li><strong>${t('Logical Operator Empty')}</strong>: <span>${t("Always active, unconditional execution.")}</span></li>
                        </ul>
                    </div>
                </div>

                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;" data-i18n="Tag Insertion Guide Title">2. Tag Insertion (Insert After)</div>
                    <div style="opacity: 0.9; font-size: 0.9em;">
                        <span data-i18n="Tag Insertion Guide Intro">When the rule type is 'Add', you can specify where to insert the new tag in the current prompt:</span>
                        <ul style="margin: 6px 0 0 16px; padding: 0;">
                            <li>${t("Enter a specific tag name (e.g. <code>swimsuit</code>), and the new tag will be inserted immediately after it.")}</li>
                            <li>${t("If empty: if trigger condition is a single tag (e.g. <code>outdoor</code>), it will automatically insert after <code>outdoor</code>; otherwise, it appends to the end.")}</li>
                            <li>${t("Duplicates are automatically checked to prevent inserting the same tag multiple times.")}</li>
                        </ul>
                    </div>
                </div>
            </div>

            <p style="margin-bottom: 0; opacity: 0.7; font-size: 0.85em; text-align: center;" data-i18n="Prompt Rules Help Outro">💡 Hint: All tag parsing rules respect your configured global Tag Separator (default is comma).</p>
        </div>
    `));

    const popup = new Popup(helpContent, POPUP_TYPE.TEXT, t`Prompt Tag Rules Guide`, {
        okButton: t`Close`,
        cancelButton: null,
    });
    await popup.show();
}

async function openPromptRulesEditor() {
    const settings = ensureSettings();

    if (Object.keys(settings.promptRuleProfiles).length === 0) {
        settings.promptRuleProfiles['profile:default'] = {
            label: t`Default Profile`,
            rules: []
        };
        settings.activePromptRuleProfile = 'profile:default';
    }
    if (!settings.activePromptRuleProfile || !settings.promptRuleProfiles[settings.activePromptRuleProfile]) {
        settings.activePromptRuleProfile = Object.keys(settings.promptRuleProfiles)[0];
    }

    const content = $(applyLocale(`
        <div class="cia-rules-wrapper">
            <div class="cia-rules-toolbar-row">
                <div class="cia-rules-profile-group">
                    <span data-i18n="Profile:">Profile:</span>
                    <select id="cia_rules_profile_select" class="text_pole"></select>
                </div>
                <div class="cia-rules-toolbar">
                    <button id="cia_rules_rename_btn" class="cia-icon-btn" type="button" data-i18n="[title]Rename current schema profile" title="Rename current schema profile">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button id="cia_rules_new_btn" class="cia-icon-btn" type="button" data-i18n="[title]Create new schema profile" title="Create new schema profile">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button id="cia_rules_delete_btn" class="cia-icon-btn" type="button" data-i18n="[title]Delete current schema profile" title="Delete current schema profile">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                    <span style="border-left: 1px solid rgba(255, 255, 255, 0.1); height: 20px; margin: 0 4px;"></span>
                    <span data-i18n="Tag Separator:" style="font-size: 0.88em; font-weight: 600; opacity: 0.85; white-space: nowrap; margin-left: 4px;">Tag Separator:</span>
                    <input type="text" id="cia_rules_separator_input" class="text_pole" maxlength="3" style="width: 40px !important; text-align: center; height: 32px !important; padding: 0 !important; margin: 0;" />
                    <button id="cia_rules_help_btn" class="cia-icon-btn" type="button" data-i18n="[title]Prompt Rules Help Tooltip" title="Rules guide">
                        <i class="fa-solid fa-circle-question"></i>
                    </button>
                </div>
            </div>

            <div class="cia-rules-list-container" id="cia_rules_list">
                <!-- Rules list items render here -->
            </div>

            <div class="cia-rule-form-container" id="cia_rule_form" style="display: none;">
                <div class="cia-rule-form-title">
                    <span id="cia_rule_form_header" data-i18n="Add New Rule">Add New Rule</span>
                </div>
                <div class="cia-rule-form-grid">
                    <div class="cia-rule-form-field">
                        <label data-i18n="Rule Type">Rule Type</label>
                        <select id="cia_rule_form_type" class="text_pole">
                            <option value="delete" data-i18n="Delete Tag">Delete Tag</option>
                            <option value="add" data-i18n="Add Tag">Add Tag</option>
                        </select>
                    </div>
                    <div class="cia-rule-form-field">
                        <label data-i18n="Target Prompt">Target Prompt</label>
                        <select id="cia_rule_form_target" class="text_pole">
                            <option value="positive" data-i18n="Positive Prompt (Positive)">Positive Prompt (Positive)</option>
                            <option value="negative" data-i18n="Negative Prompt (Negative)">Negative Prompt (Negative)</option>
                            <option value="both" data-i18n="Both Prompts">Both Prompts</option>
                        </select>
                    </div>
                    <div class="cia-rule-form-field">
                        <label data-i18n="Trigger Condition">Trigger Condition</label>
                        <input type="text" id="cia_rule_form_trigger" class="text_pole" placeholder="e.g. swimsuit AND outdoor" />
                    </div>
                    <div class="cia-rule-form-field" id="cia_rule_form_insert_after_field">
                        <label data-i18n="Insert After Tag">Insert After Tag</label>
                        <input type="text" id="cia_rule_form_insert_after" class="text_pole" placeholder="e.g. swimsuit (leave blank for auto)" />
                    </div>
                    <div class="cia-rule-form-field full-width">
                        <label data-i18n="Tags">Tags</label>
                        <textarea id="cia_rule_form_tags" class="text_pole" rows="2" placeholder="e.g. wet skin, droplets" style="resize: vertical;"></textarea>
                    </div>
                </div>
                <div class="cia-rule-form-actions">
                    <button id="cia_rule_form_cancel" class="menu_button" type="button" data-i18n="Cancel">Cancel</button>
                    <button id="cia_rule_form_save" class="menu_button" type="button" data-i18n="Save" style="background: var(--SmartThemeQuoteColor, #78beff); color: #000; font-weight: bold;">Save</button>
                </div>
            </div>

            <div class="cia-rules-add-row">
                <button id="cia_rules_add_rule_btn" class="cia-rules-add-btn" type="button">
                    <i class="fa-solid fa-circle-plus"></i> <span data-i18n="Add New Rule">Add New Rule</span>
                </button>
            </div>
        </div>
    `));

    let editingRuleId = null;

    const populateProfilesSelect = (activeKey) => {
        const select = content.find('#cia_rules_profile_select');
        select.empty();
        for (const [key, value] of Object.entries(settings.promptRuleProfiles)) {
            const option = $('<option></option>').attr('value', key).text(value.label || key);
            if (key === activeKey) {
                option.attr('selected', 'selected');
            }
            select.append(option);
        }
    };

    const renderRulesList = () => {
        const list = content.find('#cia_rules_list');
        list.empty();
        const selectVal = content.find('#cia_rules_profile_select').val();
        if (!selectVal) return;

        const profile = settings.promptRuleProfiles[selectVal];
        if (!profile || !Array.isArray(profile.rules) || profile.rules.length === 0) {
            list.append($(applyLocale(`<div class="cia-recycle-empty" data-i18n="No rules configured in this profile.">No rules configured in this profile.</div>`)));
            return;
        }

        profile.rules.forEach((rule, idx) => {
            if (!rule) return;
            const isEnabled = !!rule.enabled;
            const targetText = rule.target === 'positive' ? t('Positive') : rule.target === 'negative' ? t('Negative') : t('Both');
            const typeText = rule.type === 'delete' ? t('Delete') : t('Add');
            const triggerText = rule.trigger ? rule.trigger : t('Always Active');
            const insertAfterText = rule.insertAfter ? ` (after: ${rule.insertAfter})` : '';

            const row = $(applyLocale(`
                <div class="cia-rule-card ${isEnabled ? '' : 'disabled'}" data-id="${escapeHtmlAttr(rule.id)}">
                    <div class="cia-rule-drag-controls">
                        <button class="cia-rule-drag-btn btn-up" type="button" title="${t('Move Up')}"><i class="fa-solid fa-chevron-up"></i></button>
                        <button class="cia-rule-drag-btn btn-down" type="button" title="${t('Move Down')}"><i class="fa-solid fa-chevron-down"></i></button>
                    </div>
                    <input type="checkbox" class="cia-rule-card-checkbox" ${isEnabled ? 'checked' : ''} title="${t('Enable/Disable rule')}" />
                    <div class="cia-rule-info">
                        <div class="cia-rule-meta-row">
                            <span class="cia-rule-badge ${rule.type === 'delete' ? 'delete' : 'add'}">${typeText}</span>
                            <span class="cia-rule-target">${targetText}</span>
                            <span class="cia-rule-trigger-cond">${triggerText}</span>
                        </div>
                        <div class="cia-rule-tags-display">
                            <strong>${rule.type === 'delete' ? t('Filter:') : t('Insert:')}</strong> ${escapeHtml(rule.tags)}${insertAfterText}
                        </div>
                    </div>
                    <div class="cia-rule-actions-cell">
                        <button class="cia-icon-btn btn-edit" type="button" title="${t('Edit')}"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="cia-icon-btn btn-delete" type="button" title="${t('Delete')}" style="color: var(--red, #cf4646);"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `));

            row.find('.cia-rule-card-checkbox').on('change', function () {
                rule.enabled = $(this).prop('checked');
                row.toggleClass('disabled', !rule.enabled);
                saveSettingsDebounced();
            });

            row.find('.btn-up').on('click', () => {
                if (idx === 0) return;
                const temp = profile.rules[idx];
                profile.rules[idx] = profile.rules[idx - 1];
                profile.rules[idx - 1] = temp;
                saveSettingsDebounced();
                renderRulesList();
            });

            row.find('.btn-down').on('click', () => {
                if (idx === profile.rules.length - 1) return;
                const temp = profile.rules[idx];
                profile.rules[idx] = profile.rules[idx + 1];
                profile.rules[idx + 1] = temp;
                saveSettingsDebounced();
                renderRulesList();
            });

            row.find('.btn-edit').on('click', () => {
                openRuleForm(rule.id);
            });

            row.find('.btn-delete').on('click', async () => {
                const confirm = await Popup.show.confirm(t`Delete Rule`, t`Are you sure you want to delete this rule?`);
                if (confirm === POPUP_RESULT.AFFIRMATIVE) {
                    profile.rules.splice(idx, 1);
                    saveSettingsDebounced();
                    renderRulesList();
                    if (editingRuleId === rule.id) {
                        closeRuleForm();
                    }
                }
            });

            list.append(row);
        });
    };

    const openRuleForm = (ruleId) => {
        editingRuleId = ruleId;
        const form = content.find('#cia_rule_form');
        const header = content.find('#cia_rule_form_header');

        if (ruleId === null) {
            header.text(t('Add New Rule'));
            content.find('#cia_rule_form_type').val('delete');
            content.find('#cia_rule_form_target').val('positive');
            content.find('#cia_rule_form_trigger').val('');
            content.find('#cia_rule_form_insert_after').val('');
            content.find('#cia_rule_form_tags').val('');
            content.find('#cia_rule_form_insert_after_field').hide();
        } else {
            header.text(t('Edit Rule'));
            const selectVal = content.find('#cia_rules_profile_select').val();
            const profile = settings.promptRuleProfiles[selectVal];
            const rule = profile.rules.find(r => r.id === ruleId);
            if (rule) {
                content.find('#cia_rule_form_type').val(rule.type);
                content.find('#cia_rule_form_target').val(rule.target);
                content.find('#cia_rule_form_trigger').val(rule.trigger);
                content.find('#cia_rule_form_insert_after').val(rule.insertAfter || '');
                content.find('#cia_rule_form_tags').val(rule.tags);
                if (rule.type === 'add') {
                    content.find('#cia_rule_form_insert_after_field').show();
                } else {
                    content.find('#cia_rule_form_insert_after_field').hide();
                }
            }
        }
        form.slideDown(200);
        content.find('#cia_rules_add_rule_btn').hide();
    };

    const closeRuleForm = () => {
        editingRuleId = null;
        content.find('#cia_rule_form').slideUp(200);
        content.find('#cia_rules_add_rule_btn').show();
    };

    content.find('#cia_rule_form_type').on('change', function () {
        const type = $(this).val();
        if (type === 'add') {
            content.find('#cia_rule_form_insert_after_field').show();
        } else {
            content.find('#cia_rule_form_insert_after_field').hide();
        }
    });

    content.find('#cia_rules_separator_input').val(settings.tagSeparator || ',');
    content.find('#cia_rules_separator_input').on('input', function () {
        const val = $(this).val() || ',';
        settings.tagSeparator = val;
        saveSettingsDebounced();
    });

    populateProfilesSelect(settings.activePromptRuleProfile);
    renderRulesList();

    content.find('#cia_rules_profile_select').on('change', function () {
        const val = $(this).val();
        settings.activePromptRuleProfile = val;
        saveSettingsDebounced();
        closeRuleForm();
        renderRulesList();
    });

    content.find('#cia_rules_rename_btn').on('click', async () => {
        const selectVal = content.find('#cia_rules_profile_select').val();
        if (!selectVal) return;
        const entry = settings.promptRuleProfiles[selectVal];
        const label = entry?.label || selectVal;
        const newName = await Popup.show.input(t`Rename Profile`, t`Please enter the new name of prompt rules profile "${label}":`);
        const trimmed = String(newName || '').trim();
        if (trimmed) {
            entry.label = trimmed;
            saveSettingsDebounced();
            populateProfilesSelect(selectVal);
        }
    });

    content.find('#cia_rules_new_btn').on('click', async () => {
        const newName = await Popup.show.input(t`New Profile`, t`Please enter the name of the new prompt rules profile:`);
        const trimmed = String(newName || '').trim();
        if (trimmed) {
            const key = `profile:${Date.now()}`;
            settings.promptRuleProfiles[key] = {
                label: trimmed,
                rules: []
            };
            settings.activePromptRuleProfile = key;
            saveSettingsDebounced();
            populateProfilesSelect(key);
            closeRuleForm();
            renderRulesList();
        }
    });

    content.find('#cia_rules_delete_btn').on('click', async () => {
        const selectVal = content.find('#cia_rules_profile_select').val();
        if (!selectVal) return;
        if (Object.keys(settings.promptRuleProfiles).length <= 1) {
            toastr.warning(t`Cannot delete the only profile.`, 'Context Image Assistant');
            return;
        }
        const entry = settings.promptRuleProfiles[selectVal];
        const label = entry?.label || selectVal;
        const confirm = await Popup.show.confirm(t`Delete Profile`, t`Are you sure you want to permanently delete profile "${label}"?`);
        if (confirm === POPUP_RESULT.AFFIRMATIVE) {
            delete settings.promptRuleProfiles[selectVal];
            const nextKey = Object.keys(settings.promptRuleProfiles)[0];
            settings.activePromptRuleProfile = nextKey;
            saveSettingsDebounced();
            populateProfilesSelect(nextKey);
            closeRuleForm();
            renderRulesList();
        }
    });

    content.find('#cia_rules_add_rule_btn').on('click', () => {
        openRuleForm(null);
    });

    content.find('#cia_rule_form_cancel').on('click', () => {
        closeRuleForm();
    });

    content.find('#cia_rule_form_save').on('click', () => {
        const selectVal = content.find('#cia_rules_profile_select').val();
        if (!selectVal) return;

        const profile = settings.promptRuleProfiles[selectVal];
        const type = content.find('#cia_rule_form_type').val();
        const target = content.find('#cia_rule_form_target').val();
        const trigger = String(content.find('#cia_rule_form_trigger').val() || '').trim();
        const insertAfter = String(content.find('#cia_rule_form_insert_after').val() || '').trim();
        const tags = String(content.find('#cia_rule_form_tags').val() || '').trim();

        if (!tags) {
            toastr.warning(t`Tags cannot be empty.`, 'Context Image Assistant');
            return;
        }

        if (trigger) {
            try {
                tokenizeCondition(trigger);
            } catch (e) {
                toastr.error(t`Invalid trigger condition expression syntax.`, 'Context Image Assistant');
                return;
            }
        }

        if (editingRuleId === null) {
            const newRule = {
                id: `rule:${Date.now()}`,
                enabled: true,
                type,
                target,
                trigger,
                insertAfter: type === 'add' ? insertAfter : '',
                tags
            };
            if (!Array.isArray(profile.rules)) {
                profile.rules = [];
            }
            profile.rules.push(newRule);
            toastr.success(t`Rule added.`, 'Context Image Assistant');
        } else {
            const rule = profile.rules.find(r => r.id === editingRuleId);
            if (rule) {
                rule.type = type;
                rule.target = target;
                rule.trigger = trigger;
                rule.insertAfter = type === 'add' ? insertAfter : '';
                rule.tags = tags;
                toastr.success(t`Rule updated.`, 'Context Image Assistant');
            }
        }

        saveSettingsDebounced();
        closeRuleForm();
        renderRulesList();
    });

    content.find('#cia_rules_help_btn').on('click', () => {
        openPromptRulesHelp();
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Close`,
        cancelButton: null,
        wide: true,
        leftAlign: true,
    });
    await popup.show();
}

async function requestImageCandidate(messageId, { force = false, manual = false, imageReference = null, autoGenerate = null, expectedSnapshot = null, silentIfStale = false } = {}) {
    const settings = ensureSettings();
    const editReference = isImageEditReference(imageReference) ? imageReference : null;
    const autoAnalyzeEnabled = Boolean(settings.enabled);
    const initialTarget = resolveMessageTarget(messageId, expectedSnapshot);
    if (!initialTarget) {
        return;
    }
    messageId = initialTarget.messageId;
    const requestKey = messageId;
    const message = initialTarget.message;
    const taskSnapshot = expectedSnapshot || createMessageSnapshot(messageId);
    let shouldAutoGenerate = false;
    if (!manual && !autoAnalyzeEnabled) {
        return;
    }
    if (activeRequests.has(messageId)) {
        return;
    }
    if (!force && message.extra?.[EXTRA_KEY]?.parsed?.prompt) {
        renderMessageControls(messageId);
        return;
    }

    activeRequests.add(messageId);
    cancelRequestedPlanner.delete(messageId);
    const plannerController = new AbortController();
    plannerAbortControllers.set(messageId, plannerController);
    setMessageState(messageId, {
        status: 'pending',
        error: '',
        rawResponse: '',
    });
    runtimeState.status = t`Analyzing #${messageId}`;
    runtimeState.lastResult = editReference ? t`Reconstructing prompt JSON from image...` : t`Requesting prompt JSON from LLM...`;
    updateStatusUi();
    renderMessageControls(messageId);

    try {
        const rawResponse = await callPlannerLlm(messageId, { imageReference: editReference, signal: plannerController.signal });
        const latestTarget = resolveMessageTarget(messageId, taskSnapshot);
        if (!latestTarget) {
            setMessageState(messageId, {
                status: 'cancelled',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            if (!silentIfStale) {
                runtimeState.status = 'idle';
                runtimeState.lastResult = t`#${messageId} task skipped (floor changed or deleted)`;
            }
            return;
        }
        if (latestTarget.messageId !== messageId) {
            activeRequests.delete(messageId);
            activeRequests.add(latestTarget.messageId);
            plannerAbortControllers.delete(messageId);
            plannerAbortControllers.set(latestTarget.messageId, plannerController);
            if (cancelRequestedPlanner.delete(messageId)) {
                cancelRequestedPlanner.add(latestTarget.messageId);
            }
        }
        messageId = latestTarget.messageId;
        const parsed = normalizeCandidate(parseCandidateJson(rawResponse));
        setMessageState(messageId, {
            status: 'ready',
            error: '',
            rawResponse,
            parsed,
            sourceMediaIndex: editReference?.mediaIndex ?? null,
            updatedAt: new Date().toISOString(),
        });
        writeCandidateJsonToMessage(messageId, parsed);
        runtimeState.status = 'ready';
        runtimeState.lastResult = editReference ? t`#${messageId} rebuilt candidate from image` : t`#${messageId} candidate generated`;
        shouldAutoGenerate = autoGenerate === null ? Boolean(settings.autoGenerate) : Boolean(autoGenerate);
        toastr.success(editReference ? t`Rebuilt image candidate based on reference image.` : t`Generated image candidate, button inserted into current message.`, 'Context Image Assistant');
    } catch (error) {
        const cancelled = cancelRequestedPlanner.has(messageId) || isAbortLikeError(error);
        if (cancelled) {
            const previousParsed = Boolean(message?.extra?.[EXTRA_KEY]?.parsed?.prompt);
            setMessageState(messageId, {
                status: previousParsed ? 'ready' : 'cancelled',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            runtimeState.status = 'idle';
            runtimeState.lastResult = t`#${messageId} cancelled waiting for model reply`;
            toastr.info(t`Cancelled waiting for model reply.`, 'Context Image Assistant');
        } else {
            console.error('[context-image-assistant] LLM planning failed', error);
            setMessageState(messageId, {
                status: 'error',
                error: String(error?.message || error),
                updatedAt: new Date().toISOString(),
            });
            runtimeState.status = 'error';
            runtimeState.lastResult = `#${messageId}: ${String(error?.message || error)}`;
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    } finally {
        activeRequests.delete(requestKey);
        plannerAbortControllers.delete(requestKey);
        cancelRequestedPlanner.delete(requestKey);
        if (messageId !== requestKey) {
            activeRequests.delete(messageId);
            plannerAbortControllers.delete(messageId);
            cancelRequestedPlanner.delete(messageId);
        }
        updateStatusUi();
        renderMessageControls(messageId);
        void saveChatWhenGeneratorIdle();
    }

    if (shouldAutoGenerate) {
        const autoSnapshot = createMessageSnapshot(messageId);
        await generateImageForMessage(messageId, { expectedSnapshot: autoSnapshot, silentIfStale: true });
    }
}

function setMessageState(messageId, patch) {
    const message = chat[messageId];
    if (!message) {
        return;
    }
    message.extra ??= {};
    message.extra[EXTRA_KEY] = {
        version: 1,
        ...(message.extra[EXTRA_KEY] || {}),
        ...patch,
    };
}

function isAbortLikeError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '');
    return name === 'AbortError' || /aborted|abort|cancel/i.test(message);
}

function cancelPlannerRequest(messageId) {
    cancelRequestedPlanner.add(messageId);
    const controller = plannerAbortControllers.get(messageId);
    if (controller) {
        controller.abort();
    }
    // generateRaw() does not accept an external signal; it listens this global stop event.
    if (plannerUsesGenerateRaw()) {
        void eventSource.emit(event_types.GENERATION_STOPPED);
    }
    renderMessageControls(messageId);
}

function cancelImageGeneration(messageId) {
    cancelRequestedImage.add(messageId);
    const controller = imageAbortControllers.get(messageId);
    if (controller) {
        controller.abort();
    }
    renderMessageControls(messageId);
}

async function saveChatWhenGeneratorIdle() {
    // Avoid lock contention with ST's own save in Generate.onSuccess()
    // which can keep the send button in "generating" state longer than expected.
    for (let i = 0; i < 120; i++) {
        if (!isGenerating()) {
            break;
        }
        await delay(100);
    }
    // Safety guard: never let extension-side save run when chat looks empty/corrupted.
    const hasContent = Array.isArray(chat) && chat.some(message => {
        if (!message) {
            return false;
        }
        const text = String(getMessageText(message) || '').trim();
        const hasText = text.length > 0;
        const hasMedia = Array.isArray(message?.extra?.media) && message.extra.media.length > 0;
        return hasText || hasMedia;
    });
    if (!hasContent) {
        console.warn('[context-image-assistant] skip saveChatConditional: chat content appears empty');
        return;
    }
    await saveChatConditional();
}

async function callPlannerLlm(messageId, { imageReference = null, signal = null } = {}) {
    const settings = ensureSettings();
    const userPrompt = buildUserPrompt(messageId, { imageReference });
    // buildUserPrompt() reads normalized settings, so assemble dynamic system interfaces afterwards.
    const systemPrompt = getPlannerSystemPrompt(settings);

    if (settings.providerMode === 'custom_proxy') {
        return callCustomProxyLlm(settings, systemPrompt, userPrompt, signal);
    }

    if (!settings.useStPromptPreset && main_api === 'openai') {
        return callCurrentOpenAiLlm(settings, systemPrompt, userPrompt, signal);
    }

    return generateRaw({
        prompt: userPrompt,
        systemPrompt,
        responseLength: settings.responseTokens,
        trimNames: false,
        jsonSchema: stripSchemaConstraints(getEffectiveJsonSchema(settings)),
    });
}

async function callCurrentOpenAiLlm(settings, systemPrompt, userPrompt, signal = null) {
    const jsonSchema = stripSchemaConstraints(getEffectiveJsonSchema(settings));
    const data = await sendOpenAIRequest(
        'quiet',
        [
            { role: 'system', content: substituteParams(systemPrompt) },
            { role: 'user', content: substituteParams(userPrompt) },
        ],
        signal || new AbortController().signal,
        { jsonSchema },
    );

    const text = typeof data === 'string' ? data : extractMessageFromData(data, 'openai');
    if (!text) {
        throw new Error(t`ST current Chat Completion returned no text.`);
    }
    return text;
}

async function callCustomProxyLlm(settings, systemPrompt, userPrompt, signal = null) {
    if (!settings.customUrl) {
        throw new Error(t`Please fill in the custom endpoint URL first.`);
    }
    if (!settings.customModel) {
        throw new Error(t`Please fill in the custom LLM model name first.`);
    }

    const jsonSchema = stripSchemaConstraints(getEffectiveJsonSchema(settings));
    return callCustomChatCompletion({
        messages: [
            { role: 'system', content: substituteParams(systemPrompt) },
            { role: 'user', content: substituteParams(userPrompt) },
        ],
        model: settings.customModel,
        temperature: settings.customTemperature,
        maxTokens: settings.responseTokens,
        customUrl: normalizeCustomUrl(settings.customUrl),
        customIncludeBody: '',
        customExcludeBody: '',
        customIncludeHeaders: buildCustomApiKeyHeaders(settings.customApiKey),
        jsonSchema,
        signal,
    });
}

async function callCustomChatCompletion({ messages, model, temperature, maxTokens, customUrl, customIncludeBody, customExcludeBody, customIncludeHeaders, jsonSchema, signal = null }) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: signal || undefined,
        body: JSON.stringify({
            type: 'quiet',
            messages,
            model,
            temperature,
            frequency_penalty: 0,
            presence_penalty: 0,
            top_p: 1,
            max_tokens: maxTokens,
            stream: false,
            chat_completion_source: 'custom',
            custom_url: normalizeCustomUrl(customUrl),
            custom_include_body: customIncludeBody || '',
            custom_exclude_body: customExcludeBody || '',
            custom_include_headers: customIncludeHeaders || '',
            json_schema: jsonSchema || undefined,
        }),
    });

    if (!response.ok) {
        throw new Error(await response.text());
    }

    const data = await response.json();
    if (data?.error) {
        throw new Error(data.error.message || t`Custom LLM returned an error.`);
    }

    const text = extractMessageFromData(data, 'openai');
    if (!text) {
        throw new Error(t`Custom LLM returned no text.`);
    }
    return text;
}

function getEffectiveJsonSchema(settings) {
    if (!settings.useJsonSchema) {
        return null;
    }
    if (!settings.useCustomJsonSchema) {
        return IMAGE_JSON_SCHEMA;
    }

    const raw = String(settings.customJsonSchema || '').trim();
    if (!raw) {
        throw new Error(t`Custom JSON Schema is enabled but empty.`);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(t`Custom JSON Schema is not valid JSON.`);
    }

    const schemaValue = parsed.value || parsed.schema || null;
    if (schemaValue && typeof schemaValue === 'object' && !Array.isArray(schemaValue)) {
        return {
            name: String(parsed.name || 'context_image_request'),
            strict: parsed.strict !== undefined ? Boolean(parsed.strict) : true,
            value: schemaValue,
        };
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return {
            name: 'context_image_request',
            strict: true,
            value: parsed,
        };
    }

    throw new Error(t`Custom JSON Schema format is invalid.`);
}

function getNumericSchemaProperties(settings) {
    let schema = null;
    try {
        schema = getEffectiveJsonSchema(settings);
    } catch (e) {
        // ignore parsing error if custom json schema is temporarily invalid
    }
    if (!schema) {
        schema = IMAGE_JSON_SCHEMA;
    }

    const properties = schema?.value?.properties;
    if (!properties || typeof properties !== 'object') {
        return [];
    }

    const list = [];
    const { min: globalMin, max: globalMax } = getLoraRange();

    for (const [key, prop] of Object.entries(properties)) {
        if (prop && prop.type === 'number') {
            const min = prop.minimum !== undefined ? Number(prop.minimum) : globalMin;
            const max = prop.maximum !== undefined ? Number(prop.maximum) : globalMax;
            const fallback = prop.default !== undefined ? Number(prop.default) : 0;
            list.push({
                key,
                title: prop.title || key,
                description: prop.description || '',
                min,
                max,
                default: fallback,
            });
        }
    }
    return list;
}

function buildCustomApiKeyHeaders(apiKey) {
    apiKey = String(apiKey || '').trim();
    if (!apiKey) {
        return '';
    }

    return `Authorization: Bearer ${apiKey}`;
}

function normalizeCustomUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/chat\/completions\/?$/i, '')
        .replace(/\/$/, '');
}

function repairJsonStringEncoding(text) {
    const source = String(text || '');
    let result = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < source.length; i++) {
        const char = source[i];
        if (!inString) {
            result += char;
            if (char === '"') inString = true;
            continue;
        }

        if (escaped) {
            if ('"\\/bfnrt'.includes(char)) {
                result += `\\${char}`;
            } else if (char === 'u' && /^[0-9a-fA-F]{4}$/.test(source.slice(i + 1, i + 5))) {
                result += `\\u${source.slice(i + 1, i + 5)}`;
                i += 4;
            } else {
                // Preserve an invalid JSON escape as a literal backslash plus its following character.
                result += `\\\\${char}`;
            }
            escaped = false;
            continue;
        }

        if (char === '\\') {
            escaped = true;
        } else if (char === '"') {
            inString = false;
            result += char;
        } else if (char === '\n') {
            result += '\\n';
        } else if (char === '\r') {
            result += '\\r';
        } else if (char === '\t') {
            result += '\\t';
        } else if (char.charCodeAt(0) < 0x20) {
            result += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
            result += char;
        }
    }

    if (escaped) {
        result += '\\\\';
    }
    return result;
}

function extractLooseJsonStringField(text, fieldName) {
    const source = String(text || '');
    const escapedName = String(fieldName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fieldRegex = new RegExp(`(?:^|[,{]\\s*|[\\r\\n]\\s*)["']${escapedName}["']\\s*:\\s*"`, 'gi');
    const matches = [...source.matchAll(fieldRegex)];
    for (let matchIndex = matches.length - 1; matchIndex >= 0; matchIndex--) {
        const match = matches[matchIndex];
        let value = '';
        let escaped = false;
        for (let i = match.index + match[0].length; i < source.length; i++) {
            const char = source[i];
            if (escaped) {
                value += `\\${char}`;
                escaped = false;
                continue;
            }
            if (char === '\\') {
                escaped = true;
                continue;
            }
            if (char === '"') {
                const remainder = source.slice(i + 1);
                if (/^\s*(?:,|})/.test(remainder)) {
                    try {
                        return JSON.parse(repairJsonStringEncoding(`"${value}"`));
                    } catch {
                        return value;
                    }
                }
                value += '\\"';
                continue;
            }
            value += char;
        }
    }
    return '';
}

function extractLooseCandidateFields(text) {
    const prompt = extractLooseJsonStringField(text, 'prompt')
        || extractLooseJsonStringField(text, 'positive_prompt')
        || extractLooseJsonStringField(text, 'image_prompt');
    if (!String(prompt || '').trim()) return null;

    const candidate = {
        prompt,
        negative_prompt: extractLooseJsonStringField(text, 'negative_prompt')
            || extractLooseJsonStringField(text, 'negative'),
    };
    const reasoning = extractLooseJsonStringField(text, 'reasoning');
    if (reasoning) candidate.reasoning = reasoning;

    const settings = ensureSettings();
    for (const prop of getNumericSchemaProperties(settings)) {
        const escapedKey = String(prop.key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matches = [...String(text || '').matchAll(new RegExp(`(?:^|[,{]\\s*|[\\r\\n]\\s*)["']${escapedKey}["']\\s*:\\s*(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?)`, 'g'))];
        const match = matches.at(-1);
        if (match) candidate[prop.key] = Number(match[1]);
    }
    return candidate;
}

function parseCandidateJson(text) {
    if (typeof text !== 'string') {
        const unwrapped = unwrapCandidateResponse(text);
        if (typeof unwrapped === 'string') {
            return parseCandidateJson(unwrapped);
        }
        return unwrapped;
    }

    const trimmed = text.trim();
    if (!trimmed) {
        throw new Error(t`LLM returned empty content.`);
    }

    const loggedContent = extractLoggedContentString(trimmed);
    const sources = [loggedContent, trimmed, text].filter(Boolean);
    const attempts = [];

    for (const source of sources) {
        // Clean up common LLM prefixes/notes
        const cleaned = source
            .replace(/^(?:json|JSON|result|output)[:\s]*/i, '')
            .trim();

        attempts.push(
            ...extractJsonCodeBlocks(source),
            stripMarkdownJsonFence(source),
            ...extractPromptJsonObjects(source),
            extractFirstJsonObject(source),
            ...extractJsonCodeBlocks(cleaned),
            extractFirstJsonObject(cleaned),
            cleaned,
            source,
        );
    }

    // De-duplicate and filter empty attempts
    const uniqueAttempts = [...new Set(attempts.filter(Boolean))];

    for (const attempt of uniqueAttempts) {
        const encodingRepaired = repairJsonStringEncoding(attempt);
        const variants = [...new Set([attempt, encodingRepaired])];
        for (const variant of variants) {
            try {
                return unwrapCandidateResponse(JSON.parse(variant));
            } catch {
                // Keep trying
            }

            try {
                const fixed = repairJsonStringEncoding(variant
                    .replace(/,\s*([}\]])/g, '$1') // Trailing commas
                    .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":') // Unquoted or single-quoted keys
                    .replace(/:\s*'((?:\\.|[^'])*?)'/g, ':"$1"')); // Single-quoted values
                return unwrapCandidateResponse(JSON.parse(fixed));
            } catch {
                // Keep trying
            }
        }
    }

    for (const source of sources) {
        const looseCandidate = extractLooseCandidateFields(source);
        if (looseCandidate) return looseCandidate;
    }

    throw new Error(t`LLM response is not valid JSON. Attempted multiple extraction strategies but all failed.`);
}

function extractLoggedContentString(text) {
    // Handle typical console log formats like "content: '...'" or "content: \"...\""
    const contentMatch = /content\s*:\s*/i.exec(text);
    if (!contentMatch) {
        return '';
    }

    const start = contentMatch.index + contentMatch[0].length;
    const endCandidates = [
        text.indexOf('\n        reasoning_content:', start),
        text.indexOf('\n        reasoning:', start),
        text.indexOf('\n        thinking:', start),
        text.indexOf('\n        role:', start),
        text.indexOf('\n        tool_calls:', start),
        text.indexOf('\n      }', start),
        text.indexOf('}', start) + 1, // Basic boundary
    ].filter(index => index > start);

    const end = endCandidates.length ? Math.min(...endCandidates) : text.length;
    const segment = text.slice(start, end);

    // Support concatenated strings like 'part 1' + 'part 2'
    const parts = [];
    const quotedStringRegex = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
    let match;
    while ((match = quotedStringRegex.exec(segment))) {
        parts.push(decodeLoggedStringLiteral(match[2]));
    }

    return parts.length ? parts.join('').trim() : segment.trim();
}

function decodeLoggedStringLiteral(value) {
    try {
        // First try to parse it as a JSON string to handle proper escapes
        return JSON.parse(`"${value.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
    } catch {
        // Fallback for messy terminal outputs
        return value
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(/\\'/g, '\'')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');
    }
}

function extractJsonCodeBlocks(text) {
    const blocks = [];
    const regex = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(String(text || '')))) {
        blocks.push(match[1].trim());
    }
    return blocks;
}

function stripMarkdownJsonFence(text) {
    const match = String(text || '').trim().match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/i);
    return match?.[1]?.trim() || '';
}

function unwrapCandidateResponse(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }

    const content = value.choices?.[0]?.message?.content
        ?? value.choices?.[0]?.text
        ?? value.content
        ?? value.message?.content
        ?? value.response
        ?? value.result
        ?? value.text;

    if (Array.isArray(content)) {
        const text = content.map(x => typeof x === 'string' ? x : x?.text || x?.content || '').filter(Boolean).join('\n');
        if (text.trim()) {
            // Don't recurse infinitely but try one more level if it's clearly a nested string
            try {
                return JSON.parse(text);
            } catch {
                return text;
            }
        }
    } else if (typeof content === 'string' && content.trim()) {
        // If it looks like a JSON string inside the message, keep it as string for the next parse logic
        return content;
    }

    return value;
}

function extractPromptJsonObjects(text) {
    const objects = [];
    const regex = /["'](?:prompt|positive_prompt|image_prompt)["']\s*:/g;
    let match;
    while ((match = regex.exec(text))) {
        const start = text.lastIndexOf('{', match.index);
        const object = extractBalancedJsonObject(text, start);
        if (object) {
            objects.push(object);
        }
    }
    return objects;
}

function extractFirstJsonObject(text) {
    return extractBalancedJsonObject(text, text.indexOf('{'));
}

function extractBalancedJsonObject(text, start) {
    if (start === -1) {
        return '';
    }

    let depth = 0;
    let quote = '';
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quote) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === quote) {
                quote = '';
            }
            continue;
        }

        if (char === '"' || char === '\'') {
            quote = char;
        } else if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return '';
}

function normalizeCandidate(value) {
    value = coerceCandidateValue(value);
    if (Array.isArray(value)) {
        value = value[0];
    }
    if (!value || typeof value !== 'object') {
        throw new Error(t`JSON root must be an object.`);
    }

    const strengths = getCandidateStrengthSource(value);
    const prompt = String(value.prompt || value.positive_prompt || value.image_prompt || '').trim();
    if (!prompt) {
        throw new Error(t`JSON is missing prompt.`);
    }
    assertCandidatePromptIsNotEmpty(prompt);

    const normalized = {
        prompt,
        negative_prompt: String(value.negative_prompt || value.negative || '').trim(),
    };

    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);

    for (const prop of numericProps) {
        const key = prop.key;
        const rawValue = strengths[key] !== undefined ? strengths[key] : value[key];
        if (rawValue !== undefined) {
            normalized[key] = clampNumber(rawValue, prop.min, prop.max, getComfyPlaceholderDefault(key, prop.default, prop));
        } else {
            normalized[key] = getComfyPlaceholderDefault(key, prop.default, prop);
        }
    }

    const reservedKeys = new Set([
        'prompt',
        'positive_prompt',
        'image_prompt',
        'negative_prompt',
        'negative',
        'strengths',
        'lora_strengths',
        'lora',
    ]);
    for (const prop of numericProps) {
        reservedKeys.add(prop.key);
    }

    // Keep additional primitive key/value pairs so placeholder replacement
    // can map dynamically to custom workflow placeholders.
    const mergeExtras = (source) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) {
            return;
        }
        for (const [key, rawValue] of Object.entries(source)) {
            if (!key || reservedKeys.has(key)) {
                continue;
            }
            const valueType = typeof rawValue;
            if (rawValue === null || valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
                normalized[key] = rawValue;
            }
        }
    };

    mergeExtras(value);
    if (strengths !== value) {
        mergeExtras(strengths);
    }

    return normalized;
}

function coerceCandidateValue(value, depth = 0) {
    if (depth > 5 || !value || typeof value !== 'object') {
        return value;
    }

    if (Array.isArray(value)) {
        return value.length ? coerceCandidateValue(value[0], depth + 1) : value;
    }

    if (value.prompt || value.positive_prompt || value.image_prompt) {
        return value;
    }

    const unwrapped = unwrapCandidateResponse(value);
    if (unwrapped !== value) {
        return coerceCandidateValue(unwrapped, depth + 1);
    }

    const queue = [value];
    const seen = new Set();
    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object' || seen.has(current)) {
            continue;
        }
        seen.add(current);
        if (current.prompt || current.positive_prompt || current.image_prompt) {
            return current;
        }
        for (const child of Object.values(current)) {
            if (typeof child === 'string' && /["'](?:prompt|positive_prompt|image_prompt)["']\s*:/.test(child)) {
                try {
                    return coerceCandidateValue(parseCandidateJson(child), depth + 1);
                } catch {
                    // keep searching
                }
            } else if (child && typeof child === 'object') {
                queue.push(child);
            }
        }
    }

    return value;
}

function getMeaningfulPromptLength(prompt) {
    return String(prompt || '')
        .replace(/[\s"'`*_~()[\]{}<>|\\/,，.。;；:：!！?？-]/g, '')
        .length;
}

function assertCandidatePromptIsNotEmpty(prompt) {
    const minLength = clampInteger(ensureSettings().minPromptChars, 0, 1000, DEFAULT_SETTINGS.minPromptChars);
    if (minLength <= 0) {
        return;
    }

    const length = getMeaningfulPromptLength(prompt);
    if (length < minLength) {
        throw new Error(t`LLM returned prompt is too short (${length}/${minLength}), skipping generation.`);
    }
}

function renderAllMessageControls() {
    for (let i = 0; i < chat.length; i++) {
        renderMessageControls(i);
    }
}

function renderMessageControls(messageId) {
    const message = chat[messageId];
    const data = message?.extra?.[EXTRA_KEY];
    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement.length) {
        return;
    }
    updateMessageVisualClass(messageId, messageElement);

    let row = messageElement.find(`.cia-message-controls[data-cia-message-id="${messageId}"]`);
    if (row.length > 1) {
        row.slice(1).remove();
        row = row.first();
    }

    if (!data) {
        row.remove();
        return;
    }

    const jsonBlock = findCandidateJsonBlock(messageElement);

    if (!row.length) {
        row = $(`<div class="cia-message-controls" data-cia-message-id="${messageId}"></div>`);
    }

    if (jsonBlock.length) {
        jsonBlock.replaceWith(row);
    }

    const mediaWrapper = messageElement.find('.mes_media_wrapper, .mes_img_container').first();
    if (mediaWrapper.length) {
        mediaWrapper.before(row);
    } else if (!row.parent().length) {
        messageElement.find('.mes_block').append(row);
    }

    // Fallback: hide raw fenced block text if markdown render has not transformed it yet.
    const mesText = messageElement.find('.mes_text');
    if (mesText.length) {
        const rawHtml = String(mesText.html() || '');
        const strippedHtml = rawHtml.replace(CANDIDATE_JSON_BLOCK_REGEX, '').trim();
        if (strippedHtml !== rawHtml) {
            mesText.html(strippedHtml);
        }
    }

    const isBusy = activeRequests.has(messageId) || activeGenerations.has(messageId);
    const canGenerate = Boolean(data.parsed?.prompt) && data.status !== 'error' && !isBusy;
    const statusText = getMessageStatusText(data, messageId);
    const rebuildMediaIndex = getCurrentRebuildableMediaIndex(message);

    row.empty();

    let dotClass = 'idle';
    if (activeRequests.has(messageId) || activeGenerations.has(messageId)) {
        dotClass = 'busy';
    } else if (data.status === 'error') {
        dotClass = 'error';
    } else if (data.status === 'done') {
        dotClass = 'done';
    } else if (data.status === 'ready') {
        dotClass = 'ready';
    }

    const statusWrapper = $('<div class="cia-status-badge-wrapper"></div>');
    statusWrapper.append($(`<span class="cia-status-dot ${dotClass}"></span>`));
    statusWrapper.append($('<span class="cia-status-label"></span>').text(statusText));
    row.append(statusWrapper);

    const btnGenerate = $('<button type="button" class="cia-msg-btn cia-generate-image"></button>')
        .attr('data-message-id', messageId)
        .prop('disabled', !canGenerate)
        .attr('title', data.imageGeneratedAt ? t`Regenerate Image` : t`Call ComfyUI to Generate Image`)
        .html(`<i class="fa-solid fa-wand-magic-sparkles"></i> ${data.imageGeneratedAt ? t`Regen` : t`Draw`}`);
    row.append(btnGenerate);

    const btnEdit = $('<button type="button" class="cia-msg-btn cia-edit-prompt"></button>')
        .attr('data-message-id', messageId)
        .attr('title', t`View or edit the prompt planning JSON for the current message floor`)
        .html(`<i class="fa-solid fa-keyboard"></i> ${t`Prompt`}`);
    row.append(btnEdit);

    if (activeRequests.has(messageId)) {
        row.append($('<button type="button" class="cia-msg-btn cia-btn-danger cia-cancel-planner"></button>')
            .attr('data-message-id', messageId)
            .attr('title', t`Cancel waiting for LLM planner to generate candidate prompt`)
            .html(`<i class="fa-solid fa-ban"></i> ${t`Cancel`}`));
    }

    if (activeGenerations.has(messageId)) {
        row.append($('<button type="button" class="cia-msg-btn cia-btn-danger cia-cancel-image"></button>')
            .attr('data-message-id', messageId)
            .attr('title', t`Cancel the current ComfyUI image generation task`)
            .html(`<i class="fa-solid fa-ban"></i> ${t`Cancel`}`));
    }

    if (data.status === 'error') {
        row.append($('<button type="button" class="cia-msg-btn cia-retry-candidate"></button>')
            .attr('data-message-id', messageId)
            .prop('disabled', isBusy)
            .attr('title', t`Retry prompt planning for this message`)
            .html(`<i class="fa-solid fa-arrows-rotate"></i> ${t`Retry`}`));
    }

    if (rebuildMediaIndex !== null) {
        row.append($('<button type="button" class="cia-msg-btn cia-rebuild-from-image"></button>')
            .attr('data-message-id', messageId)
            .attr('data-media-index', rebuildMediaIndex)
            .prop('disabled', isBusy)
            .attr('title', t`Ask LLM to replan prompt based on the current generated image`)
            .html(`<i class="fa-solid fa-rotate"></i> ${t`Replan`}`));
    }
}

function getCurrentRebuildableMediaIndex(message) {
    const media = Array.isArray(message.extra?.media) ? message.extra.media : [];
    if (!media.length) {
        return null;
    }

    const index = Number.isInteger(message.extra?.media_index) ? message.extra.media_index : 0;
    if (isRebuildableImageAttachment(media[index])) {
        return index;
    }

    const fallbackIndex = media.findIndex(isRebuildableImageAttachment);
    return fallbackIndex >= 0 ? fallbackIndex : null;
}

function isRebuildableImageAttachment(attachment) {
    return attachment?.type === MEDIA_TYPE.IMAGE && attachment?.generation_type === MODULE_NAME;
}

function updateMessageVisualClass(messageId, messageElement = null) {
    const message = chat[messageId];
    const element = messageElement?.length ? messageElement : $(`#chat .mes[mesid="${messageId}"]`);
    if (!element.length) {
        return;
    }

    const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
    const hasCiaMedia = media.some(isRebuildableImageAttachment);
    const mediaIndex = Number.isInteger(message?.extra?.media_index) ? message.extra.media_index : 0;
    const selectedMedia = media[mediaIndex] ?? media[0] ?? null;
    const hasSelectedCiaMedia = isRebuildableImageAttachment(selectedMedia);

    element.toggleClass('cia-has-media', hasCiaMedia);
    element.toggleClass('cia-selected-media', hasSelectedCiaMedia);
}

function getMessageStatusText(data, messageId) {
    if (activeRequests.has(messageId)) {
        return t`Generating candidate...`;
    }
    if (activeGenerations.has(messageId)) {
        return t`Generating image...`;
    }
    if (data.status === 'error') {
        return t`Error: ${data.error || 'Unknown error'}`;
    }
    if (data.status === 'done') {
        return t`Image generated`;
    }
    if (data.status === 'ready') {
        return t`Candidate ready`;
    }
    return data.status || '';
}

async function editCandidate(messageId) {
    const message = chat[messageId];
    const data = message?.extra?.[EXTRA_KEY];
    if (!data) {
        return;
    }

    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    const isBusy = activeRequests.has(messageId) || activeGenerations.has(messageId);
    const parsedData = data.parsed || parseCandidateJson(data.rawResponse || '{}');
    const displayData = { ...parsedData };
    delete displayData.reasoning;
    const value = JSON.stringify(displayData, null, 2);

    let loraSlidersHtml = '';
    for (const prop of numericProps) {
        const rawVal = getCandidateStrength(parsedData, prop.key, prop.default);
        const valSlider = clampNumber(rawVal, prop.min, prop.max, prop.default);
        const valInput = (rawVal !== undefined && !isNaN(Number(rawVal))) ? Number(rawVal) : prop.default;
        loraSlidersHtml += `
            <!-- ${escapeHtml(prop.key)} slider -->
            <div style="display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px;">
                <div style="display: flex; justify-content: space-between; font-size: 0.78em; opacity: 0.8;">
                    <span>${escapeHtml(prop.title)} ${prop.description ? `(${escapeHtml(prop.description)})` : ''}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 10px;">
                    <input type="range" class="cia-dynamic-slider" data-key="${escapeHtmlAttr(prop.key)}" min="${prop.min}" max="${prop.max}" step="0.05" style="flex-grow: 1; height: 4px; border-radius: 2px; outline: none; margin: 0;" value="${valSlider}" ${isBusy ? 'disabled' : ''}>
                    <input type="number" class="cia-dynamic-input text_pole" data-key="${escapeHtmlAttr(prop.key)}" step="0.05" style="width: 65px; height: 24px; padding: 2px 4px; font-size: 0.8em; margin: 0; text-align: center; background: rgba(0,0,0,0.25);" value="${valInput}" ${isBusy ? 'disabled' : ''}>
                </div>
            </div>
        `;
    }

    const popupContent = $(applyLocale(`
        <div class="cia-prompt-popup-container" style="display: flex; flex-direction: column; gap: 12px; width: 100%; height: 72vh; max-width: 100% !important;">
            <div class="cia-prompt-alert" style="padding: 8px 12px; border-radius: 6px; font-size: 0.85em; display: flex; align-items: center; gap: 8px;
                background: ${isBusy ? 'rgba(250, 173, 20, 0.12)' : 'rgba(120, 190, 255, 0.1)'};
                border: 1px solid ${isBusy ? 'rgba(250, 173, 20, 0.3)' : 'rgba(120, 190, 255, 0.2)'};
                color: ${isBusy ? '#faad14' : '#a5d3ff'};">
                <i class="${isBusy ? 'fa-solid fa-lock' : 'fa-solid fa-pen-to-square'}"></i>
                <span data-i18n="${isBusy ? 'Current generation or analysis active, prompt locked in read-only mode. You may still copy parameters.' : 'Tip: You can edit JSON parameters on the left or use the sliders on the right. Both sides sync automatically in real-time.'}"></span>
            </div>

            <div class="cia-prompt-main-layout" style="display: flex; gap: 16px; flex-grow: 1; height: 0; align-items: stretch;">
                <!-- Left: Full JSON Text Editor/Viewer -->
                <div style="flex: 1 1 50%; display: flex; flex-direction: column; gap: 6px; height: 100%;">
                    <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="JSON Source Configuration">JSON Source Configuration</span>
                        <button class="menu_button btn-copy-json" type="button" data-i18n="[title]Copy full JSON" title="Copy full JSON" style="margin: 0; padding: 2px 8px; font-size: 0.8em; height: auto; width: auto;"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy JSON">Copy JSON</span></button>
                    </div>
                    <textarea class="cia-prompt-textarea text_pole" style="flex-grow: 1; resize: none; font-family: monospace; font-size: 0.88em; padding: 10px; border-radius: 8px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); line-height: 1.4; color: #dcdcdc; height: 90%;" ${isBusy ? 'readonly' : ''}>${escapeHtml(value)}</textarea>
                </div>

                <!-- Right: Interactive Editor Form -->
                <div style="flex: 1 1 50%; display: flex; flex-direction: column; gap: 10px; height: 100%; overflow-y: auto; padding-right: 4px;">
                    <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600; display: flex; justify-content: space-between; align-items: center;">
                        <span data-i18n="Interactive Segmented Editor">Interactive Segmented Editor</span>
                        <button class="menu_button btn-view-reasoning" type="button" data-i18n="[title]View AI Reasoning" title="View AI Reasoning" style="margin: 0; padding: 2px 8px; font-size: 0.8em; height: auto; min-height: auto; width: auto;"><i class="fa-solid fa-brain"></i> <span data-i18n="Reasoning">Reasoning</span></button>
                    </div>

                    <!-- Positive Prompt Card -->
                    <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                        <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center;">
                            <span data-i18n="Positive Prompt (Positive)">Positive Prompt (Positive)</span>
                            <button class="menu_button btn-copy-pos" type="button" data-i18n="[title]Copy positive prompt" title="Copy positive prompt" style="margin: 0; padding: 2px 6px; font-size: 0.76em; height: auto; min-height: auto; width: auto;"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy">Copy</span></button>
                        </div>
                        <textarea class="cia-right-pos text_pole" style="height: 90px; resize: none; font-size: 0.85em; background: rgba(0,0,0,0.2);" data-i18n="[placeholder]Positive prompt is empty..." placeholder="Positive prompt is empty..." ${isBusy ? 'disabled' : ''}>${escapeHtml(getCandidatePositivePrompt(parsedData))}</textarea>
                    </div>

                    <!-- Negative Prompt Card -->
                    <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                        <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center;">
                            <span data-i18n="Negative Prompt (Negative)">Negative Prompt (Negative)</span>
                            <button class="menu_button btn-copy-neg" type="button" data-i18n="[title]Copy negative prompt" title="Copy negative prompt" style="margin: 0; padding: 2px 6px; font-size: 0.76em; height: auto; min-height: auto; width: auto;"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy">Copy</span></button>
                        </div>
                        <textarea class="cia-right-neg text_pole" style="height: 70px; resize: none; font-size: 0.85em; background: rgba(0,0,0,0.2);" data-i18n="[placeholder]Negative prompt is empty..." placeholder="Negative prompt is empty..." ${isBusy ? 'disabled' : ''}>${escapeHtml(getCandidateNegativePrompt(parsedData))}</textarea>
                    </div>

                    <!-- LoRA parameters Card -->
                    <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;">
                        <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                            <span data-i18n="LoRA Parameter Weights">LoRA Parameter Weights</span>
                            <button class="menu_button btn-copy-lora" type="button" data-i18n="[title]Copy LoRA parameters as JSON" title="Copy LoRA parameters as JSON" style="margin: 0; padding: 2px 6px; font-size: 0.76em; height: auto; min-height: auto; width: auto;"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy JSON">Copy JSON</span></button>
                        </div>
                        ${loraSlidersHtml}
                    </div>
                </div>
            </div>
        </div>
    `));

    const textareaJson = popupContent.find('.cia-prompt-textarea');
    const rightPos = popupContent.find('.cia-right-pos');
    const rightNeg = popupContent.find('.cia-right-neg');

    const dynamicSliders = popupContent.find('.cia-dynamic-slider');
    const dynamicInputs = popupContent.find('.cia-dynamic-input');

    let isSyncing = false;

    // Updates left JSON textarea from the right interactive panel inputs
    const readCurrentEditorObject = () => {
        try {
            const current = parseCandidateJson(String(textareaJson.val() || '').trim());
            if (current && typeof current === 'object' && !Array.isArray(current)) {
                if (parsedData && parsedData.reasoning !== undefined) {
                    current.reasoning = parsedData.reasoning;
                }
                return { ...current };
            }
        } catch {
            // Keep existing parsed data while the JSON editor is temporarily invalid.
        }
        return { ...parsedData };
    };

    function updateLeftFromJson() {
        if (isSyncing || isBusy) return;
        isSyncing = true;
        try {
            const obj = readCurrentEditorObject();
            obj.prompt = String(rightPos.val() || '');
            obj.negative_prompt = String(rightNeg.val() || '');
            const strengthTarget = (obj.strengths && typeof obj.strengths === 'object' && !Array.isArray(obj.strengths))
                ? obj.strengths
                : (obj.lora_strengths && typeof obj.lora_strengths === 'object' && !Array.isArray(obj.lora_strengths))
                    ? obj.lora_strengths
                    : (obj.lora && typeof obj.lora === 'object' && !Array.isArray(obj.lora))
                        ? obj.lora
                        : obj;

            dynamicInputs.each(function () {
                const key = $(this).attr('data-key');
                const prop = numericProps.find(p => p.key === key);
                if (prop) {
                    const valRaw = parseFloat($(this).val());
                    const val = isNaN(valRaw) ? prop.default : valRaw;
                    strengthTarget[key] = val;
                }
            });

            const displayObj = { ...obj };
            delete displayObj.reasoning;
            textareaJson.val(JSON.stringify(displayObj, null, 2));
        } catch (e) {
            console.error(e);
        }
        isSyncing = false;
    }

    // Updates right panel controls from the left raw JSON inputs
    function updateRightFromJson() {
        if (isSyncing) return;
        isSyncing = true;
        try {
            const valStr = String(textareaJson.val() || '').trim();
            const parsed = parseCandidateJson(valStr);
            if (parsed && typeof parsed === 'object') {
                const promptValue = getCandidatePositivePrompt(parsed);
                if (promptValue && rightPos.val() !== promptValue) {
                    rightPos.val(promptValue);
                }
                const negativeValue = getCandidateNegativePrompt(parsed);
                if (rightNeg.val() !== negativeValue) {
                    rightNeg.val(negativeValue);
                }

                const strengths = getCandidateStrengthSource(parsed);
                dynamicSliders.each(function () {
                    const key = $(this).attr('data-key');
                    const prop = numericProps.find(p => p.key === key);
                    if (prop) {
                        const rawValue = strengths[key] ?? parsed[key];
                        const valInput = (rawValue !== undefined && !isNaN(Number(rawValue))) ? Number(rawValue) : prop.default;
                        const valSlider = clampNumber(valInput, prop.min, prop.max, prop.default);
                        if (!isNaN(valInput)) {
                            const inputEl = popupContent.find(`.cia-dynamic-input[data-key="${escapeHtmlAttr(key)}"]`);
                            if (parseFloat($(this).val()) !== valSlider) $(this).val(valSlider);
                            if (parseFloat(inputEl.val()) !== valInput) inputEl.val(valInput);
                        }
                    }
                });
            }
        } catch (e) {
            // Ignore incomplete JSON parsing errors while typing
        }
        isSyncing = false;
    }

    // Bind real-time change event bindings
    if (!isBusy) {
        rightPos.on('input change', updateLeftFromJson);
        rightNeg.on('input change', updateLeftFromJson);
        textareaJson.on('input change', updateRightFromJson);

        dynamicSliders.each(function () {
            const key = $(this).attr('data-key');
            const prop = numericProps.find(p => p.key === key);
            if (prop) {
                const slider = $(this);
                const input = popupContent.find(`.cia-dynamic-input[data-key="${escapeHtmlAttr(key)}"]`);
                slider.on('input change', function () {
                    const value = clampNumber($(this).val(), prop.min, prop.max, prop.default);
                    input.val(value);
                    updateLeftFromJson();
                });
                input.on('input change', function () {
                    const valRaw = parseFloat($(this).val());
                    const value = isNaN(valRaw) ? prop.default : valRaw;
                    input.val(value);
                    const sliderVal = clampNumber(value, prop.min, prop.max, prop.default);
                    slider.val(sliderVal);
                    updateLeftFromJson();
                });
            }
        });
    }

    // Copy event bindings
    popupContent.find('.btn-copy-json').on('click', () => {
        const valueToCopy = String(textareaJson.val() || '').trim();
        navigator.clipboard.writeText(valueToCopy);
        toastr.success(t`Full JSON config copied to clipboard.`, 'Context Image Assistant');
    });
    popupContent.find('.btn-copy-pos').on('click', () => {
        navigator.clipboard.writeText(String(rightPos.val() || ''));
        toastr.success(t`Positive prompt copied to clipboard.`, 'Context Image Assistant');
    });
    popupContent.find('.btn-copy-neg').on('click', () => {
        navigator.clipboard.writeText(String(rightNeg.val() || ''));
        toastr.success(t`Negative prompt copied to clipboard.`, 'Context Image Assistant');
    });
    popupContent.find('.btn-copy-lora').on('click', () => {
        const loraObj = {};
        dynamicInputs.each(function () {
            const key = $(this).attr('data-key');
            const prop = numericProps.find(p => p.key === key);
            if (prop) {
                loraObj[key] = clampNumber($(this).val(), prop.min, prop.max, prop.default);
            }
        });
        navigator.clipboard.writeText(JSON.stringify(loraObj, null, 2));
        toastr.success(t`LoRA weights JSON copied to clipboard.`, 'Context Image Assistant');
    });

    popupContent.find('.btn-view-reasoning').on('click', () => {
        let text = t`No reasoning found in this generation.`;
        if (parsedData && parsedData.reasoning) {
            text = String(parsedData.reasoning).trim();
        }
        const innerContent = $(`
            <div class="cia-prompt-popup-container" style="display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 100% !important; margin-bottom: 10px;">
                <div style="font-size: 1.1em; font-weight: 600; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 8px; margin-bottom: 4px;">
                    <i class="fa-solid fa-brain" style="color: #a5d3ff;"></i> <span data-i18n="AI Reasoning Process">AI Reasoning Process</span>
                </div>
                <div style="white-space: pre-wrap; font-family: monospace; font-size: 0.95em; line-height: 1.6; color: #dcdcdc; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 16px; max-height: 65vh; overflow-y: auto;"></div>
            </div>
        `);
        innerContent.find('div').last().text(text);
        new Popup(innerContent, POPUP_TYPE.TEXT, null, { okButton: t`Close`, wide: true }).show();
    });

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, null, {
        okButton: isBusy ? t`Close` : t`Save & Close`,
        cancelButton: isBusy ? null : t`Cancel`,
        wide: true,
        wider: true,
        large: true,
        leftAlign: true,
    });

    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE && !isBusy) {
        const edited = String(textareaJson.val() || '').trim();
        try {
            const parsed = normalizeCandidate(parseCandidateJson(edited));
            setMessageState(messageId, {
                status: 'ready',
                error: '',
                rawResponse: edited,
                parsed,
                updatedAt: new Date().toISOString(),
            });
            writeCandidateJsonToMessage(messageId, parsed);
            await saveChatWhenGeneratorIdle();
            renderMessageControls(messageId);
            toastr.success(t`Prompt parameters updated.`, 'Context Image Assistant');
        } catch (error) {
            toastr.error(t`JSON syntax error, failed to save.`, 'Context Image Assistant');
        }
    }
}

async function rebuildCandidateFromImage(messageId, mediaIndex) {
    const message = chat[messageId];
    const attachment = message?.extra?.media?.[mediaIndex];
    if (!message || !isRebuildableImageAttachment(attachment)) {
        toastr.warning(t`This image does not contain generation metadata for reconstruction.`, 'Context Image Assistant');
        return;
    }

    const currentCandidate = message.extra?.[EXTRA_KEY]?.parsed || {};
    const imageCandidate = attachment[EXTRA_KEY] || {};
    const imageReference = {
        mediaIndex,
        prompt: String(imageCandidate.prompt || attachment.title || currentCandidate.prompt || '').trim(),
        negative_prompt: String(imageCandidate.negative_prompt || attachment.negative || currentCandidate.negative_prompt || '').trim(),
    };

    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    for (const prop of numericProps) {
        const rawVal = getCandidateStrength(imageCandidate, prop.key, getCandidateStrength(currentCandidate, prop.key, undefined));
        imageReference[prop.key] = clampNumber(rawVal, prop.min, prop.max, getComfyPlaceholderDefault(prop.key, prop.default, prop));
    }

    if (!imageReference.prompt) {
        toastr.warning(t`This image lacks a prompt, cannot reconstruct.`, 'Context Image Assistant');
        return;
    }

    const popupContent = $(applyLocale(`
        <div class="cia-rebuild-popup-wrapper">
            <!-- Left: Image Preview & Reference Info -->
            <div class="cia-rebuild-left-col" style="flex: 0 0 45%; display: flex; flex-direction: column; gap: 10px; border-right: 1px solid rgba(255,255,255,0.08); padding-right: 16px; transition: opacity 0.3s ease;">
                <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600;" data-i18n="Reference Image">Reference Image</div>
                <div style="flex-grow: 1; height: 0; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center; overflow: hidden; padding: 4px;">
                    <img src="${escapeHtmlAttr(attachment.url)}" style="max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px;" />
                </div>
                <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600;" data-i18n="Reference Prompt (Reference Prompt)">Reference Prompt (Reference Prompt)</div>
                <textarea class="text_pole" style="height: 100px; resize: none; font-size: 0.82em; background: rgba(0,0,0,0.15); color: #c0c0c0;" readonly>${escapeHtml(imageReference.prompt)}</textarea>
            </div>

            <!-- Right: Instructions Input -->
            <div style="flex: 1 1 55%; display: flex; flex-direction: column; gap: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600;" data-i18n="Rebuild and Adjust Instructions">Rebuild and Adjust Instructions</div>
                    <div class="cia-rebuild-mode-group" style="display: inline-flex; background: rgba(0,0,0,0.25); padding: 2px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">
                        <button type="button" class="menu_button cia-rebuild-mode-btn active" data-mode="adjust" style="margin: 0; padding: 2px 10px; font-size: 0.78em; height: auto; width: auto; min-height: 20px; border-radius: 4px; border: none; background: var(--SmartThemeQuoteColor, #78beff); color: #000; font-weight: bold; transition: all 0.2s ease;" data-i18n="Adjust Mode">Adjust Mode</button>
                        <button type="button" class="menu_button cia-rebuild-mode-btn" data-mode="rewrite" style="margin: 0; padding: 2px 10px; font-size: 0.78em; height: auto; width: auto; min-height: 20px; border-radius: 4px; border: none; background: transparent; color: #fff; font-weight: normal; opacity: 0.7; transition: all 0.2s ease;" data-i18n="Rewrite Mode">Rewrite Mode</button>
                    </div>
                </div>
                <textarea class="cia-rebuild-instruction text_pole" style="flex-grow: 1; resize: none; font-size: 0.88em; padding: 10px; border-radius: 8px; line-height: 1.4;" placeholder="${escapeHtmlAttr(t('Enter the required edit instructions (e.g. change background, change clothes, adjust expression).'))}"></textarea>
            </div>
        </div>
    `));

    let currentMode = 'adjust';
    let editInstructionDraft = '';
    popupContent.find('.cia-rebuild-mode-btn').on('click', function () {
        const mode = $(this).attr('data-mode');
        if (mode === currentMode) {
            return;
        }
        currentMode = mode;

        popupContent.find('.cia-rebuild-mode-btn').each(function () {
            const btnMode = $(this).attr('data-mode');
            if (btnMode === currentMode) {
                $(this).addClass('active')
                    .css({
                        background: 'var(--SmartThemeQuoteColor, #78beff)',
                        color: '#000',
                        fontWeight: 'bold',
                        opacity: '1',
                    });
            } else {
                $(this).removeClass('active')
                    .css({
                        background: 'transparent',
                        color: '#fff',
                        fontWeight: 'normal',
                        opacity: '0.7',
                    });
            }
        });

        const leftCol = popupContent.find('.cia-rebuild-left-col');
        if (currentMode === 'rewrite') {
            editInstructionDraft = String(popupContent.find('.cia-rebuild-instruction').val() || '');
            leftCol.css('opacity', '0.4');
            popupContent.find('.cia-rebuild-instruction')
                .val('')
                .prop('disabled', true)
                .attr('placeholder', t('Replan uses the same request as normal image generation.'));
        } else {
            leftCol.css('opacity', '1');
            popupContent.find('.cia-rebuild-instruction')
                .prop('disabled', false)
                .val(editInstructionDraft)
                .attr('placeholder', t('Enter the required edit instructions (e.g. change background, change clothes, adjust expression).'));
        }
    });

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, t('Replan Image Generation'), {
        okButton: t('Start Rebuild'),
        cancelButton: t('Cancel'),
        wide: true,
        wider: true,
    });

    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const extraInstruction = String(popupContent.find('.cia-rebuild-instruction').val() || '').trim();
        if (currentMode === 'adjust' && !extraInstruction) {
            toastr.warning(t`Edit mode requires user instructions.`, 'Context Image Assistant');
            return;
        }
        imageReference.extraInstruction = extraInstruction;
        imageReference.mode = currentMode;

        const settings = ensureSettings();
        const autoGenOnRebuild = Boolean(settings.autoGenerateOnRebuild);

        await requestImageCandidate(messageId, {
            force: true,
            manual: true,
            imageReference,
            autoGenerate: autoGenOnRebuild,
        });
    }
}

function combinePrefixes(str1, str2, macro = '') {
    const process = (value) => String(value || '').trim().replace(/^,|,$/g, '').trim();
    if (!str2) {
        return process(str1);
    }

    str1 = process(str1);
    str2 = process(str2);
    if (!str1) {
        return str2;
    }

    const result = macro && str1.includes(macro) ? str1.replace(macro, str2) : `${str1}, ${str2},`;
    return process(result);
}

async function generateImageForMessage(messageId, { expectedSnapshot = null, silentIfStale = false } = {}) {
    const initialTarget = resolveMessageTarget(messageId, expectedSnapshot);
    if (!initialTarget) {
        return;
    }
    messageId = initialTarget.messageId;
    const generationKey = messageId;
    const message = initialTarget.message;
    const taskSnapshot = expectedSnapshot || createMessageSnapshot(messageId);
    const data = message?.extra?.[EXTRA_KEY];
    if (!data?.parsed?.prompt || activeGenerations.has(messageId)) {
        return;
    }
    try {
        assertCandidatePromptIsNotEmpty(data.parsed.prompt);
    } catch (error) {
        setMessageState(messageId, {
            status: 'error',
            error: String(error?.message || error),
            updatedAt: new Date().toISOString(),
        });
        runtimeState.status = 'error';
        runtimeState.lastResult = `#${messageId}: ${String(error?.message || error)}`;
        updateStatusUi();
        renderMessageControls(messageId);
        await saveChatWhenGeneratorIdle();
        toastr.warning(String(error?.message || error), 'Context Image Assistant');
        return;
    }

    activeGenerations.add(messageId);
    cancelRequestedImage.delete(messageId);
    const imageController = new AbortController();
    imageAbortControllers.set(messageId, imageController);
    setMessageState(messageId, { status: 'generating', error: '' });
    renderMessageControls(messageId);
    runtimeState.status = t`Generating image #${messageId}`;
    runtimeState.lastResult = t`Calling ComfyUI...`;
    updateStatusUi();

    try {
        const result = await generateComfyImage(data.parsed, imageController.signal);
        const latestTarget = resolveMessageTarget(messageId, taskSnapshot);
        if (!latestTarget) {
            setMessageState(messageId, {
                status: 'ready',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            if (!silentIfStale) {
                runtimeState.status = 'idle';
                runtimeState.lastResult = t`#${messageId} image generation result discarded (floor changed or deleted)`;
            }
            return;
        }
        if (latestTarget.messageId !== messageId) {
            activeGenerations.delete(messageId);
            activeGenerations.add(latestTarget.messageId);
            imageAbortControllers.delete(messageId);
            imageAbortControllers.set(latestTarget.messageId, imageController);
            if (cancelRequestedImage.delete(messageId)) {
                cancelRequestedImage.add(latestTarget.messageId);
            }
        }
        messageId = latestTarget.messageId;
        attachImageToMessage(messageId, data.parsed, result);
        setMessageState(messageId, {
            status: 'done',
            error: '',
            imageGeneratedAt: new Date().toISOString(),
        });
        runtimeState.status = 'done';
        runtimeState.lastResult = t`#${messageId} image generated`;
        activeGenerations.delete(generationKey);
        if (messageId !== generationKey) {
            activeGenerations.delete(messageId);
        }
        updateStatusUi();
        renderMessageControls(messageId);
        toastr.success(t`Image inserted into current message.`, 'Context Image Assistant');
        await saveChatWhenGeneratorIdle();
    } catch (error) {
        const cancelled = cancelRequestedImage.has(messageId) || isAbortLikeError(error);
        if (cancelled) {
            setMessageState(messageId, {
                status: 'ready',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            runtimeState.status = 'idle';
            runtimeState.lastResult = t`#${messageId} image generation cancelled`;
            renderMessageControls(messageId);
            toastr.info(t`Cancelled image generation.`, 'Context Image Assistant');
        } else {
            console.error('[context-image-assistant] image generation failed', error);
            setMessageState(messageId, {
                status: 'ready',
                error: String(error?.message || error),
            });
            runtimeState.status = 'error';
            runtimeState.lastResult = `#${messageId}: ${String(error?.message || error)}`;
            renderMessageControls(messageId);
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    } finally {
        activeGenerations.delete(generationKey);
        imageAbortControllers.delete(generationKey);
        cancelRequestedImage.delete(generationKey);
        if (messageId !== generationKey) {
            activeGenerations.delete(messageId);
            imageAbortControllers.delete(messageId);
            cancelRequestedImage.delete(messageId);
        }
        updateStatusUi();
        renderMessageControls(messageId);
    }
}

async function generateComfyImage(candidate, signal = null) {
    const sd = extension_settings.sd || {};
    if (sd.source && sd.source !== 'comfy') {
        throw new Error(t`Current ST image generation source is not ComfyUI. Please switch to ComfyUI in Image Generation settings.`);
    }
    if (!sd.comfy_url) {
        throw new Error(t`Please configure ComfyUI URL in ST Image Generation first.`);
    }
    if (!sd.comfy_workflow) {
        throw new Error(t`Please select ComfyUI Workflow in ST Image Generation first.`);
    }

    const workflowResponse = await fetch('/api/sd/comfy/workflow', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: signal || undefined,
        body: JSON.stringify({
            file_name: sd.comfy_workflow,
        }),
    });

    if (!workflowResponse.ok) {
        throw new Error(await workflowResponse.text());
    }

    let workflow = await workflowResponse.json();
    const activeCandidate = { ...candidate };
    const filtered = applyPromptRules(activeCandidate.prompt, activeCandidate.negative_prompt);
    activeCandidate.prompt = filtered.prompt;
    activeCandidate.negative_prompt = filtered.negative_prompt;

    const finalPrompt = combinePrefixes(sd.prompt_prefix, activeCandidate.prompt, '{prompt}');
    const negativePrompt = activeCandidate.negative_prompt
        ? combinePrefixes(sd.negative_prompt, activeCandidate.negative_prompt)
        : String(sd.negative_prompt || '');
    const seed = Number(sd.seed) >= 0 ? Number(sd.seed) : Math.round(Math.random() * Number.MAX_SAFE_INTEGER);
    const denoise = sd.denoising_strength === undefined ? 1.0 : Number(sd.denoising_strength);
    const clipSkip = Number.isNaN(Number(sd.clip_skip)) ? -1 : -Number(sd.clip_skip);

    const replacements = {
        prompt: finalPrompt,
        negative_prompt: negativePrompt,
        seed,
        denoise,
        clip_skip: clipSkip,
        model: sd.model,
        vae: sd.vae,
        sampler: sd.sampler,
        scheduler: sd.scheduler,
        steps: sd.steps,
        scale: sd.scale,
        width: sd.width,
        height: sd.height,
    };

    const candidateOverrideKeys = new Set(
        Object.entries(candidate || {})
            .filter(([key, rawValue]) => {
                if (!key || key === 'prompt' || key === 'negative_prompt') {
                    return false;
                }
                const valueType = typeof rawValue;
                return rawValue === null || valueType === 'string' || valueType === 'number' || valueType === 'boolean';
            })
            .map(([key]) => key),
    );

    for (const placeholder of sd.comfy_placeholders || []) {
        if (!placeholder?.find || candidateOverrideKeys.has(placeholder.find)) {
            continue;
        }
        replacements[placeholder.find] = substituteParams(String(placeholder.replace ?? ''));
    }

    for (const key of candidateOverrideKeys) {
        replacements[key] = candidate[key];
    }

    for (const [key, value] of Object.entries(replacements)) {
        workflow = replaceWorkflowPlaceholder(workflow, key, value);
    }

    workflow = await replaceAvatarPlaceholders(workflow);

    const basePath = sd.comfy_type === 'runpod_serverless' ? '/api/sd/comfyrunpod' : '/api/sd/comfy';
    const url = sd.comfy_type === 'runpod_serverless' ? sd.comfy_runpod_url : sd.comfy_url;
    const promptResult = await fetch(`${basePath}/generate`, {
        method: 'POST',
        headers: getRequestHeaders(),
        signal: signal || undefined,
        body: JSON.stringify({
            url,
            prompt: JSON.stringify({ prompt: JSON.parse(workflow) }),
        }),
    });

    if (!promptResult.ok) {
        throw new Error(await promptResult.text());
    }

    return promptResult.json();
}

function replaceWorkflowPlaceholder(workflow, key, value) {
    const token = `%${key}%`;
    const quotedToken = JSON.stringify(token);
    const safeValue = value ?? '';
    const serializedValue = JSON.stringify(safeValue);
    const escapedStringValue = escapeJsonStringContent(String(safeValue));

    return String(workflow)
        .replaceAll(quotedToken, serializedValue)
        .replaceAll(token, escapedStringValue);
}

function escapeJsonStringContent(value) {
    return JSON.stringify(value).slice(1, -1);
}

async function replaceAvatarPlaceholders(workflow) {
    if (/%user_avatar%/i.test(workflow)) {
        workflow = replaceWorkflowPlaceholder(workflow, 'user_avatar', await getAvatarBase64(getUserAvatar(user_avatar)));
    }
    if (/%char_avatar%/i.test(workflow)) {
        workflow = replaceWorkflowPlaceholder(workflow, 'char_avatar', await getAvatarBase64(getCharacterAvatarUrl()));
    }
    return workflow;
}

function getCharacterAvatarUrl() {
    const context = getContext();

    if (context.groupId) {
        const groupMembers = context.groups.find(x => x.id === context.groupId)?.members;
        const lastMessageAvatar = context.chat?.filter(x => !x.is_system && !x.is_user)?.slice(-1)[0]?.original_avatar;
        const randomMemberAvatar = Array.isArray(groupMembers) ? groupMembers[Math.floor(Math.random() * groupMembers.length)] : null;
        const avatarToUse = lastMessageAvatar || randomMemberAvatar;
        return formatCharacterAvatar(avatarToUse);
    }

    if (this_chid === undefined || selected_group) {
        return '';
    }

    return getCharacterAvatar(context.characterId);
}

function getOrCreateMessageCiaId(message) {
    message.extra ??= {};
    if (!message.extra.cia_msg_id) {
        message.extra.cia_msg_id = 'cia-msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
    }
    return message.extra.cia_msg_id;
}

let galleryDataRevision = 0;
let gallerySnapshotCache = null;
const favoriteArchiveCopyTasks = new Map();
const favoriteMutationQueues = new Map();
const favoriteSourceHashCache = new Map();
let favoriteArchiveNormalizationPending = false;

function invalidateGalleryData() {
    galleryDataRevision++;
    gallerySnapshotCache = null;
}

function getRecycleBin() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return [];
    }

    const legacyBin = Array.isArray(chat?.[0]?.extra?.[RECYCLE_BIN_KEY]) ? chat[0].extra[RECYCLE_BIN_KEY] : [];
    if (!Array.isArray(chat_metadata[RECYCLE_BIN_KEY])) {
        chat_metadata[RECYCLE_BIN_KEY] = [];
    }
    if (chat_metadata[RECYCLE_BIN_KEY].length === 0 && legacyBin.length > 0) {
        chat_metadata[RECYCLE_BIN_KEY] = [...legacyBin];
        if (chat?.[0]?.extra) {
            delete chat[0].extra[RECYCLE_BIN_KEY];
        }
    }
    return chat_metadata[RECYCLE_BIN_KEY];
}

function getFavoriteArchive() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return [];
    }
    if (!Array.isArray(chat_metadata[FAVORITE_ARCHIVE_KEY])) {
        chat_metadata[FAVORITE_ARCHIVE_KEY] = [];
    }
    const archive = chat_metadata[FAVORITE_ARCHIVE_KEY];
    for (const item of archive) {
        if (!item || typeof item !== 'object') continue;
        const sourceKey = getFavoriteArchiveItemKey(item);
        if (sourceKey && item.sourceKey !== sourceKey) {
            item.sourceKey = sourceKey;
            favoriteArchiveNormalizationPending = true;
        }
        if (String(item.sourceUrl || '').startsWith('data:')) {
            delete item.sourceUrl;
            favoriteArchiveNormalizationPending = true;
        }
    }
    return archive;
}

function saveFavoriteArchive(archive) {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return;
    }
    chat_metadata[FAVORITE_ARCHIVE_KEY] = Array.isArray(archive) ? archive : [];
    invalidateGalleryData();
}

function saveRecycleBin(bin) {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return;
    }
    chat_metadata[RECYCLE_BIN_KEY] = Array.isArray(bin) ? bin : [];
    if (chat?.[0]?.extra) {
        delete chat[0].extra[RECYCLE_BIN_KEY];
    }
    invalidateGalleryData();
}

function getGalleryUiState() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return {
            favoritesOnly: false,
            floorFilter: '',
            sortDirection: 'asc',
        };
    }

    if (!chat_metadata[GALLERY_UI_STATE_KEY] || typeof chat_metadata[GALLERY_UI_STATE_KEY] !== 'object' || Array.isArray(chat_metadata[GALLERY_UI_STATE_KEY])) {
        chat_metadata[GALLERY_UI_STATE_KEY] = {};
    }

    const state = chat_metadata[GALLERY_UI_STATE_KEY];
    state.favoritesOnly = Boolean(state.favoritesOnly);
    state.floorFilter = String(state.floorFilter || '');
    state.sortDirection = state.sortDirection === 'desc' ? 'desc' : 'asc';
    return state;
}

let galleryFilterRenderTimer = null;
let galleryUiSaveTimer = null;

function scheduleGalleryFilterRender() {
    clearTimeout(galleryFilterRenderTimer);
    galleryFilterRenderTimer = setTimeout(() => {
        galleryFilterRenderTimer = null;
        renderGalleryList();
    }, 150);
}

function scheduleGalleryUiStateSave() {
    clearTimeout(galleryUiSaveTimer);
    const scheduledChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
    galleryUiSaveTimer = setTimeout(() => {
        galleryUiSaveTimer = null;
        const currentChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
        if (currentChatId !== scheduledChatId) {
            return;
        }
        void saveChatConditional().catch(error => {
            console.warn('[context-image-assistant] failed to save gallery UI state', error);
        });
    }, 800);
}

function clearPendingGalleryUiWork() {
    clearTimeout(galleryFilterRenderTimer);
    clearTimeout(galleryUiSaveTimer);
    galleryFilterRenderTimer = null;
    galleryUiSaveTimer = null;
}

function applyGalleryUiStateToFilters() {
    const state = getGalleryUiState();
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked', state.favoritesOnly);
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val(state.floorFilter);
}

function saveGalleryFilterStateFromUi() {
    const state = getGalleryUiState();
    state.favoritesOnly = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    state.floorFilter = String($(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val() || '');
    scheduleGalleryUiStateSave();
}

function saveGallerySortDirection(direction) {
    const state = getGalleryUiState();
    state.sortDirection = direction === 'desc' ? 'desc' : 'asc';
    scheduleGalleryUiStateSave();
}

function sortGalleryItemsForLargeGrid(items) {
    const direction = getGalleryUiState().sortDirection;
    const multiplier = direction === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
        const hasFloorA = Number.isInteger(a.floorNumber);
        const hasFloorB = Number.isInteger(b.floorNumber);
        if (hasFloorA !== hasFloorB) return hasFloorA ? -1 : 1;
        const floorA = hasFloorA ? a.floorNumber : 0;
        const floorB = hasFloorB ? b.floorNumber : 0;
        if (floorA !== floorB) {
            return (floorA - floorB) * multiplier;
        }
        const hasMediaA = Number.isInteger(a.mediaIndex);
        const hasMediaB = Number.isInteger(b.mediaIndex);
        if (hasMediaA !== hasMediaB) return hasMediaA ? -1 : 1;
        const mediaA = hasMediaA ? a.mediaIndex : 0;
        const mediaB = hasMediaB ? b.mediaIndex : 0;
        return (mediaA - mediaB) * multiplier;
    });
}

function getRecycleItemKey(item) {
    if (!item || typeof item !== 'object') {
        return '';
    }
    return [
        String(item.url || ''),
        String(item.cia_msg_id || ''),
        String(item.deletedAt || ''),
        String(item.title || ''),
    ].join('\u001f');
}

function getFavoriteSourceKey(sourceCiaMsgId, sourceUrl) {
    if (!sourceCiaMsgId || !sourceUrl) {
        return '';
    }
    const normalizedUrl = String(sourceUrl);
    let sourceHash = favoriteSourceHashCache.get(normalizedUrl);
    if (!sourceHash) {
        sourceHash = getStringHash(normalizedUrl);
        favoriteSourceHashCache.set(normalizedUrl, sourceHash);
    }
    return `${sourceCiaMsgId}\u001f${sourceHash}`;
}

function getFavoriteArchiveItemKey(item) {
    if (item?.sourceKey) {
        return String(item.sourceKey);
    }
    if (String(item?.id || '').startsWith('fav:')) {
        return String(item.id).slice(4);
    }
    return getFavoriteSourceKey(item?.sourceCiaMsgId || item?.cia_msg_id, item?.sourceUrl || item?.url);
}

function cloneAttachmentMetadata(attachment) {
    return {
        ...(attachment?.[EXTRA_KEY] || {}),
    };
}

async function imageUrlToDataUrl(url) {
    const value = String(url || '');
    if (!value) {
        return '';
    }
    if (value.startsWith('data:')) {
        return value;
    }
    const response = await fetch(value);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    return await getBase64Async(blob);
}

function isFavoriteSourceCurrentlyFavorited(sourceKey) {
    if (!sourceKey) return false;
    for (const message of chat) {
        const ciaMsgId = String(message?.extra?.cia_msg_id || '');
        const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
        for (const attachment of media) {
            if (attachment?.[EXTRA_KEY]?.isFavorited && getFavoriteSourceKey(ciaMsgId, attachment.url) === sourceKey) {
                return true;
            }
        }
    }
    for (const item of getRecycleBin()) {
        if (item?.isFavorited && getFavoriteSourceKey(item.cia_msg_id, item.url) === sourceKey) {
            return true;
        }
    }
    return false;
}

async function ensureFavoriteArchiveCopy(item, attachment, message) {
    const sourceCiaMsgId = message
        ? getOrCreateMessageCiaId(message)
        : String(item?.cia_msg_id || item?.sourceCiaMsgId || '');
    const sourceUrl = String(attachment?.url || item?.url || '');
    const sourceKey = getFavoriteSourceKey(sourceCiaMsgId, sourceUrl);
    if (!sourceKey) {
        return null;
    }

    const runningTask = favoriteArchiveCopyTasks.get(sourceKey);
    if (runningTask) {
        return await runningTask;
    }

    const task = ensureFavoriteArchiveCopyUnlocked(item, attachment, sourceCiaMsgId, sourceUrl, sourceKey);
    favoriteArchiveCopyTasks.set(sourceKey, task);
    try {
        return await task;
    } finally {
        if (favoriteArchiveCopyTasks.get(sourceKey) === task) {
            favoriteArchiveCopyTasks.delete(sourceKey);
        }
    }
}

async function ensureFavoriteArchiveCopyUnlocked(item, attachment, sourceCiaMsgId, sourceUrl, sourceKey) {

    const archive = getFavoriteArchive();
    const existing = archive.find(entry => getFavoriteArchiveItemKey(entry) === sourceKey);
    if (existing) {
        existing.isFavorited = true;
        existing.sourceMediaIndex = Number.isInteger(item?.mediaIndex) ? item.mediaIndex : existing.sourceMediaIndex;
        existing.originalFloorNumber = Number.isInteger(item?.floorNumber) ? item.floorNumber : existing.originalFloorNumber;
        existing.updatedAt = new Date().toISOString();
        saveFavoriteArchive(archive);
        return existing;
    }

    const archivedUrl = await imageUrlToDataUrl(sourceUrl);
    if (!isFavoriteSourceCurrentlyFavorited(sourceKey)) {
        return null;
    }
    const duplicate = getFavoriteArchive().find(entry => getFavoriteArchiveItemKey(entry) === sourceKey);
    if (duplicate) {
        return duplicate;
    }
    const entry = {
        id: `fav:${sourceKey}`,
        sourceKey,
        sourceCiaMsgId,
        sourceMediaIndex: Number.isInteger(item?.mediaIndex) ? item.mediaIndex : null,
        ...(sourceUrl.startsWith('data:') ? {} : { sourceUrl }),
        url: archivedUrl,
        title: attachment?.title || item?.title || '',
        negative: attachment?.negative || item?.negative || '',
        generation_type: attachment?.generation_type || MODULE_NAME,
        source: attachment?.source || MEDIA_SOURCE.GENERATED,
        [EXTRA_KEY]: cloneAttachmentMetadata(attachment),
        originalFloorNumber: Number.isInteger(item?.floorNumber) ? item.floorNumber : null,
        archivedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isFavorited: true,
    };
    entry[EXTRA_KEY].isFavorited = true;
    const latestArchive = getFavoriteArchive();
    latestArchive.push(entry);
    saveFavoriteArchive(latestArchive);
    return entry;
}

function removeFavoriteArchiveCopy(item) {
    const archive = getFavoriteArchive();
    const sourceKey = item?.type === 'favorite_archive'
        ? getFavoriteArchiveItemKey(item)
        : getFavoriteSourceKey(item?.cia_msg_id || item?.sourceCiaMsgId, item?.sourceUrl || item?.url);
    const nextArchive = sourceKey
        ? archive.filter(entry => getFavoriteArchiveItemKey(entry) !== sourceKey)
        : archive;
    if (nextArchive.length !== archive.length) {
        saveFavoriteArchive(nextArchive);
        return true;
    }
    return false;
}

let favoriteArchiveMigrationRunning = false;
let lastFavoriteArchiveMigrationSignature = '';

async function migrateExistingFavoriteArchiveCopies() {
    if (favoriteArchiveMigrationRunning || !chat_metadata || typeof chat_metadata !== 'object') {
        return;
    }

    favoriteArchiveMigrationRunning = true;
    let createdCount = 0;
    const migrationChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
    const isCurrentMigrationChat = () => {
        const currentChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
        return currentChatId === migrationChatId;
    };

    try {
        const snapshot = getGallerySnapshot();
        const candidates = [
            ...snapshot.activeItems.filter(item => item.isFavorited),
            ...snapshot.recycleItems.filter(item => item.isFavorited),
        ];
        const candidateKeys = candidates.map(item => getFavoriteSourceKey(item.cia_msg_id || item.sourceCiaMsgId, item.url)).filter(Boolean).sort();
        const signature = `${candidateKeys.length}:${getStringHash(candidateKeys.join('\u001e'))}`;
        const migrationState = chat_metadata[FAVORITE_ARCHIVE_MIGRATION_KEY];
        if (signature === lastFavoriteArchiveMigrationSignature || migrationState?.signature === signature) {
            if (favoriteArchiveNormalizationPending) {
                favoriteArchiveNormalizationPending = false;
                await saveChatWhenGeneratorIdle();
            }
            return;
        }

        const archiveKeys = new Set(getFavoriteArchive().map(getFavoriteArchiveItemKey).filter(Boolean));
        for (const item of candidates) {
            if (!isCurrentMigrationChat()) return;
            const sourceKey = getFavoriteSourceKey(item.cia_msg_id, item.url);
            if (!sourceKey || archiveKeys.has(sourceKey)) {
                continue;
            }
            try {
                const message = item.type === 'active' ? chat[item.msgId] : null;
                const attachment = item.type === 'active'
                    ? message?.extra?.media?.[item.mediaIndex]
                    : {
                        url: item.url,
                        title: item.title,
                        negative: item.negative,
                        generation_type: MODULE_NAME,
                        source: MEDIA_SOURCE.GENERATED,
                        [EXTRA_KEY]: item[EXTRA_KEY] || {},
                    };
                const archived = await ensureFavoriteArchiveCopy(item, attachment, message);
                if (!isCurrentMigrationChat()) return;
                if (archived) {
                    archiveKeys.add(sourceKey);
                    createdCount++;
                }
            } catch (error) {
                console.warn('[context-image-assistant] failed to migrate favorite image copy', error);
            }
        }

        if (!isCurrentMigrationChat()) return;
        lastFavoriteArchiveMigrationSignature = signature;
        chat_metadata[FAVORITE_ARCHIVE_MIGRATION_KEY] = {
            version: 1,
            signature,
            checkedAt: new Date().toISOString(),
        };

        const shouldSaveMigration = createdCount > 0 || favoriteArchiveNormalizationPending;
        favoriteArchiveNormalizationPending = false;
        if (shouldSaveMigration) {
            await saveChatWhenGeneratorIdle();
        }
        if (createdCount > 0) {
            if (isImageManagementTabActive()) {
                renderGalleryList();
                renderRecycleBinList();
            }
            toastr.success(t`Backfilled ${createdCount} favorite image copies.`, 'Context Image Assistant');
        }
    } finally {
        favoriteArchiveMigrationRunning = false;
    }
}

function findRecycleBinIndex(reference) {
    const bin = getRecycleBin();
    if (Number.isInteger(reference)) {
        return reference >= 0 && reference < bin.length ? reference : -1;
    }
    if (reference && typeof reference === 'object') {
        const key = reference.recycleKey || getRecycleItemKey(reference);
        if (key) {
            return bin.findIndex(item => getRecycleItemKey(item) === key);
        }
        if (Number.isInteger(reference.binIndex)) {
            return reference.binIndex >= 0 && reference.binIndex < bin.length ? reference.binIndex : -1;
        }
    }
    return -1;
}

function sweepMessage(message) {
    if (!message || !message.extra || !Array.isArray(message.extra.media)) {
        return false;
    }
    const media = message.extra.media;
    let mediaIndex = Number.isInteger(message.extra.media_index) ? message.extra.media_index : 0;
    if (mediaIndex < 0 || mediaIndex >= media.length) {
        mediaIndex = 0;
    }

    const keepMedia = [];
    const sweepItems = [];

    for (let i = 0; i < media.length; i++) {
        const item = media[i];
        if (i === mediaIndex) {
            keepMedia.push(item);
        } else if (isRebuildableImageAttachment(item)) {
            sweepItems.push(item);
        } else {
            keepMedia.push(item);
        }
    }

    if (sweepItems.length > 0) {
        const bin = getRecycleBin();
        const ciaMsgId = getOrCreateMessageCiaId(message);

        for (const item of sweepItems) {
            bin.push({
                url: item.url,
                title: item.title,
                negative: item.negative || '',
                generation_type: item.generation_type,
                source: item.source,
                [EXTRA_KEY]: item[EXTRA_KEY] || {},
                cia_msg_id: ciaMsgId,
                deletedAt: new Date().toISOString(),
                isFavorited: !!item[EXTRA_KEY]?.isFavorited,
            });
        }

        saveRecycleBin(bin);

        message.extra.media = keepMedia;
        const originalActiveItem = media[mediaIndex];
        const newActiveIndex = keepMedia.indexOf(originalActiveItem);
        message.extra.media_index = newActiveIndex >= 0 ? newActiveIndex : 0;

        if (keepMedia.length === 0) {
            delete message.extra.media;
            delete message.extra.media_index;
            delete message.extra.media_display;
            delete message.extra.inline_image;
        }

        return true;
    }
    return false;
}

function isImageManagementTabActive() {
    return $(`#${PANEL_CONTAINER_ID} .cia-tab-btn[data-tab="tab-recycle"]`).hasClass('active');
}

let lastChatId = null;
let lastRenderedGalleryRevision = -1;

function refreshImageManagementViews({ force = false } = {}) {
    if (!force && !isImageManagementTabActive()) {
        return;
    }

    const currentChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
    const hasChatChanged = force ||
        currentChatId !== lastChatId ||
        galleryDataRevision !== lastRenderedGalleryRevision;

    if (hasChatChanged) {
        lastChatId = currentChatId;
        lastRenderedGalleryRevision = galleryDataRevision;

        applyGalleryUiStateToFilters();
        renderGalleryList();
        renderRecycleBinList();
        void migrateExistingFavoriteArchiveCopies();
    }
}

async function deletePhysicalImage(url) {
    if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('/api/chats/media/')) {
        return true;
    }
    try {
        const response = await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });
        if (response.ok) {
            console.log(`[context-image-assistant] physically deleted image: ${url}`);
            return true;
        }
        console.warn(`[context-image-assistant] failed to delete physical image: HTTP ${response.status}`);
    } catch (e) {
        console.error(`[context-image-assistant] failed to delete physical file: ${url}`, e);
    }
    return false;
}

function hasOtherImageReferences(url, ignoredRecycleKeys = new Set()) {
    const normalizedUrl = String(url || '');
    if (!normalizedUrl || normalizedUrl.startsWith('data:')) {
        return false;
    }
    for (const message of chat) {
        const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
        if (media.some(attachment => String(attachment?.url || '') === normalizedUrl)) {
            return true;
        }
    }
    if (getFavoriteArchive().some(item => String(item?.url || '') === normalizedUrl)) {
        return true;
    }
    return getRecycleBin().some(item =>
        !ignoredRecycleKeys.has(getRecycleItemKey(item)) && String(item?.url || '') === normalizedUrl,
    );
}

async function deletePhysicalImageIfUnreferenced(url, ignoredRecycleKeys = new Set()) {
    if (hasOtherImageReferences(url, ignoredRecycleKeys)) {
        return true;
    }
    const deleted = await deletePhysicalImage(url);
    if (deleted) {
        favoriteSourceHashCache.delete(String(url || ''));
    }
    return deleted;
}

async function deleteRecycleItem(reference) {
    const bin = getRecycleBin();
    const index = findRecycleBinIndex(reference);
    const item = bin[index];
    if (!item) return;
    const recycleKey = getRecycleItemKey(item);

    if (!await deletePhysicalImageIfUnreferenced(item.url, new Set([recycleKey]))) {
        toastr.error(t`Image could not be deleted and remains in the Recycle Bin.`, 'Context Image Assistant');
        return;
    }
    const currentIndex = findRecycleBinIndex({ recycleKey });
    if (currentIndex === -1) return;
    bin.splice(currentIndex, 1);
    saveRecycleBin(bin);
    await saveChatWhenGeneratorIdle();
    renderRecycleBinList();
    renderGalleryList();
    toastr.success(t`Permanently deleted the image.`, 'Context Image Assistant');
}

async function restoreRecycleItem(reference) {
    const bin = getRecycleBin();
    const index = findRecycleBinIndex(reference);
    const item = bin[index];
    if (!item) return;

    const message = chat.find(msg => msg?.extra?.cia_msg_id === item.cia_msg_id);
    if (!message) {
        toastr.warning(t`Original message floor for this image not found, cannot restore.`, 'Context Image Assistant');
        return;
    }

    message.extra ??= {};
    message.extra.media ??= [];

    const attachment = {
        url: item.url,
        type: MEDIA_TYPE.IMAGE,
        title: item.title,
        negative: item.negative || '',
        generation_type: item.generation_type,
        source: item.source,
        [EXTRA_KEY]: item[EXTRA_KEY] || {},
    };
    if (item.isFavorited) {
        attachment[EXTRA_KEY].isFavorited = true;
    }

    message.extra.media.push(attachment);
    message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.inline_image = true;
    invalidateGalleryData();

    bin.splice(index, 1);
    saveRecycleBin(bin);

    await saveChatWhenGeneratorIdle();

    const messageId = chat.indexOf(message);
    if (messageId >= 0) {
        const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
        if (messageElement.length) {
            appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
            renderMessageControls(messageId);
        }
    }

    renderRecycleBinList();
    renderGalleryList();
    toastr.success(t`Image successfully restored to original floor.`, 'Context Image Assistant');
}

async function recycleActiveGalleryItem(item) {
    if (item.type !== 'active') return;
    const message = chat.find(msg => item.cia_msg_id && msg?.extra?.cia_msg_id === item.cia_msg_id) || chat[item.msgId];
    if (!message || !message.extra || !Array.isArray(message.extra.media)) return;

    const expectedUrl = String(item.sourceUrl || item.url || '');
    const attachment = message.extra.media.find(media => String(media?.url || '') === expectedUrl)
        || (!expectedUrl ? message.extra.media[item.mediaIndex] : null);
    if (!attachment) return;

    if (attachment[EXTRA_KEY]?.isFavorited) {
        try {
            await ensureFavoriteArchiveCopy(item, attachment, message);
        } catch (error) {
            toastr.warning(t`Favorite image copy could not be saved before recycling: ${String(error?.message || error)}`, 'Context Image Assistant');
        }
    }

    const currentMediaIndex = message.extra.media.indexOf(attachment);
    if (currentMediaIndex === -1) return;

    const bin = getRecycleBin();
    const ciaMsgId = getOrCreateMessageCiaId(message);

    bin.push({
        url: attachment.url,
        title: attachment.title,
        negative: attachment.negative || '',
        generation_type: attachment.generation_type,
        source: attachment.source,
        [EXTRA_KEY]: attachment[EXTRA_KEY] || {},
        cia_msg_id: ciaMsgId,
        deletedAt: new Date().toISOString(),
        isFavorited: !!attachment[EXTRA_KEY]?.isFavorited,
    });

    saveRecycleBin(bin);

    const previousMediaIndex = Number.isInteger(message.extra.media_index) ? message.extra.media_index : 0;

    // Remove from message media
    message.extra.media.splice(currentMediaIndex, 1);

    // Adjust media_index
    if (message.extra.media.length === 0) {
        delete message.extra.media;
        delete message.extra.media_index;
        delete message.extra.media_display;
        delete message.extra.inline_image;
    } else {
        if (previousMediaIndex > currentMediaIndex) {
            message.extra.media_index = previousMediaIndex - 1;
        } else if (previousMediaIndex === currentMediaIndex) {
            message.extra.media_index = Math.min(currentMediaIndex, message.extra.media.length - 1);
        } else {
            message.extra.media_index = Math.min(previousMediaIndex, message.extra.media.length - 1);
        }
    }

    await saveChatWhenGeneratorIdle();

    // Re-render the chat message if visible
    const messageId = item.msgId;
    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length) {
        appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
        renderMessageControls(messageId);
    }

    // Refresh UI
    renderRecycleBinList();
    renderGalleryList();

    // If the large grid popup is open, we can remove it or refresh it
    const largeGridWrapper = $('.cia-large-grid-popup-wrapper');
    if (largeGridWrapper.length) {
        const largeGridMode = largeGridWrapper.attr('data-mode') || 'gallery';
        if (largeGridMode === 'gallery') {
            const card = largeGridWrapper.find(`.cia-recycle-card[data-id="${item.id}"]`);
            card.remove();
            const container = largeGridWrapper.find('.cia-large-grid-container');
            if (container.children('.cia-recycle-card').length === 0) {
                container.empty().append($(applyLocale('<div class="cia-recycle-empty" style="width: 100%;" data-i18n="No images">No images</div>')));
            }
            const countEl = largeGridWrapper.find('.cia-large-grid-count');
            if (countEl.length) {
                const currentCount = parseInt(countEl.text(), 10) || 0;
                countEl.text(Math.max(0, currentCount - 1));
            }
        }
    }

    toastr.success(t`Image moved to recycle bin.`, 'Context Image Assistant');
}

function getGallerySnapshot() {
    const chatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
    if (gallerySnapshotCache?.revision === galleryDataRevision && gallerySnapshotCache.chatId === chatId) {
        return gallerySnapshotCache;
    }

    const messageIndexByCiaId = new Map();
    for (let msgId = 0; msgId < chat.length; msgId++) {
        const ciaMsgId = String(chat[msgId]?.extra?.cia_msg_id || '');
        if (ciaMsgId) messageIndexByCiaId.set(ciaMsgId, msgId);
    }

    const activeItems = [];
    const activeKeys = new Set();
    for (let msgId = 0; msgId < chat.length; msgId++) {
        const message = chat[msgId];
        const media = Array.isArray(message?.extra?.media) ? message.extra.media : [];
        let ciaMsgId = String(message?.extra?.cia_msg_id || '');
        for (let mediaIndex = 0; mediaIndex < media.length; mediaIndex++) {
            const attachment = media[mediaIndex];
            if (!isRebuildableImageAttachment(attachment)) continue;
            if (!ciaMsgId && attachment?.[EXTRA_KEY]?.isFavorited) {
                ciaMsgId = getOrCreateMessageCiaId(message);
                messageIndexByCiaId.set(ciaMsgId, msgId);
            }
            const sourceKey = getFavoriteSourceKey(ciaMsgId, attachment.url);
            if (sourceKey) activeKeys.add(sourceKey);
            activeItems.push({
                id: `active:${msgId}:${mediaIndex}`,
                type: 'active',
                msgId,
                floorNumber: msgId + 1,
                mediaIndex,
                cia_msg_id: ciaMsgId,
                sourceCiaMsgId: ciaMsgId,
                sourceUrl: attachment.url,
                favoriteSourceKey: sourceKey,
                url: attachment.url,
                title: attachment.title,
                negative: attachment.negative || '',
                [EXTRA_KEY]: attachment[EXTRA_KEY] || {},
                isFavorited: !!attachment[EXTRA_KEY]?.isFavorited,
                createdAt: attachment[EXTRA_KEY]?.updatedAt || message.send_date || '',
            });
        }
    }

    const favoriteItems = [];
    const favoriteBySourceKey = new Map();
    const archive = getFavoriteArchive();
    for (let archiveIndex = 0; archiveIndex < archive.length; archiveIndex++) {
        const item = archive[archiveIndex];
        const sourceKey = getFavoriteArchiveItemKey(item);
        if (!sourceKey) continue;
        favoriteBySourceKey.set(sourceKey, item);
        if (!item?.isFavorited || activeKeys.has(sourceKey)) continue;
        const originalMsgIndex = messageIndexByCiaId.get(String(item.sourceCiaMsgId || '')) ?? -1;
        favoriteItems.push({
            id: `favorite_archive:${archiveIndex}:${getStringHash(sourceKey)}`,
            type: 'favorite_archive',
            archiveIndex,
            favoriteSourceKey: sourceKey,
            msgId: originalMsgIndex,
            floorNumber: Number.isInteger(item.originalFloorNumber) ? item.originalFloorNumber : (originalMsgIndex >= 0 ? originalMsgIndex + 1 : null),
            mediaIndex: Number.isInteger(item.sourceMediaIndex) ? item.sourceMediaIndex : null,
            sourceCiaMsgId: item.sourceCiaMsgId,
            sourceUrl: item.sourceUrl || '',
            url: item.url,
            title: item.title,
            negative: item.negative || '',
            [EXTRA_KEY]: item[EXTRA_KEY] || {},
            isFavorited: true,
            createdAt: item.archivedAt || item.updatedAt || '',
        });
    }

    const recycleItems = getRecycleBin().map((item, binIndex) => {
        const originalMsgIndex = messageIndexByCiaId.get(String(item.cia_msg_id || '')) ?? -1;
        return {
            id: `recycle:${binIndex}`,
            type: 'recycle',
            binIndex,
            recycleKey: getRecycleItemKey(item),
            msgId: originalMsgIndex,
            floorNumber: originalMsgIndex >= 0 ? originalMsgIndex + 1 : null,
            url: item.url,
            title: item.title,
            negative: item.negative || '',
            [EXTRA_KEY]: item[EXTRA_KEY] || {},
            isFavorited: !!item.isFavorited,
            createdAt: item.deletedAt || '',
            cia_msg_id: item.cia_msg_id,
        };
    });

    gallerySnapshotCache = {
        chatId,
        revision: galleryDataRevision,
        messageIndexByCiaId,
        favoriteBySourceKey,
        activeItems,
        favoriteItems,
        recycleItems,
        galleryItems: [...activeItems, ...favoriteItems],
    };
    return gallerySnapshotCache;
}

function getActiveGalleryImages() {
    return getGallerySnapshot().activeItems;
}

function getFavoriteArchiveGalleryImages() {
    return getGallerySnapshot().favoriteItems;
}

function getGalleryImages() {
    return getGallerySnapshot().galleryItems;
}

function getRecycleGalleryImages() {
    return getGallerySnapshot().recycleItems;
}

function getFilteredGalleryImages() {
    const all = getGalleryImages();
    const showOnlyFav = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    const floorFilter = String($(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val() || '').trim();

    return all.filter(item => {
        if (showOnlyFav && !item.isFavorited) {
            return false;
        }

        if (floorFilter && !testIndexFilter(item, floorFilter)) {
            return false;
        }

        return true;
    });
}

function isGalleryFilterActive() {
    const showOnlyFav = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    const floorFilter = String($(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val() || '').trim();
    return showOnlyFav || Boolean(floorFilter);
}

function getFilteredRecycleImages() {
    return getRecycleGalleryImages();
}

function getFavoriteMutationKey(item) {
    if (item?.favoriteSourceKey) return item.favoriteSourceKey;
    if (item?.type === 'active') {
        const message = chat[item.msgId];
        const attachment = message?.extra?.media?.[item.mediaIndex];
        if (message && attachment) {
            return getFavoriteSourceKey(getOrCreateMessageCiaId(message), attachment.url);
        }
    }
    return getFavoriteSourceKey(item?.cia_msg_id || item?.sourceCiaMsgId, item?.sourceUrl || item?.url) || String(item?.id || 'gallery-item');
}

async function toggleGalleryFavorite(item) {
    const mutationKey = getFavoriteMutationKey(item);
    const previous = favoriteMutationQueues.get(mutationKey) || Promise.resolve();
    const task = previous.catch(() => {}).then(() => performGalleryFavoriteToggle(item));
    favoriteMutationQueues.set(mutationKey, task);
    try {
        await task;
    } finally {
        if (favoriteMutationQueues.get(mutationKey) === task) {
            favoriteMutationQueues.delete(mutationKey);
        }
    }
}

async function performGalleryFavoriteToggle(item) {
    if (item.type === 'active') {
        const message = chat.find(msg => item.cia_msg_id && msg?.extra?.cia_msg_id === item.cia_msg_id) || chat[item.msgId];
        if (message && message.extra && Array.isArray(message.extra.media)) {
            const expectedUrl = String(item.sourceUrl || item.url || '');
            const attachment = message.extra.media.find(media => String(media?.url || '') === expectedUrl)
                || (!expectedUrl ? message.extra.media[item.mediaIndex] : null);
            if (attachment) {
                attachment[EXTRA_KEY] ??= {};
                attachment[EXTRA_KEY].isFavorited = !attachment[EXTRA_KEY].isFavorited;
                item.isFavorited = attachment[EXTRA_KEY].isFavorited;
                item.cia_msg_id = getOrCreateMessageCiaId(message);
                item.sourceCiaMsgId = item.cia_msg_id;
                item.sourceUrl = attachment.url;
                item.favoriteSourceKey = getFavoriteSourceKey(item.cia_msg_id, attachment.url);
                if (item.isFavorited) {
                    try {
                        await ensureFavoriteArchiveCopy(item, attachment, message);
                    } catch (error) {
                        attachment[EXTRA_KEY].isFavorited = false;
                        item.isFavorited = false;
                        toastr.error(t`Failed to save favorite image copy: ${String(error?.message || error)}`, 'Context Image Assistant');
                    }
                } else {
                    removeFavoriteArchiveCopy(item);
                }
            }
        }
    } else if (item.type === 'recycle') {
        const bin = getRecycleBin();
        const idx = findRecycleBinIndex(item);
        if (idx !== -1) {
            const binItem = bin[idx];
            binItem.isFavorited = !binItem.isFavorited;
            item.isFavorited = binItem.isFavorited;
            if (item.isFavorited) {
                try {
                    await ensureFavoriteArchiveCopy(item, binItem, null);
                } catch (error) {
                    binItem.isFavorited = false;
                    item.isFavorited = false;
                    toastr.error(t`Failed to save favorite image copy: ${String(error?.message || error)}`, 'Context Image Assistant');
                }
            } else {
                removeFavoriteArchiveCopy(item);
            }
            saveRecycleBin(bin);
        }
    } else if (item.type === 'favorite_archive') {
        removeFavoriteArchiveCopy(item);
        item.isFavorited = false;
    }

    invalidateGalleryData();
    hasUnsavedGalleryChanges = true;
    $(`#${PANEL_CONTAINER_ID} #cia_save_gallery, .cia-large-grid-popup-wrapper #cia_large_save_gallery`).css('display', 'inline-flex');

    const showOnlyFav = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    const isFav = !!item.isFavorited;

    // 1. Direct sidebar card DOM update to avoid full list reconstruction lag
    const sidebarCards = $(`#${PANEL_CONTAINER_ID} .cia-recycle-card[data-id="${item.id}"]`);
    if (sidebarCards.length) {
        if ((showOnlyFav && !isFav) || (item.type === 'favorite_archive' && !isFav)) {
            sidebarCards.remove();
            const grid = $(`#${PANEL_CONTAINER_ID} #cia_gallery_grid`);
            if (grid.children('.cia-recycle-card').length === 0) {
                grid.empty().append($(applyLocale('<div class="cia-recycle-empty" data-i18n="No images">No images</div>')));
            }
        } else {
            const heart = sidebarCards.find('.cia-gallery-card-heart');
            if (isFav) {
                heart.addClass('favorited').attr('title', t('Remove from favorites'));
                heart.find('i').removeClass('fa-regular').addClass('fa-solid');
            } else {
                heart.removeClass('favorited').attr('title', t('Add to favorites'));
                heart.find('i').removeClass('fa-solid').addClass('fa-regular');
            }
        }
    }

    // 2. Direct large grid popup card DOM update
    const largeGridWrapper = $('.cia-large-grid-popup-wrapper');
    const largeGridCards = largeGridWrapper.find(`.cia-recycle-card[data-id="${item.id}"]`);
    if (largeGridCards.length) {
        const largeGridMode = largeGridWrapper.attr('data-mode') || 'gallery';
        if (largeGridMode === 'gallery' && ((showOnlyFav && !isFav) || (item.type === 'favorite_archive' && !isFav))) {
            largeGridCards.remove();
            const container = largeGridWrapper.find('.cia-large-grid-container');
            if (container.children('.cia-recycle-card').length === 0) {
                container.empty().append($(applyLocale('<div class="cia-recycle-empty" style="width: 100%;" data-i18n="No images">No images</div>')));
            }
            const countEl = largeGridWrapper.find('.cia-large-grid-count');
            if (countEl.length) {
                const currentCount = parseInt(countEl.text(), 10) || 0;
                countEl.text(Math.max(0, currentCount - 1));
            }
        } else {
            const heart = largeGridCards.find('.cia-gallery-card-heart');
            if (isFav) {
                heart.addClass('favorited').attr('title', t('Remove from favorites'));
                heart.find('i').removeClass('fa-regular').addClass('fa-solid');
            } else {
                heart.removeClass('favorited').attr('title', t('Add to favorites'));
                heart.find('i').removeClass('fa-solid').addClass('fa-regular');
            }
        }
    }

    // 3. Update count display badge on settings panel
    const total = getGalleryImages().length;
    const items = getFilteredGalleryImages();
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_count`).text(isGalleryFilterActive() ? `${items.length}/${total}` : items.length);

    // 4. Update image detail view popup if open
    if (typeof window.updateGalleryDetailFavoriteUi === 'function') {
        window.updateGalleryDetailFavoriteUi(item);
    }
}

function parseFloorFilter(filterText) {
    filterText = String(filterText || '').trim().toUpperCase();
    if (!filterText) {
        return { all: true, inclusions: [], exclusions: [] };
    }

    const parts = filterText.split('\\');
    const incStr = parts[0] || '';
    const excStr = parts[1] || '';

    const parseRangeList = (str) => {
        const ranges = [];
        const tokens = str.split(',').map(s => s.trim()).filter(Boolean);
        for (const token of tokens) {
            if (token === 'ALL') {
                ranges.push({ type: 'all' });
            } else if (token === 'FAV') {
                ranges.push({ type: 'fav' });
            } else if (token === 'CUR') {
                const curVal = chat.length;
                ranges.push({ type: 'range', start: curVal, end: curVal });
            } else if (token.includes('-')) {
                const bounds = token.split('-').map(s => s.trim());
                let startStr = bounds[0];
                let endStr = bounds[1];
                let start = startStr === 'CUR' ? chat.length : parseInt(startStr, 10);
                let end = endStr === 'CUR' ? chat.length : parseInt(endStr, 10);
                if (!isNaN(start) && !isNaN(end)) {
                    ranges.push({ type: 'range', start: Math.min(start, end), end: Math.max(start, end) });
                }
            } else {
                let val = token === 'CUR' ? chat.length : parseInt(token, 10);
                if (!isNaN(val)) {
                    ranges.push({ type: 'range', start: val, end: val });
                }
            }
        }
        return ranges;
    };

    const inclusions = parseRangeList(incStr);
    const exclusions = parseRangeList(excStr);

    return { all: false, inclusions, exclusions };
}

function matchRanges(item, ranges) {
    const floorNumber = item.floorNumber;
    const isFavorited = !!item.isFavorited;
    for (const range of ranges) {
        if (range.type === 'all') {
            return true;
        }
        if (range.type === 'fav') {
            if (isFavorited) {
                return true;
            }
        }
        if (range.type === 'range') {
            if (Number.isInteger(floorNumber) && floorNumber >= range.start && floorNumber <= range.end) {
                return true;
            }
        }
    }
    return false;
}

function testIndexFilter(item, filterText) {
    if (!filterText || filterText.trim() === '') {
        return true;
    }
    const filter = parseFloorFilter(filterText);
    if (filter.all) {
        return true;
    }

    if (matchRanges(item, filter.exclusions)) {
        return false;
    }

    if (filter.inclusions.length === 0) {
        return true;
    }

    return matchRanges(item, filter.inclusions);
}

const promptInspectorUiState = {
    activeTab: 'user',
    wrap: true,
};

async function showPromptInspector() {
    const messageId = getLastAssistantMessageId();
    if (messageId === null) {
        toastr.warning(t`No character reply available to inspect.`, 'Context Image Assistant');
        return;
    }

    const buildSnapshot = () => {
        const settings = ensureSettings();
        const system = substituteParams(getPlannerSystemPrompt(settings));
        const user = substituteParams(buildUserPrompt(messageId));
        const schema = JSON.stringify(stripSchemaConstraints(getEffectiveJsonSchema(settings)), null, 2);
        const provider = settings.providerMode === 'custom_proxy'
            ? `${t`Independent Endpoint`}: ${settings.customModel || t`Model not set`}`
            : t`SillyTavern Current LLM`;
        const full = [
            `[${t`Target Floor`}] #${messageId + 1}`,
            `[${t`Request Type`}] ${t`Normal Image Generation`}`,
            `[${t`LLM Source`}] ${provider}`,
            '',
            `[${t`System Prompt`}]`,
            system,
            '',
            `[${t`User Prompt & Context`}]`,
            user,
            '',
            `[${t`JSON Schema Constraint`}]`,
            schema,
        ].join('\n');
        return {
            tabs: { user, system, schema, full },
            provider,
            messageCount: (user.match(/^#\d+\s+(?:user|assistant|system)\b/gm) || []).length,
            totalChars: system.length + user.length + schema.length,
        };
    };

    let snapshot = buildSnapshot();
    let searchCursor = -1;
    const popupContent = $(applyLocale(`
        <div class="cia-prompt-inspector-wrapper">
            <div class="cia-inspector-meta-row">
                <span><strong data-i18n="Target Floor">Target Floor</strong> #${messageId + 1}</span>
                <span><strong data-i18n="Request Type">Request Type</strong> <span data-i18n="Normal Image Generation">Normal Image Generation</span></span>
                <span class="cia-inspector-provider"><strong data-i18n="LLM Source">LLM Source</strong> <span class="cia-inspector-provider-value"></span></span>
                <span><strong data-i18n="Messages">Messages</strong> <span class="cia-inspector-message-count"></span></span>
                <span><strong data-i18n="Characters">Characters</strong> <span class="cia-inspector-char-count"></span></span>
            </div>

            <div class="cia-inspector-tabs" role="tablist">
                <button class="cia-inspector-tab" data-tab="user" type="button" data-i18n="User Message">User Message</button>
                <button class="cia-inspector-tab" data-tab="system" type="button" data-i18n="System Prompt">System Prompt</button>
                <button class="cia-inspector-tab" data-tab="schema" type="button" data-i18n="JSON Schema">JSON Schema</button>
                <button class="cia-inspector-tab" data-tab="full" type="button" data-i18n="Complete Request">Complete Request</button>
            </div>

            <div class="cia-inspector-toolbar">
                <div class="cia-inspector-jumps">
                    <button class="menu_button" data-marker="<current_interaction>" type="button" data-i18n="Current Interaction">Current Interaction</button>
                    <button class="menu_button" data-marker="<historical_interactions>" type="button" data-i18n="History">History</button>
                    <button class="menu_button" data-marker="<runtime_defaults>" type="button" data-i18n="Runtime Parameters">Runtime Parameters</button>
                </div>
                <div class="cia-inspector-tools">
                    <label class="cia-inspector-search">
                        <i class="fa-solid fa-magnifying-glass"></i>
                        <input class="text_pole cia-inspector-search-input" type="search" data-i18n="[placeholder]Search current prompt" placeholder="Search current prompt">
                        <span class="cia-inspector-search-count"></span>
                    </label>
                    <button class="cia-inspector-icon-btn cia-inspector-find-prev" type="button" data-i18n="[title]Previous match" title="Previous match"><i class="fa-solid fa-chevron-up"></i></button>
                    <button class="cia-inspector-icon-btn cia-inspector-find-next" type="button" data-i18n="[title]Next match" title="Next match"><i class="fa-solid fa-chevron-down"></i></button>
                    <button class="cia-inspector-icon-btn cia-inspector-wrap-toggle" type="button" data-i18n="[title]Toggle line wrapping" title="Toggle line wrapping"><i class="fa-solid fa-align-left"></i></button>
                    <button class="menu_button cia-inspector-copy-current" type="button"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy Current">Copy Current</span></button>
                    <button class="menu_button cia-inspector-copy-full" type="button"><i class="fa-solid fa-copy"></i> <span data-i18n="Copy Complete Request">Copy Complete Request</span></button>
                    <button class="cia-inspector-icon-btn cia-inspector-refresh" type="button" data-i18n="[title]Refresh Preview" title="Refresh Preview"><i class="fa-solid fa-arrows-rotate"></i></button>
                </div>
            </div>

            <textarea readonly spellcheck="false" class="text_pole cia-inspector-viewer"></textarea>
        </div>
    `));

    const viewer = popupContent.find('.cia-inspector-viewer');
    const searchInput = popupContent.find('.cia-inspector-search-input');
    const searchCount = popupContent.find('.cia-inspector-search-count');

    const updateMetadata = () => {
        popupContent.find('.cia-inspector-provider-value').text(snapshot.provider);
        popupContent.find('.cia-inspector-message-count').text(snapshot.messageCount);
        popupContent.find('.cia-inspector-char-count').text(snapshot.totalChars.toLocaleString());
    };

    const applyWrap = () => {
        viewer.attr('wrap', promptInspectorUiState.wrap ? 'soft' : 'off');
        viewer.toggleClass('nowrap', !promptInspectorUiState.wrap);
        popupContent.find('.cia-inspector-wrap-toggle').toggleClass('active', promptInspectorUiState.wrap);
    };

    const showTab = (tab) => {
        if (!snapshot.tabs[tab]) tab = 'user';
        promptInspectorUiState.activeTab = tab;
        searchCursor = -1;
        searchCount.text('');
        viewer.val(snapshot.tabs[tab]).scrollTop(0).scrollLeft(0);
        popupContent.find('.cia-inspector-tab').toggleClass('active', false)
            .filter(`[data-tab="${tab}"]`).toggleClass('active', true);
        popupContent.find('.cia-inspector-jumps').toggle(tab === 'user');
        applyWrap();
    };

    const selectMatch = (index, length) => {
        viewer[0].focus();
        viewer[0].setSelectionRange(index, index + length);
        const lineCount = String(viewer.val()).slice(0, index).split('\n').length;
        viewer.scrollTop(Math.max(0, lineCount * 19 - viewer.innerHeight() / 2));
    };

    const findMatch = (direction = 1) => {
        const query = String(searchInput.val() || '');
        const text = String(viewer.val() || '');
        if (!query || !text) {
            searchCursor = -1;
            searchCount.text('');
            return;
        }
        const haystack = text.toLocaleLowerCase();
        const needle = query.toLocaleLowerCase();
        const matches = [];
        let index = 0;
        while ((index = haystack.indexOf(needle, index)) >= 0) {
            matches.push(index);
            index += Math.max(1, needle.length);
        }
        if (!matches.length) {
            searchCursor = -1;
            searchCount.text(t`No matches`);
            return;
        }
        const selectionStart = viewer[0].selectionStart || 0;
        let matchIndex;
        if (direction > 0) {
            matchIndex = matches.findIndex(value => value > Math.max(searchCursor, selectionStart - 1));
            if (matchIndex < 0) matchIndex = 0;
        } else {
            const before = searchCursor < 0 ? selectionStart : searchCursor;
            matchIndex = -1;
            for (let i = matches.length - 1; i >= 0; i--) {
                if (matches[i] < before) {
                    matchIndex = i;
                    break;
                }
            }
            if (matchIndex < 0) matchIndex = matches.length - 1;
        }
        searchCursor = matches[matchIndex];
        searchCount.text(`${matchIndex + 1}/${matches.length}`);
        selectMatch(searchCursor, query.length);
    };

    const copyWithFeedback = async (button, text) => {
        if (!text) return;
        try {
            await navigator.clipboard.writeText(text);
            const icon = button.find('i');
            const label = button.find('span');
            const oldIcon = icon.attr('class');
            const oldLabel = label.text();
            icon.attr('class', 'fa-solid fa-check');
            if (label.length) label.text(t`Copied`);
            setTimeout(() => {
                icon.attr('class', oldIcon);
                if (label.length) label.text(oldLabel);
            }, 1200);
        } catch (error) {
            console.error('Failed to copy prompt inspector content:', error);
            toastr.error(t`Failed to copy.`, 'Context Image Assistant');
        }
    };

    popupContent.find('.cia-inspector-tab').on('click', function () {
        showTab(String($(this).attr('data-tab') || 'user'));
    });
    popupContent.find('.cia-inspector-jumps button').on('click', function () {
        const marker = String($(this).attr('data-marker') || '');
        const index = String(viewer.val() || '').indexOf(marker);
        if (index >= 0) selectMatch(index, marker.length);
    });
    popupContent.find('.cia-inspector-find-next').on('click', () => findMatch(1));
    popupContent.find('.cia-inspector-find-prev').on('click', () => findMatch(-1));
    searchInput.on('input', () => {
        searchCursor = -1;
        findMatch(1);
    }).on('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            findMatch(event.shiftKey ? -1 : 1);
        }
    });
    popupContent.find('.cia-inspector-wrap-toggle').on('click', () => {
        promptInspectorUiState.wrap = !promptInspectorUiState.wrap;
        applyWrap();
    });
    popupContent.find('.cia-inspector-copy-current').on('click', function () {
        copyWithFeedback($(this), String(viewer.val() || ''));
    });
    popupContent.find('.cia-inspector-copy-full').on('click', function () {
        copyWithFeedback($(this), snapshot.tabs.full);
    });
    popupContent.find('.cia-inspector-refresh').on('click', () => {
        snapshot = buildSnapshot();
        updateMetadata();
        showTab(promptInspectorUiState.activeTab);
    });

    updateMetadata();
    showTab(promptInspectorUiState.activeTab);

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, t`Prompt Inspector`, {
        okButton: t`Close`,
        cancelButton: null,
        wide: true,
        wider: true,
        leftAlign: true,
    });
    await popup.show();
}

function createContextCleanerRule() {
    return {
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        label: t`New Cleaner Rule`,
        enabled: true,
        find: '',
        replace: '',
    };
}

function getContextCleanerRuleSummary(rule) {
    switch (rule?.id) {
        case 'strip_thinking_blocks':
            return t`Removes think/thinking blocks and orphan thinking tags.`;
        case 'strip_disclaimer_interleaving':
            return t`Removes disclaimer and interleaving blocks.`;
        case 'unwrap_details_summary':
            return t`Keeps details/summary text but removes the wrapper.`;
        case 'unwrap_summary_tags':
            return t`Removes standalone summary tags.`;
        case 'strip_html_ui_noise':
            return t`Optional: removes common HTML UI wrappers.`;
        default:
            return t`Custom cleaner rule.`;
    }
}

async function openContextCleanerEditor() {
    const settings = ensureSettings();
    const rulesDraft = (Array.isArray(settings.contextCleanerRules) ? settings.contextCleanerRules : [])
        .map(rule => ({ ...rule }));

    const content = $(applyLocale(`
        <div class="cia-rules-wrapper cia-context-cleaner-editor">
            <div class="cia-rules-toolbar-row">
                <div style="display: flex; flex-direction: column; gap: 3px; min-width: 0;">
                    <div style="font-weight: 700;" data-i18n="Context Cleaner Rules">Context Cleaner Rules</div>
                    <div style="font-size: 0.86em; opacity: 0.72;" data-i18n="Context Cleaner Rules Intro">Rules run in order on planner chat history. Candidate JSON filtering is controlled by the separate context checkbox.</div>
                </div>
                <div class="cia-rules-toolbar">
                    <button id="cia_cleaner_add_rule" class="cia-icon-btn" type="button" data-i18n="[title]Add cleaner rule" title="Add cleaner rule">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button id="cia_cleaner_reset_rules" class="cia-icon-btn" type="button" data-i18n="[title]Restore default cleaner rules" title="Restore default cleaner rules">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                </div>
            </div>
            <div id="cia_cleaner_rules_list" class="cia-cleaner-rules-list"></div>
        </div>
    `));

    const renderRules = () => {
        const list = content.find('#cia_cleaner_rules_list');
        list.empty();
        if (!rulesDraft.length) {
            list.append($(applyLocale(`<div class="cia-recycle-empty" data-i18n="No cleaner rules configured.">No cleaner rules configured.</div>`)));
            return;
        }

        rulesDraft.forEach((rule, index) => {
            const summary = getContextCleanerRuleSummary(rule);
            const isDisabledClass = rule.enabled ? '' : 'disabled';
            const row = $(applyLocale(`
                <div class="cia-rule-card cia-cleaner-rule-card ${isDisabledClass}" data-index="${index}">
                    <div class="cia-rule-drag-controls">
                        <button class="cia-rule-drag-btn btn-up" type="button" title="${t('Move Up')}"><i class="fa-solid fa-chevron-up"></i></button>
                        <button class="cia-rule-drag-btn btn-down" type="button" title="${t('Move Down')}"><i class="fa-solid fa-chevron-down"></i></button>
                    </div>
                    <input type="checkbox" class="cia-cleaner-enabled cia-rule-card-checkbox" ${rule.enabled ? 'checked' : ''} title="${t('Enable/Disable rule')}" />
                    <div class="cia-rule-info">
                        <div class="cia-cleaner-main-row">
                            <input class="text_pole cia-cleaner-label" type="text" value="${escapeHtmlAttr(rule.label || '')}" aria-label="${t('Rule Name')}">
                            <span class="cia-rule-badge ${rule.enabled ? 'add' : ''}">${rule.enabled ? t`Enabled` : t`Disabled`}</span>
                        </div>
                        <div class="cia-cleaner-summary">${escapeHtml(summary)}</div>
                        <details class="cia-cleaner-advanced">
                            <summary data-i18n="Advanced Pattern">Advanced Pattern</summary>
                            <div class="cia-cleaner-advanced-grid">
                                <label class="cia-rule-form-field">
                                    <span data-i18n="Find Regex">Find Regex</span>
                                    <textarea class="text_pole cia-cleaner-find" rows="3">${escapeHtml(rule.find || '')}</textarea>
                                </label>
                                <label class="cia-rule-form-field">
                                    <span data-i18n="Replace With">Replace With</span>
                                    <textarea class="text_pole cia-cleaner-replace" rows="3">${escapeHtml(rule.replace || '')}</textarea>
                                </label>
                            </div>
                        </details>
                    </div>
                    <div class="cia-rule-actions-cell">
                        <button class="cia-icon-btn btn-delete" type="button" title="${t('Delete')}" style="color: var(--red, #cf4646);"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </div>
            `));

            row.find('.cia-cleaner-enabled').on('change', function () {
                rule.enabled = !!$(this).prop('checked');
                renderRules();
            });
            row.find('.cia-cleaner-label').on('input', function () {
                rule.label = String($(this).val() || '');
            });
            row.find('.cia-cleaner-find').on('input', function () {
                rule.find = String($(this).val() || '');
            });
            row.find('.cia-cleaner-replace').on('input', function () {
                rule.replace = String($(this).val() || '');
            });
            row.find('.btn-up').on('click', () => {
                if (index <= 0) return;
                [rulesDraft[index - 1], rulesDraft[index]] = [rulesDraft[index], rulesDraft[index - 1]];
                renderRules();
            });
            row.find('.btn-down').on('click', () => {
                if (index >= rulesDraft.length - 1) return;
                [rulesDraft[index + 1], rulesDraft[index]] = [rulesDraft[index], rulesDraft[index + 1]];
                renderRules();
            });
            row.find('.btn-delete').on('click', () => {
                rulesDraft.splice(index, 1);
                renderRules();
            });
            list.append(row);
        });
    };

    content.find('#cia_cleaner_add_rule').on('click', () => {
        rulesDraft.push(createContextCleanerRule());
        renderRules();
    });
    content.find('#cia_cleaner_reset_rules').on('click', async () => {
        const confirm = await Popup.show.confirm(t`Restore Default Cleaner Rules`, t`Replace current cleaner rules with the default rule set?`);
        if (!confirm) return;
        rulesDraft.splice(0, rulesDraft.length, ...DEFAULT_CONTEXT_CLEANER_RULES.map(rule => ({ ...rule })));
        renderRules();
    });

    renderRules();

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, t`Configure Context Cleaner`, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        leftAlign: true,
        onClosing: async (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }
            for (const rule of rulesDraft) {
                if (!String(rule.find || '').trim()) {
                    toastr.error(t`Cleaner rule pattern cannot be empty.`, 'Context Image Assistant');
                    return false;
                }
                try {
                    compileCleanerRule(rule);
                } catch (error) {
                    toastr.error(`${rule.label || rule.id}: ${String(error?.message || error)}`, 'Context Image Assistant');
                    return false;
                }
            }
            settings.contextCleanerRules = rulesDraft.map((rule, index) => ({
                id: String(rule.id || `rule_${Date.now()}_${index}`),
                label: String(rule.label || `Rule ${index + 1}`),
                enabled: !!rule.enabled,
                find: String(rule.find || ''),
                replace: String(rule.replace || ''),
            }));
            saveSettingsDebounced();
            return true;
        },
    });
    await popup.show();
}

async function showCleanContextPreview() {
    const messageId = getLastAssistantMessageId();
    if (messageId === null) {
        toastr.warning(t`No character reply available to inspect.`, 'Context Image Assistant');
        return;
    }

    const result = buildCleanPlannerContext(messageId);
    const removedChars = Math.max(0, result.originalChars - result.cleanedChars);
    const reductionPercent = result.originalChars > 0 ? Math.round((removedChars / result.originalChars) * 100) : 0;
    const ruleStatsText = Object.keys(result.ruleHits || {}).length
        ? Object.entries(result.ruleHits).map(([id, stat]) => {
            const error = result.ruleErrors?.[id] ? ` (${t`Error`}: ${result.ruleErrors[id]})` : '';
            return `${stat.label}: ${stat.hits}${error}`;
        }).join('\n')
        : t`Context cleaner disabled or no rules enabled.`;

    const popupContent = $(applyLocale(`
        <div class="cia-clean-context-wrapper" style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; flex-wrap: wrap;">
                <div style="font-size: 0.95em; opacity: 0.85;" data-i18n="Clean Planner Context Intro">Preview the conversation context after removing hidden thinking blocks, summary UI wrappers, and code/HTML noise.</div>
                <button class="menu_button cia-copy-btn" data-target="#cia_clean_context_output" type="button" title="Copy Cleaned Context" data-i18n="[title]Copy Cleaned Context" style="margin: 0; padding: 4px 10px; width: auto; min-height: 28px; display: inline-flex; align-items: center; gap: 6px;">
                    <i class="fa-solid fa-copy"></i> <span data-i18n="Copy Cleaned Context">Copy Cleaned Context</span>
                </button>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px;">
                <div style="background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 0.78em; opacity: 0.65;" data-i18n="Messages">Messages</div>
                    <div style="font-weight: 700;">${result.messageCount}</div>
                </div>
                <div style="background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 0.78em; opacity: 0.65;" data-i18n="Changed Messages">Changed Messages</div>
                    <div style="font-weight: 700;">${result.changedMessages}</div>
                </div>
                <div style="background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 0.78em; opacity: 0.65;" data-i18n="Removed Characters">Removed Characters</div>
                    <div style="font-weight: 700;">${removedChars} (${reductionPercent}%)</div>
                </div>
                <div style="background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 8px 10px;">
                    <div style="font-size: 0.78em; opacity: 0.65;" data-i18n="Context Limit">Context Limit</div>
                    <div style="font-weight: 700;">${result.truncated ? t`Truncated` : t`Full`}</div>
                </div>
            </div>

            <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-weight: 600;" data-i18n="Rule Match Summary">Rule Match Summary</span>
                <textarea readonly id="cia_clean_context_rule_stats" class="text_pole cia-clean-context-stats"></textarea>
            </div>

            <div class="cia-clean-context-grid">
                <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px; min-width: 0;">
                    <span style="font-weight: 600;" data-i18n="Cleaned Context">Cleaned Context</span>
                    <textarea readonly id="cia_clean_context_output" class="text_pole cia-clean-context-text"></textarea>
                </div>
                <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px; min-width: 0;">
                    <span style="font-weight: 600;" data-i18n="Original Context">Original Context</span>
                    <textarea readonly id="cia_clean_context_original" class="text_pole cia-clean-context-text"></textarea>
                </div>
            </div>
        </div>
    `));

    popupContent.find('#cia_clean_context_output').val(result.cleanedContext);
    popupContent.find('#cia_clean_context_original').val(result.rawContext);
    popupContent.find('#cia_clean_context_rule_stats').val(ruleStatsText);
    popupContent.find('.cia-copy-btn').on('click', function () {
        const targetId = $(this).attr('data-target');
        const textVal = popupContent.find(targetId).val();
        if (textVal) {
            navigator.clipboard.writeText(textVal).then(() => {
                toastr.success(t`Copied to clipboard!`, 'Context Image Assistant');
            }).catch(err => {
                console.error('Failed to copy: ', err);
            });
        }
    });

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, t`Clean Planner Context`, {
        okButton: t`Close`,
        cancelButton: null,
        wide: true,
        wider: true,
    });
    await popup.show();
}

function showGalleryFilterHelp() {
    const helpContent = $(applyLocale(`
        <div class="cia-filter-help-wrapper" style="font-size: 0.92em; line-height: 1.6; max-height: 70vh; overflow-y: auto; padding: 10px 15px; color: var(--text-color); font-family: system-ui, -apple-system, sans-serif;">
            <p style="margin-top: 0; opacity: 0.85; font-size: 1.05em;" data-i18n="Filter Help Intro">You can configure the floor filter using the following rules to locate images generated in the chat:</p>

            <div style="display: flex; flex-direction: column; gap: 12px; margin: 16px 0;">
                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;">
                        <span data-i18n="Basic Match">Basic Match</span>
                        <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; font-family: monospace;">3</code>
                    </div>
                    <div style="opacity: 0.8; font-size: 0.9em;" data-i18n="Basic Match Desc">Only show images generated at floor 3.</div>
                </div>

                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;">
                        <span data-i18n="Range Match">Range Match</span>
                        <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; font-family: monospace;">1-5</code>
                    </div>
                    <div style="opacity: 0.8; font-size: 0.9em;" data-i18n="Range Match Desc">Show all images within the floor range [1, 5].</div>
                </div>

                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;">
                        <span data-i18n="Keywords">Keywords</span>
                        <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; font-family: monospace;">ALL / CUR / FAV</code>
                    </div>
                    <div style="opacity: 0.8; font-size: 0.9em;" data-i18n="[html]Keywords Desc"><code>ALL</code> represents all floors; <code>CUR</code> represents the current latest floor; <code>FAV</code> represents favorited images.</div>
                </div>

                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;">
                        <span data-i18n="Merge Union (Comma)">Union Match (Comma)</span>
                        <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; font-family: monospace;">1-3, 5, CUR, FAV</code>
                    </div>
                    <div style="opacity: 0.8; font-size: 0.9em;" data-i18n="Merge Union Desc">Match the union of multiple conditions (i.e., satisfying any of them is sufficient).</div>
                </div>

                <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.06); border-radius: 6px; padding: 10px 14px;">
                    <div style="display: flex; align-items: center; justify-content: space-between; font-weight: 600; color: var(--SmartThemeQuoteColor, #78beff); margin-bottom: 4px;">
                        <span data-i18n="Exclude Difference (Double Slash)">Exclude Difference (Double Slash)</span>
                        <code style="background: rgba(0,0,0,0.3); padding: 2px 6px; border-radius: 4px; font-size: 0.85em; font-family: monospace;">ALL \\\\ CUR</code>
                    </div>
                    <div style="opacity: 0.8; font-size: 0.9em;">
                        <span data-i18n="[html]Exclude Difference Desc">Use <code>\\</code> to exclude. For example:</span>
                        <ul style="margin: 6px 0 0 16px; padding: 0; opacity: 0.9; font-size: 0.92em; display: flex; flex-direction: column; gap: 4px;">
                            <li data-i18n="[html]Exclude Example 1"><code style="font-family: monospace;">1-10 \\\\ 5</code> : Matches floors 1 to 10, but excludes floor 5.</li>
                            <li data-i18n="[html]Exclude Example 2"><code style="font-family: monospace;">ALL \\\\ CUR</code> : Matches all historical images except the current latest floor.</li>
                            <li data-i18n="[html]Exclude Example 3"><code style="font-family: monospace;">ALL \\\\ FAV</code> : Matches all historical images except favorited ones.</li>
                            <li data-i18n="[html]Exclude Example 4"><code style="font-family: monospace;">1-10 \\\\ 3-5</code> : Matches floors 1 to 10, but excludes floors 3 to 5.</li>
                        </ul>
                    </div>
                </div>
            </div>

            <p style="margin-bottom: 0; opacity: 0.7; font-size: 0.85em; text-align: center;" data-i18n="Filter Help Outro">💡 Note: Input is case-insensitive and ignores spaces.</p>
        </div>
    `));
    new Popup(helpContent, POPUP_TYPE.TEXT, t`Floor Filter Explanation`, { okButton: t`I see` }).show();
}

let currentGalleryItems = [];
let hasUnsavedGalleryChanges = false;
let galleryListRenderVersion = 0;
let recycleListRenderVersion = 0;

function appendGalleryCardsInBatches(container, items, createCard, isCurrent, batchSize = 40) {
    let index = 0;
    const appendBatch = () => {
        if (!isCurrent() || !container[0]) return;
        const fragment = document.createDocumentFragment();
        const end = Math.min(items.length, index + batchSize);
        for (; index < end; index++) {
            const card = createCard(items[index]);
            if (card?.[0]) fragment.appendChild(card[0]);
        }
        container[0].appendChild(fragment);
        if (index < items.length) {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(appendBatch);
            } else {
                setTimeout(appendBatch, 0);
            }
        }
    };
    appendBatch();
}

async function showGalleryImageDetail(itemId, items = null) {
    if (Array.isArray(items)) {
        currentGalleryItems = items;
    }
    let index = currentGalleryItems.findIndex(x => x.id === itemId);
    if (index === -1) {
        return;
    }
    const renderModalContent = (item) => {
        const parsedData = item[EXTRA_KEY] || {};
        const isFavorited = !!item.isFavorited;

        let floorInfo = '';
        if (item.type === 'active') {
            floorInfo = t`Floor: #${item.floorNumber || item.msgId + 1}`;
        } else if (item.type === 'favorite_archive') {
            floorInfo = item.floorNumber ? t`Floor: #${item.floorNumber} (Favorited Copy)` : t`Favorited Copy (Original floor deleted)`;
        } else {
            floorInfo = item.floorNumber ? t`Floor: #${item.floorNumber} (Recycled)` : t`Recycled (Original floor deleted)`;
        }

        const positivePrompt = item.title || getCandidatePositivePrompt(parsedData);
        const negativePrompt = item.negative || getCandidateNegativePrompt(parsedData);
        const settings = ensureSettings();
        const numericProps = getNumericSchemaProperties(settings);
        const loraObj = {};
        for (const prop of numericProps) {
            loraObj[prop.key] = getCandidateStrength(parsedData, prop.key, prop.default);
        }
        const fullParamsJson = {
            prompt: positivePrompt,
            negative_prompt: negativePrompt,
            lora_parameters: loraObj,
        };

        let loraRowsHtml = '';
        for (const prop of numericProps) {
            loraRowsHtml += `
                <div style="display: flex; justify-content: space-between; opacity: 0.85; padding: 2px 0;">
                    <span>${escapeHtml(prop.title || prop.key)} (${escapeHtml(prop.key)}):</span>
                    <span style="font-family: monospace; font-weight: 600; color: #78beff;">${escapeHtml(loraObj[prop.key])}</span>
                </div>
            `;
        }

        const content = $(applyLocale(`
            <div class="cia-detail-popup-container">
                <!-- Left Column: Image Preview -->
                <div class="cia-detail-left-col">
                    <div class="cia-detail-img-wrapper">
                        <button class="cia-detail-nav btn-prev" type="button" title="Previous" data-i18n="[title]Previous"><i class="fa-solid fa-chevron-left"></i></button>
                        <img src="${escapeHtmlAttr(item.url)}" class="cia-detail-img" />
                        <button class="cia-detail-nav btn-next" type="button" title="Next" data-i18n="[title]Next"><i class="fa-solid fa-chevron-right"></i></button>
                    </div>
                    <div class="cia-detail-index-indicator">
                        ${index + 1} / ${currentGalleryItems.length}
                    </div>
                </div>

                <!-- Right Column: Read-Only Info & Copy Tools -->
                <div class="cia-detail-right-col">
                    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.08); padding-bottom: 8px;">
                        <span style="font-size: 1.1em; font-weight: 600;" data-i18n="Image Details">Image Details</span>
                        <div style="display: flex; align-items: center; gap: 10px;">
                            <span style="font-size: 0.85em; opacity: 0.6;">${escapeHtml(floorInfo)}</span>
                            <button class="menu_button btn-copy-full-json" type="button" title="Copy all parameters as full JSON" data-i18n="[title]Copy all parameters as full JSON" style="margin:0; padding:0; width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center;">
                                <i class="fa-solid fa-file-code"></i>
                            </button>
                            <button class="menu_button btn-fav-toggle" type="button" title="${isFavorited ? t('Remove from favorites') : t('Add to favorites')}" style="margin:0; padding:0; width:30px; height:30px; min-height:30px; display:inline-flex; align-items:center; justify-content:center;">
                                <i class="${isFavorited ? 'fa-solid' : 'fa-regular'} fa-heart" style="color: ${isFavorited ? 'var(--red, #cf4646)' : 'inherit'};"></i>
                            </button>
                        </div>
                    </div>

                    <div style="flex-grow: 1; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; padding-right: 4px;">
                        <!-- Positive Prompt -->
                        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center;">
                                <span data-i18n="Positive Prompt (Positive)">Positive Prompt (Positive)</span>
                                <button class="menu_button btn-copy-pos" type="button" title="Copy positive prompt" data-i18n="[title]Copy positive prompt" style="margin:0; padding:0; width:26px; height:26px; min-height:26px; display:inline-flex; align-items:center; justify-content:center;"><i class="fa-solid fa-copy"></i></button>
                            </div>
                            <textarea class="text_pole" style="height: 80px; resize: none; font-size: 0.82em; background: rgba(0,0,0,0.2); color: #c0c0c0;" readonly>${escapeHtml(positivePrompt)}</textarea>
                        </div>

                        <!-- Negative Prompt -->
                        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px;">
                            <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center;">
                                <span data-i18n="Negative Prompt (Negative)">Negative Prompt (Negative)</span>
                                <button class="menu_button btn-copy-neg" type="button" title="Copy negative prompt" data-i18n="[title]Copy negative prompt" style="margin:0; padding:0; width:26px; height:26px; min-height:26px; display:inline-flex; align-items:center; justify-content:center;"><i class="fa-solid fa-copy"></i></button>
                            </div>
                            <textarea class="text_pole" style="height: 60px; resize: none; font-size: 0.82em; background: rgba(0,0,0,0.2); color: #c0c0c0;" readonly>${escapeHtml(negativePrompt)}</textarea>
                        </div>

                        <!-- LoRA parameters -->
                        <div style="background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.04); border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px;">
                            <div style="font-size: 0.82em; font-weight: 600; opacity: 0.85; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.05); padding-bottom: 4px;">
                                <span data-i18n="LoRA Parameter Weights">LoRA Parameter Weights</span>
                                <button class="menu_button btn-copy-lora" type="button" title="Copy LoRA parameters JSON" data-i18n="[title]Copy LoRA parameters JSON" style="margin:0; padding:0; width:26px; height:26px; min-height:26px; display:inline-flex; align-items:center; justify-content:center;"><i class="fa-solid fa-copy"></i></button>
                            </div>

                            <div style="display: flex; flex-direction: column; gap: 4px; font-size: 0.82em;">
                                ${loraRowsHtml}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `));

        content.find('.btn-prev').on('click', () => {
            index = (index - 1 + currentGalleryItems.length) % currentGalleryItems.length;
            const prevItem = currentGalleryItems[index];
            updateModal(prevItem);
        });

        content.find('.btn-next').on('click', () => {
            index = (index + 1) % currentGalleryItems.length;
            const nextItem = currentGalleryItems[index];
            updateModal(nextItem);
        });

        content.find('.btn-fav-toggle').on('click', async function () {
            const currentItem = currentGalleryItems[index];
            await toggleGalleryFavorite(currentItem);
        });

        content.find('.cia-detail-img').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            openDetailImageLightbox(item.url);
        });

        content.find('.btn-copy-full-json').on('click', () => {
            navigator.clipboard.writeText(JSON.stringify(fullParamsJson, null, 2));
            toastr.success(t`Full JSON config copied to clipboard.`, 'Context Image Assistant');
        });
        content.find('.btn-copy-pos').on('click', () => {
            navigator.clipboard.writeText(positivePrompt);
            toastr.success(t`Positive prompt copied to clipboard.`, 'Context Image Assistant');
        });
        content.find('.btn-copy-neg').on('click', () => {
            navigator.clipboard.writeText(negativePrompt);
            toastr.success(t`Negative prompt copied to clipboard.`, 'Context Image Assistant');
        });
        content.find('.btn-copy-lora').on('click', () => {
            navigator.clipboard.writeText(JSON.stringify(loraObj, null, 2));
            toastr.success(t`LoRA weights JSON copied to clipboard.`, 'Context Image Assistant');
        });

        return content;
    };

    let modalInstance = null;

    const getModalRoot = () => $(modalInstance?.dlg || []);

    const openDetailImageLightbox = (imageUrl) => {
        const modalRoot = getModalRoot();
        if (!modalRoot.length) {
            return;
        }

        modalRoot.find('.cia-fullscreen-overlay').remove();
        const overlay = $(applyLocale(`
            <div class="cia-fullscreen-overlay" role="button" tabindex="0" title="Click to close image" data-i18n="[title]Click to close image">
                <button class="cia-fullscreen-close" type="button" title="Close" data-i18n="[title]Close"><i class="fa-solid fa-xmark"></i></button>
                <img src="${escapeHtmlAttr(imageUrl)}" class="cia-fullscreen-img" />
            </div>
        `));
        const closeOverlay = () => {
            overlay.addClass('closing');
            setTimeout(() => overlay.remove(), 95);
        };
        overlay.on('click keydown', (event) => {
            if (event.type === 'keydown' && event.key !== 'Escape' && event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            closeOverlay();
        });
        overlay.find('.cia-fullscreen-close').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeOverlay();
        });
        modalRoot.append(overlay);
        overlay.trigger('focus');
    };

    const updateModal = (newItem) => {
        if (!modalInstance) return;
        const newContent = renderModalContent(newItem);
        getModalRoot().find('.popup-content').empty().append(newContent);
    };

    window.updateGalleryDetailFavoriteUi = (updatedItem) => {
        if (!modalInstance) return;
        const heartBtn = getModalRoot().find('.btn-fav-toggle');
        const heartIcon = heartBtn.find('i');
        if (updatedItem.isFavorited) {
            heartIcon.removeClass('fa-regular').addClass('fa-solid').css('color', 'var(--red, #cf4646)');
            heartBtn.attr('title', t('Remove from favorites'));
        } else {
            heartIcon.removeClass('fa-solid').addClass('fa-regular').css('color', 'inherit');
            heartBtn.attr('title', t('Add to favorites'));
        }
    };

    const initialContent = renderModalContent(currentGalleryItems[index]);
    modalInstance = new Popup(initialContent, POPUP_TYPE.TEXT, null, {
        okButton: t`Close`,
        cancelButton: null,
        wide: true,
        wider: true,
        large: true,
        onClose: async () => {
            if (hasUnsavedGalleryChanges) {
                hasUnsavedGalleryChanges = false;
                $(`#${PANEL_CONTAINER_ID} #cia_save_gallery`).hide();
                await saveChatConditional();
                toastr.success(t`All favorite statuses automatically saved.`, 'Context Image Assistant');
            }
        },
    });

    const handleKeyDown = (e) => {
        if (e.key === 'ArrowLeft') {
            getModalRoot().find('.btn-prev').trigger('click');
        } else if (e.key === 'ArrowRight') {
            getModalRoot().find('.btn-next').trigger('click');
        }
    };
    $(document).on('keydown', handleKeyDown);

    await modalInstance.show();

    $(document).off('keydown', handleKeyDown);
    modalInstance = null;
    window.updateGalleryDetailFavoriteUi = null;
}

async function showGalleryLargeGridPreview(mode = 'gallery') {
    const settings = ensureSettings();
    let columns = settings.largeGridColumns || 3;
    const galleryUiState = getGalleryUiState();

    const popupContent = $(applyLocale(`
        <div class="cia-large-grid-popup-wrapper" data-mode="${escapeHtmlAttr(mode)}" style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
            <div class="cia-large-grid-toolbar" style="display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;">
                <span>${mode === 'gallery' ? t('Gallery Fullscreen Grid') : t('Recycle Bin Fullscreen Grid')} (<span class="cia-large-grid-count">0</span>)</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    ${mode === 'gallery' ? `
                    <button id="cia_large_save_gallery" class="menu_button" type="button" title="Save manual gallery changes" data-i18n="[title]Save manual gallery changes" style="margin: 0; padding: 2px 8px; font-size: 0.82em; height: auto; width: auto; min-height: 24px; display: ${hasUnsavedGalleryChanges ? 'inline-flex' : 'none'}; align-items: center; gap: 4px; background: var(--SmartThemeQuoteColor, #78beff); color: #000; font-weight: bold;">
                        <i class="fa-solid fa-floppy-disk"></i> <span data-i18n="Save Changes">Save Changes</span>
                    </button>
                    ` : ''}
                    <div class="cia-large-grid-column-picker" title="Images per row" data-i18n="[title]Images per row" style="display: flex; align-items: center; gap: 4px;">
                        <span style="font-size: 0.72em; font-weight: 500; opacity: 0.65; padding: 0 4px;" data-i18n="Per Row">Per Row</span>
                        ${[2, 3, 4, 5, 6, 7, 8].map(value => `
                            <button class="menu_button cia-grid-col-btn ${value === columns ? 'active' : ''}" type="button" data-cols="${value}">${value}</button>
                        `).join('')}
                    </div>
                </div>
            </div>
            ${mode === 'gallery' ? `
            <!-- Gallery Filter Bar in Popup -->
            <div class="cia-filter-bar" style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 6px; background: rgba(0,0,0,0.15); border-radius: 6px; border: 1px solid rgba(255,255,255,0.03); margin-top: 4px;">
                <label class="checkbox_label" for="cia_large_filter_fav" style="margin: 0; padding: 4px 8px; font-size: 0.82em; min-height: auto; width: auto; display: inline-flex; align-items: center; gap: 6px; background: rgba(255, 255, 255, 0.02); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 4px; cursor: pointer;">
                    <span data-i18n="Favorites Only">Favorites Only</span>
                    <input type="checkbox" id="cia_large_filter_fav" class="checkbox" style="margin: 0;">
                </label>
                <label class="cia-large-sort-select" for="cia_large_sort_direction" title="Sort by floor" data-i18n="[title]Sort by floor" style="display: flex; align-items: center; gap: 6px; margin: 0; min-width: 150px;">
                    <span style="font-size: 0.82em; opacity: 0.8; white-space: nowrap;" data-i18n="Sort:">Sort:</span>
                    <select id="cia_large_sort_direction" class="text_pole" style="margin: 0; height: 26px; font-size: 0.82em; padding: 2px 6px;">
                        <option value="asc" ${galleryUiState.sortDirection === 'asc' ? 'selected' : ''} data-i18n="Floor Ascending">Floor Ascending</option>
                        <option value="desc" ${galleryUiState.sortDirection === 'desc' ? 'selected' : ''} data-i18n="Floor Descending">Floor Descending</option>
                    </select>
                </label>
                <div style="display: flex; align-items: center; gap: 6px; flex-grow: 1; min-width: 180px;">
                    <span style="font-size: 0.82em; opacity: 0.8; white-space: nowrap;" data-i18n="Floor Filter:">Floor Filter:</span>
                    <input type="text" id="cia_large_filter_floor" class="text_pole" placeholder="e.g., 1-5, CUR \\\\ 3 (click ? on right)" data-i18n="[placeholder]e.g., 1-5, CUR \\\\ 3 (click ? on right)" style="margin: 0; height: 26px; font-size: 0.82em; padding: 2px 6px; flex-grow: 1;">
                    <button id="cia_large_filter_help" class="menu_button" type="button" title="View floor filter guide" data-i18n="[title]Filter Help" style="margin: 0; padding: 0; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 50%; font-size: 0.82em; flex-shrink: 0;">
                        <i class="fa-solid fa-circle-question"></i>
                    </button>
                </div>
            </div>
            ` : ''}
            <div class="cia-large-grid-container" style="--cia-large-grid-cols: ${columns};">
                <!-- Cards will render here -->
            </div>
        </div>
    `));

    const container = popupContent.find('.cia-large-grid-container');
    let renderCardsVersion = 0;

    const renderCards = () => {
        const renderVersion = ++renderCardsVersion;
        const currentItems = mode === 'gallery' ? sortGalleryItemsForLargeGrid(getFilteredGalleryImages()) : getFilteredRecycleImages();
        popupContent.find('.cia-large-grid-count').text(currentItems.length);
        container.empty();

        if (currentItems.length === 0) {
            container.append($(applyLocale('<div class="cia-recycle-empty" style="width: 100%;" data-i18n="No images">No images</div>')));
            return;
        }

        appendGalleryCardsInBatches(container, currentItems, (item) => {
            const isFavorited = !!item.isFavorited;
            const card = $(applyLocale(`
                <div class="cia-recycle-card cia-large-card" data-id="${escapeHtmlAttr(item.id)}">
                    <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" loading="lazy" decoding="async" />
                    ${mode === 'gallery' ? `
                        <div class="cia-gallery-card-heart ${isFavorited ? 'favorited' : ''}" title="${isFavorited ? t('Remove from favorites') : t('Add to favorites')}">
                            <i class="${isFavorited ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                        </div>
                    ` : ''}
                    <div class="cia-recycle-actions">
                        ${mode === 'gallery' && item.type === 'active' ? `
                            <button class="cia-recycle-btn btn-delete btn-recycle-active" type="button" title="Move to Recycle Bin" data-i18n="[title]Move to Recycle Bin"><i class="fa-solid fa-trash-can"></i></button>
                        ` : ''}
                        ${mode === 'recycle' ? `
                            <button class="cia-recycle-btn btn-restore" type="button" title="Restore to original floor" data-i18n="[title]Restore to original floor"><i class="fa-solid fa-arrow-rotate-left"></i></button>
                            <button class="cia-recycle-btn btn-delete" type="button" title="Permanently delete from disk" data-i18n="[title]Permanently delete from disk"><i class="fa-solid fa-trash-can"></i></button>
                        ` : ''}
                    </div>
                    <div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); font-size: 0.76em; padding: 4px 6px; display: flex; justify-content: center; pointer-events: none;">
                        <span style="opacity: 0.85;">${item.type === 'active' ? t`Floor #${item.floorNumber || item.msgId + 1}` : (item.type === 'favorite_archive' ? t`Favorited Copy` : t`Recycled`)}</span>
                    </div>
                </div>
            `));

            card.find('.cia-gallery-card-heart').on('click', async (e) => {
                e.stopPropagation();
                await toggleGalleryFavorite(item);
            });

            if (mode === 'gallery') {
                card.find('.btn-recycle-active').on('click', async (e) => {
                    e.stopPropagation();
                    const confirm = await Popup.show.confirm(t`Move to Recycle Bin`, t`Confirm moving this image to the Recycle Bin?`);
                    if (confirm) {
                        await recycleActiveGalleryItem(item);
                    }
                });
            }

            if (mode === 'recycle') {
                card.find('.btn-restore').on('click', async (e) => {
                    e.stopPropagation();
                    const confirm = await Popup.show.confirm(t`Confirm Restore`, t`Do you want to restore this image to its original floor?`);
                    if (confirm) {
                        await restoreRecycleItem(item);
                        card.remove();
                        const countEl = popupContent.find('.cia-large-grid-count');
                        if (countEl.length) {
                            const currentCount = parseInt(countEl.text(), 10) || 0;
                            countEl.text(Math.max(0, currentCount - 1));
                        }
                    }
                });

                card.find('.btn-delete').on('click', async (e) => {
                    e.stopPropagation();
                    const confirm = await Popup.show.confirm(t`Permanently Delete`, t`Are you sure you want to permanently physically delete this image? This action is irreversible.`);
                    if (confirm) {
                        await deleteRecycleItem(item);
                        card.remove();
                        const countEl = popupContent.find('.cia-large-grid-count');
                        if (countEl.length) {
                            const currentCount = parseInt(countEl.text(), 10) || 0;
                            countEl.text(Math.max(0, currentCount - 1));
                        }
                    }
                });
            }

            card.on('click', () => {
                showGalleryImageDetail(item.id, currentItems);
            });

            return card;
        }, () => renderCardsVersion === renderVersion);
    };

    // Initialize inputs & sync if mode === 'gallery'
    if (mode === 'gallery') {
        const sidebarFav = $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
        const sidebarFloor = $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val();
        popupContent.find('#cia_large_filter_fav').prop('checked', sidebarFav);
        popupContent.find('#cia_large_filter_floor').val(sidebarFloor);

        popupContent.find('#cia_large_filter_fav').on('change', function () {
            const checked = $(this).prop('checked');
            $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked', checked).trigger('change');
            renderCards();
        });

        popupContent.find('#cia_large_filter_floor').on('input', function () {
            const val = $(this).val();
            $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val(val).trigger('input');
            renderCards();
        });

        popupContent.find('#cia_large_filter_help').on('click', () => {
            showGalleryFilterHelp();
        });

        popupContent.find('#cia_large_sort_direction').on('change', function () {
            saveGallerySortDirection(String($(this).val() || 'asc'));
            renderCards();
        });

        popupContent.find('#cia_large_save_gallery').on('click', async function () {
            if (hasUnsavedGalleryChanges) {
                hasUnsavedGalleryChanges = false;
                $(`#${PANEL_CONTAINER_ID} #cia_save_gallery, .cia-large-grid-popup-wrapper #cia_large_save_gallery`).hide();
                await saveChatConditional();
                toastr.success(t`All favorite statuses successfully saved.`, 'Context Image Assistant');
            }
        });
    }

    // Load cards initially
    renderCards();

    popupContent.find('.cia-grid-col-btn').on('click', function () {
        columns = clampInteger($(this).attr('data-cols'), 2, 8, 3);
        popupContent.find('.cia-grid-col-btn').removeClass('active');
        $(this).addClass('active');
        container.css('--cia-large-grid-cols', columns);
        settings.largeGridColumns = columns;
        saveSettingsDebounced();
    });

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, null, {
        okButton: t`Close`,
        cancelButton: null,
        wide: true,
        wider: true,
        large: true,
        onClose: async () => {
            if (hasUnsavedGalleryChanges) {
                hasUnsavedGalleryChanges = false;
                $(`#${PANEL_CONTAINER_ID} #cia_save_gallery`).hide();
                await saveChatConditional();
                toastr.success(t`All favorite statuses automatically saved.`, 'Context Image Assistant');
            }
        },
    });
    await popup.show();
}

function renderGalleryList() {
    const renderVersion = ++galleryListRenderVersion;
    const total = getGalleryImages().length;
    const items = getFilteredGalleryImages();
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_count`).text(isGalleryFilterActive() ? `${items.length}/${total}` : items.length);

    const settings = ensureSettings();
    if (settings.galleryCollapsed) {
        $(`#${PANEL_CONTAINER_ID} #cia_gallery_grid`).empty();
        return;
    }

    const grid = $(`#${PANEL_CONTAINER_ID} #cia_gallery_grid`);
    grid.empty();

    currentGalleryItems = items;

    if (items.length === 0) {
        grid.append($(applyLocale('<div class="cia-recycle-empty" data-i18n="No images">No images</div>')));
        return;
    }

    appendGalleryCardsInBatches(grid, items, item => {
        const isFavorited = !!item.isFavorited;
        const card = $(applyLocale(`
            <div class="cia-recycle-card" data-id="${escapeHtmlAttr(item.id)}">
                <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" loading="lazy" decoding="async" />
                <div class="cia-gallery-card-heart ${isFavorited ? 'favorited' : ''}" title="${isFavorited ? t('Remove from favorites') : t('Add to favorites')}">
                    <i class="${isFavorited ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                </div>
                <div class="cia-recycle-actions">
                    ${item.type === 'active' ? '<button class="cia-recycle-btn btn-delete btn-recycle-active" type="button" title="Move to Recycle Bin" data-i18n="[title]Move to Recycle Bin"><i class="fa-solid fa-trash-can"></i></button>' : ''}
                </div>
            </div>
        `));

        card.find('.cia-gallery-card-heart').on('click', async (e) => {
            e.stopPropagation();
            await toggleGalleryFavorite(item);
        });

        card.find('.btn-recycle-active').on('click', async (e) => {
            e.stopPropagation();
            const confirm = await Popup.show.confirm(t`Move to Recycle Bin`, t`Confirm moving this image to the Recycle Bin?`);
            if (confirm) {
                await recycleActiveGalleryItem(item);
            }
        });

        card.on('click', () => {
            showGalleryImageDetail(item.id, items);
        });

        return card;
    }, () => galleryListRenderVersion === renderVersion);
}

function renderRecycleBinList() {
    const renderVersion = ++recycleListRenderVersion;
    const items = getFilteredRecycleImages();
    $(`#${PANEL_CONTAINER_ID} #cia_recycle_count`).text(items.length);

    const settings = ensureSettings();
    if (settings.recycleCollapsed) {
        $(`#${PANEL_CONTAINER_ID} #cia_recycle_grid`).empty();
        return;
    }

    const grid = $(`#${PANEL_CONTAINER_ID} #cia_recycle_grid`);
    grid.empty();

    if (items.length === 0) {
        grid.append($(applyLocale('<div class="cia-recycle-empty" data-i18n="Recycle bin is empty">Recycle bin is empty</div>')));
        return;
    }

    appendGalleryCardsInBatches(grid, items, item => {
        const card = $(applyLocale(`
            <div class="cia-recycle-card" data-id="${escapeHtmlAttr(item.id)}">
                <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" loading="lazy" decoding="async" />
                <div class="cia-recycle-actions">
                    <button class="cia-recycle-btn btn-restore" type="button" title="Restore to original floor" data-i18n="[title]Restore to original floor"><i class="fa-solid fa-arrow-rotate-left"></i></button>
                    <button class="cia-recycle-btn btn-delete" type="button" title="Permanently delete" data-i18n="[title]Permanently delete"><i class="fa-solid fa-trash-can"></i></button>
                </div>
            </div>
        `));

        card.find('.btn-restore').on('click', async (e) => {
            e.stopPropagation();
            await restoreRecycleItem(item);
        });

        card.find('.btn-delete').on('click', async (e) => {
            e.stopPropagation();
            const confirm = await Popup.show.confirm(t`Permanently Delete`, t`Are you sure you want to permanently delete this image from disk? This action is irreversible.`);
            if (confirm) {
                await deleteRecycleItem(item);
            }
        });

        card.on('click', () => {
            showGalleryImageDetail(item.id, items);
        });

        return card;
    }, () => recycleListRenderVersion === renderVersion);
}

async function getAvatarBase64(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            return PNG_PIXEL;
        }
        const avatarBlob = await response.blob();
        const avatarBase64DataUrl = await getBase64Async(avatarBlob);
        return avatarBase64DataUrl.split(',')[1] || PNG_PIXEL;
    } catch {
        return PNG_PIXEL;
    }
}

function attachImageToMessage(messageId, candidate, result) {
    const message = chat[messageId];
    if (!message) {
        return;
    }

    const format = String(result?.format || 'png').toLowerCase();
    const imageData = String(result?.data || '');
    if (!imageData) {
        throw new Error(t`ComfyUI returned no image data.`);
    }

    const extraMeta = {
        prompt: candidate.prompt,
        negative_prompt: candidate.negative_prompt || '',
    };
    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    for (const prop of numericProps) {
        extraMeta[prop.key] = candidate[prop.key];
    }

    message.extra ??= {};
    message.extra.media ??= [];
    message.extra.media.push({
        url: `data:image/${format};base64,${imageData}`,
        type: MEDIA_TYPE.IMAGE,
        title: candidate.prompt,
        negative: candidate.negative_prompt || extension_settings.sd?.negative_prompt || '',
        generation_type: MODULE_NAME,
        source: MEDIA_SOURCE.GENERATED,
        [EXTRA_KEY]: extraMeta,
    });
    message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.inline_image = true;
    invalidateGalleryData();

    // Auto-sweep old non-displayed generated images on this floor to recycle bin
    if (settings.autoClear) {
        sweepMessage(message);
    }

    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length) {
        appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
        setTimeout(() => renderMessageControls(messageId), 100);
    }
    refreshImageManagementViews();
}

function scheduleAutoAnalyze(messageId, type) {
    const settings = ensureSettings();
    if (!settings.enabled || type === 'extension') {
        return;
    }

    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) {
        return;
    }

    if (settings.preventShortLlmImages) {
        const message = chat[id];
        if (message) {
            const text = String(getMessageText(message) || '').trim();
            const threshold = settings.shortLlmLengthThreshold ?? 10;
            if (text.length < threshold) {
                console.log(`[context-image-assistant] Auto analyze skipped: message length (${text.length}) is below threshold (${threshold})`);
                return;
            }
        }
    }

    const snapshot = createMessageSnapshot(id);
    if (!snapshot) {
        return;
    }

    const existingIndex = queuedAutoAnalyze.findIndex(job => job?.snapshot?.ref === snapshot.ref);
    const nextJob = { messageId: id, snapshot };
    if (existingIndex >= 0) {
        queuedAutoAnalyze[existingIndex] = nextJob;
    } else {
        queuedAutoAnalyze.push(nextJob);
    }
    void drainAutoAnalyzeQueue();
}

function plannerUsesGenerateRaw() {
    const settings = ensureSettings();
    if (settings.providerMode === 'custom_proxy') {
        return false;
    }
    if (!settings.useStPromptPreset && main_api === 'openai') {
        return false;
    }
    return true;
}

function scheduleAutoAnalyzeRetry(delayMs = 800) {
    if (autoAnalyzeRetryTimer !== null) {
        return;
    }
    autoAnalyzeRetryTimer = setTimeout(() => {
        autoAnalyzeRetryTimer = null;
        void drainAutoAnalyzeQueue();
    }, delayMs);
}

function onMessageReceived(messageId, type) {
    let resolvedId = Number(messageId);
    if (!Number.isInteger(resolvedId) || resolvedId < 0) {
        const message = messageId && typeof messageId === 'object'
            ? (messageId.message || messageId.mes || messageId)
            : null;
        if (message) {
            resolvedId = chat.indexOf(message);
        }
    }
    if (!Number.isInteger(resolvedId) || resolvedId < 0) {
        return;
    }
    scheduleAutoAnalyze(resolvedId, type);
}

async function drainAutoAnalyzeQueue() {
    if (autoAnalyzeWorkerRunning) {
        return;
    }
    autoAnalyzeWorkerRunning = true;

    try {
        while (queuedAutoAnalyze.length > 0) {
            const nextJob = queuedAutoAnalyze.pop();
            if (!nextJob?.snapshot?.ref) {
                continue;
            }

            // Only defer when planner path would touch ST generation channel.
            if (isGenerating() && plannerUsesGenerateRaw()) {
                queuedAutoAnalyze.push(nextJob);
                scheduleAutoAnalyzeRetry(1000);
                break;
            }

            const nextRef = nextJob.snapshot.ref;
            if (pendingAutoAnalyze.has(nextRef)) {
                continue;
            }

            const target = resolveMessageTarget(nextJob.messageId, nextJob.snapshot);
            if (!target) {
                continue;
            }
            if (activeRequests.has(target.messageId)) {
                continue;
            }
            const message = target.message;
            if (!message || message.is_user || message.is_system) {
                continue;
            }

            pendingAutoAnalyze.add(nextRef);
            try {
                await requestImageCandidate(target.messageId, {
                    force: false,
                    manual: false,
                    expectedSnapshot: nextJob.snapshot,
                    silentIfStale: true,
                });
            } catch (error) {
                console.error('[context-image-assistant] auto analyze failed', error);
            } finally {
                pendingAutoAnalyze.delete(nextRef);
            }
        }
    } finally {
        autoAnalyzeWorkerRunning = false;
    }
}

function registerDomHandlers() {
    $(document).on('click', '.cia-generate-image', async function () {
        const messageId = Number($(this).attr('data-message-id'));
        await generateImageForMessage(messageId);
    });

    $(document).on('click', '.cia-rebuild-from-image', async function (event) {
        event.preventDefault();
        event.stopPropagation();
        const messageId = Number($(this).attr('data-message-id'));
        const mediaIndex = Number($(this).attr('data-media-index'));
        await rebuildCandidateFromImage(messageId, mediaIndex);
    });

    $(document).on('click', '.cia-edit-prompt', async function () {
        const messageId = Number($(this).attr('data-message-id'));
        await editCandidate(messageId);
    });

    $(document).on('click', '.cia-retry-candidate', async function () {
        const messageId = Number($(this).attr('data-message-id'));
        await requestImageCandidate(messageId, { force: true, manual: true });
    });

    $(document).on('click', '.cia-cancel-planner', function () {
        const messageId = Number($(this).attr('data-message-id'));
        cancelPlannerRequest(messageId);
    });

    $(document).on('click', '.cia-cancel-image', function () {
        const messageId = Number($(this).attr('data-message-id'));
        cancelImageGeneration(messageId);
    });
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'cia',
        aliases: ['context-image'],
        splitUnnamedArgument: true,
        helpString: 'Context Image Assistant. Usage: /cia analyze | on | off | toggle | status',
        callback: async (_args, action) => {
            const settings = ensureSettings();
            const token = String(action || 'status').trim().toLowerCase();
            if (token === 'on' || token === 'off') {
                settings.enabled = token === 'on';
                saveSettingsDebounced();
                updateStatusUi();
                return settings.enabled ? 'on' : 'off';
            }
            if (token === 'toggle') {
                settings.enabled = !settings.enabled;
                saveSettingsDebounced();
                updateStatusUi();
                return settings.enabled ? 'on' : 'off';
            }
            if (token === 'analyze') {
                const messageId = getLastAssistantMessageId();
                if (messageId === null) {
                    return 'no assistant message';
                }
                await requestImageCandidate(messageId, { force: true, manual: true });
                return `analyzed #${messageId}`;
            }
            return JSON.stringify({
                enabled: settings.enabled,
                autoGenerate: settings.autoGenerate,
                providerMode: settings.providerMode,
                contextMessages: settings.contextMessages,
                contextChars: settings.contextChars,
            });
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'status, analyze, on, off, toggle',
                typeList: [ARGUMENT_TYPE.STRING],
                defaultValue: 'status',
            }),
        ],
        returns: 'current Context Image Assistant status',
    }));
}

ensureSettings();
eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
eventSource.on(event_types.GENERATION_ENDED, () => {
    void drainAutoAnalyzeQueue();
});
eventSource.on(event_types.CHAT_CHANGED, () => {
    clearPendingGalleryUiWork();
    favoriteSourceHashCache.clear();
    lastFavoriteArchiveMigrationSignature = '';
    favoriteArchiveNormalizationPending = false;
    invalidateGalleryData();
    setTimeout(renderAllMessageControls, 250);
    refreshImageManagementViews({ force: true });
});
eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => setTimeout(() => renderMessageControls(Number(messageId)), 250));
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => setTimeout(() => renderMessageControls(Number(messageId)), 50));
eventSource.on(event_types.IMAGE_SWIPED, ({ message }) => {
    const messageId = chat.indexOf(message);
    if (messageId >= 0) {
        setTimeout(() => renderMessageControls(messageId), 100);
    }
});
eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
    const settings = ensureSettings();
    if (!settings.filterCiaJsonFromMain) return;
    const chatArray = eventData.chat;
    if (Array.isArray(chatArray)) {
        for (const msg of chatArray) {
            if (msg && typeof msg.content === 'string') {
                msg.content = stripCandidateJsonBlocks(msg.content);
            }
        }
    }
});

eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (eventData) => {
    const settings = ensureSettings();
    if (!settings.filterCiaJsonFromMain) return;
    if (eventData && typeof eventData.prompt === 'string') {
        eventData.prompt = stripCandidateJsonBlocks(eventData.prompt);
    }
});

jQuery(async () => {
    createMenuEntry();
    registerDomHandlers();
    registerSlashCommands();
    await createSettingsUi();
    renderAllMessageControls();
});
