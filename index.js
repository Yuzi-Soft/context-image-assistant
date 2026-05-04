import {
    appendMediaToMessage,
    chat,
    event_types,
    eventSource,
    extractMessageFromData,
    formatCharacterAvatar,
    generateRaw,
    getCharacterAvatar,
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
import { delay, getBase64Async } from '../../../utils.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '../../../popup.js';
import { oai_settings, sendOpenAIRequest } from '../../../openai.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

export { MODULE_NAME };

const MODULE_NAME = 'context_image_assistant';
const EXTENSION_PATH = 'third-party/context-image-assistant';
const MENU_ENTRY_ID = 'cia_menu_entry';
const PANEL_CONTAINER_ID = 'cia_settings_container';
const EXTRA_KEY = 'context_image_assistant';
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const STRENGTH_KEYS = ['lighting_strength', 'front_lighting_strength', 'female_pov_strength'];
const CANDIDATE_JSON_BLOCK_LANG = 'cia-candidate-json';
const CANDIDATE_JSON_BLOCK_REGEX = /```cia-candidate-json\s*[\r\n]+[\s\S]*?```/gi;
const CANDIDATE_JSON_BODY_REGEX = /"prompt"\s*:\s*[\s\S]*?"lighting_strength"\s*:\s*[\s\S]*?"front_lighting_strength"\s*:\s*[\s\S]*?"female_pov_strength"\s*:/i;

const DEFAULT_SYSTEM_PROMPT = `你是 SillyTavern 的生图提示词规划器。请根据用户给出的当前对话上下文，提炼适合 ComfyUI/SDXL anime 工作流的生图参数。

只返回一个 JSON 对象，不要 Markdown，不要解释，不要代码块。JSON 必须包含：
{
  "prompt": "英文图像提示词，聚焦当前画面、人物、动作、构图、表情、环境、镜头，不要写成散文",
  "negative_prompt": "可选的额外负面提示词；没有就返回空字符串",
  "lighting_strength": 0,
  "front_lighting_strength": 1,
  "female_pov_strength": 0
}

三个 strength 是 LoRA 权重，可以用小数。没有明显理由时保持用户当前默认值。`;

const DEFAULT_REFERENCE_PROMPT = '这是可参考的角色特征。请优先保持这些外观、服装、气质与固定设定；如果与当前上下文冲突，以当前上下文为准。';

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
    useJsonSchema: true,
    useCustomJsonSchema: false,
    customJsonSchema: '',
    jsonSchemaProfiles: [],
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    prependMessage: '',
    apiProfiles: [],
    referencePrompt: DEFAULT_REFERENCE_PROMPT,
    characterReferences: {},
};

const IMAGE_JSON_SCHEMA = {
    name: 'context_image_request',
    strict: true,
    value: {
        type: 'object',
        additionalProperties: false,
        properties: {
            prompt: { type: 'string' },
            negative_prompt: { type: 'string' },
            lighting_strength: { type: 'number' },
            front_lighting_strength: { type: 'number' },
            female_pov_strength: { type: 'number' },
        },
        required: ['prompt', 'negative_prompt', 'lighting_strength', 'front_lighting_strength', 'female_pov_strength'],
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
    lastResult: '尚未运行',
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
    if (!Array.isArray(settings.apiProfiles)) {
        settings.apiProfiles = [];
    }
    if (!Array.isArray(settings.jsonSchemaProfiles)) {
        settings.jsonSchemaProfiles = [];
    }
    if (!settings.customJsonSchema) {
        settings.customJsonSchema = JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
    }
    // Migration: legacy provider option removed.
    if (settings.providerMode === 'st_custom_config') {
        settings.providerMode = 'custom_proxy';
    }
    return settings;
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
        select.append($('<option></option>').val('').text('暂无已保存格式'));
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

function upsertJsonSchemaProfile(name) {
    const settings = ensureSettings();
    name = String(name || '').trim();
    if (!name) {
        throw new Error('格式名称不能为空。');
    }

    const next = {
        name,
        useCustomJsonSchema: Boolean(settings.useCustomJsonSchema),
        customJsonSchema: String(settings.customJsonSchema || '').trim() || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2),
        updatedAt: new Date().toISOString(),
    };
    const index = settings.jsonSchemaProfiles.findIndex(x => String(x?.name || '') === name);
    if (index >= 0) {
        settings.jsonSchemaProfiles[index] = next;
    } else {
        settings.jsonSchemaProfiles.push(next);
    }
}

function applyJsonSchemaProfileByName(name) {
    const settings = ensureSettings();
    name = String(name || '').trim();
    const profile = settings.jsonSchemaProfiles.find(x => String(x?.name || '') === name);
    if (!profile) {
        throw new Error('未找到该格式配置。');
    }
    settings.useCustomJsonSchema = Boolean(profile.useCustomJsonSchema);
    settings.customJsonSchema = String(profile.customJsonSchema || '').trim() || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
}

function removeJsonSchemaProfileByName(name) {
    const settings = ensureSettings();
    const before = settings.jsonSchemaProfiles.length;
    settings.jsonSchemaProfiles = settings.jsonSchemaProfiles.filter(x => String(x?.name || '') !== String(name || ''));
    return settings.jsonSchemaProfiles.length !== before;
}

function renderApiProfileOptions() {
    const select = $('#cia_api_profile_select');
    if (!select.length) {
        return;
    }

    const profiles = getApiProfileList();
    const currentName = String(select.val() || '');
    select.empty();
    if (!profiles.length) {
        select.append($('<option></option>').val('').text('暂无已保存配置'));
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

function upsertApiProfile(name) {
    const settings = ensureSettings();
    name = String(name || '').trim();
    if (!name) {
        throw new Error('配置名不能为空。');
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
        throw new Error('未找到该配置。');
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
    $('#cia_system_prompt').val(settings.systemPrompt);
    $('#cia_prepend_message').val(settings.prependMessage);
    $('#cia_custom_json_schema').val(settings.customJsonSchema || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2));
    $('#cia_custom_api_block').toggle(settings.providerMode === 'custom_proxy');
    renderApiProfileOptions();
    renderJsonSchemaProfileOptions();
    $('#cia_status_value').text(runtimeState.status);
    $('#cia_last_result').text(runtimeState.lastResult);
    updateReferenceStatusUi();
}

function saveFromUi() {
    const settings = ensureSettings();
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
    settings.includeSystem = !!$('#cia_include_system').prop('checked');
    settings.includeNames = !!$('#cia_include_names').prop('checked');
    settings.systemPrompt = String($('#cia_system_prompt').val() || DEFAULT_SYSTEM_PROMPT);
    settings.prependMessage = String($('#cia_prepend_message').val() || '');
    settings.customJsonSchema = String($('#cia_custom_json_schema').val() || '').trim() || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
    saveSettingsDebounced();
    $('#cia_custom_api_block').toggle(settings.providerMode === 'custom_proxy');
    renderApiProfileOptions();
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
    $(`#${PANEL_CONTAINER_ID}`).empty().append(html);

    $('#cia_enabled, #cia_auto_generate, #cia_use_st_prompt_preset, #cia_use_json_schema, #cia_use_custom_json_schema, #cia_include_system, #cia_include_names').on('change', saveFromUi);
    $('#cia_provider_mode, #cia_response_tokens, #cia_custom_url, #cia_custom_model, #cia_custom_api_key, #cia_custom_temperature, #cia_context_messages, #cia_context_chars, #cia_min_prompt_chars, #cia_system_prompt, #cia_prepend_message, #cia_custom_json_schema').on('input change', saveFromUi);
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
        const name = await Popup.show.input('保存 API 配置', '输入配置名', suggested, { okButton: '保存', cancelButton: '取消' });
        if (name === null) {
            return;
        }
        try {
            saveFromUi();
            upsertApiProfile(name);
            saveSettingsDebounced();
            renderApiProfileOptions();
            $('#cia_api_profile_select').val(String(name).trim());
            toastr.success('API 配置已保存。', 'Context Image Assistant');
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
            toastr.success(`已加载配置：${name}`, 'Context Image Assistant');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    });
    $('#cia_api_profile_delete').on('click', () => {
        const name = String($('#cia_api_profile_select').val() || '');
        if (!name) {
            return;
        }
        if (removeApiProfileByName(name)) {
            saveSettingsDebounced();
            renderApiProfileOptions();
            toastr.info(`已删除配置：${name}`, 'Context Image Assistant');
        }
    });
    $('#cia_schema_profile_save').on('click', async () => {
        const suggested = 'default-schema';
        const name = await Popup.show.input('保存强制格式', '输入格式配置名', suggested, { okButton: '保存', cancelButton: '取消' });
        if (name === null) {
            return;
        }
        try {
            saveFromUi();
            // Validate before save for better UX.
            getEffectiveJsonSchema(ensureSettings());
            upsertJsonSchemaProfile(name);
            saveSettingsDebounced();
            renderJsonSchemaProfileOptions();
            $('#cia_schema_profile_select').val(String(name).trim());
            toastr.success('强制格式已保存。', 'Context Image Assistant');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    });
    $('#cia_schema_profile_load').on('click', () => {
        const name = String($('#cia_schema_profile_select').val() || '');
        if (!name) {
            return;
        }
        try {
            applyJsonSchemaProfileByName(name);
            saveSettingsDebounced();
            updateStatusUi();
            toastr.success(`已加载格式：${name}`, 'Context Image Assistant');
        } catch (error) {
            toastr.error(String(error?.message || error), 'Context Image Assistant');
        }
    });
    $('#cia_schema_profile_delete').on('click', () => {
        const name = String($('#cia_schema_profile_select').val() || '');
        if (!name) {
            return;
        }
        if (removeJsonSchemaProfileByName(name)) {
            saveSettingsDebounced();
            renderJsonSchemaProfileOptions();
            toastr.info(`已删除格式：${name}`, 'Context Image Assistant');
        }
    });
    $('#cia_restore_prompt').on('click', () => {
        $('#cia_system_prompt').val(DEFAULT_SYSTEM_PROMPT);
        saveFromUi();
    });
    $('#cia_character_reference').on('click', openCharacterReferenceEditor);
    $('#cia_analyze_last').on('click', async () => {
        const messageId = getLastAssistantMessageId();
        if (messageId === null) {
            toastr.warning('没有可分析的角色回复。', 'Context Image Assistant');
            return;
        }
        await requestImageCandidate(messageId, { force: true, manual: true });
    });

    updateStatusUi();
}

async function fetchCustomModels() {
    const settings = ensureSettings();
    if (!settings.customUrl) {
        toastr.warning('请先填写自定义端点 URL。', 'Context Image Assistant');
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
        select.append($('<option></option>').val('').text(ids.length ? `选择模型（${ids.length}）` : '未获取到模型'));
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
        toastr.success(ids.length ? `已获取 ${ids.length} 个模型。` : '接口可用，但未返回模型列表。', 'Context Image Assistant');
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

function stripCandidateJsonBlocks(text) {
    return String(text || '').replace(CANDIDATE_JSON_BLOCK_REGEX, '').trimEnd();
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
    const lines = [];

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
        const text = getMessageText(message).trim();
        if (!text) {
            continue;
        }
        lines.push(`#${i} ${role} ${name}`.trim() + `:\n${text}`);
    }

    let context = lines.join('\n\n');
    if (settings.contextChars > 0 && context.length > settings.contextChars) {
        context = `[前文已按字符上限截断]\n${context.slice(-settings.contextChars)}`;
    }

    return context;
}

function getComfyPlaceholderDefault(name, fallback = 0) {
    const value = extension_settings.sd?.comfy_placeholders?.find(x => x?.find === name)?.replace;
    return clampNumber(value, -10, 10, fallback);
}

function buildUserPrompt(messageId, { imageReference = null } = {}) {
    const settings = ensureSettings();
    const defaults = {
        lighting_strength: getComfyPlaceholderDefault('lighting_strength', 0),
        front_lighting_strength: getComfyPlaceholderDefault('front_lighting_strength', 1),
        female_pov_strength: getComfyPlaceholderDefault('female_pov_strength', 0),
    };
    const parts = [];
    const prependMessage = String(settings.prependMessage || '').trim();
    if (prependMessage) {
        parts.push('[补充信息开始]', prependMessage, '[补充信息结束]', '');
    }

    const imageReferenceBlock = buildImageReferenceBlock(imageReference);
    if (imageReferenceBlock) {
        parts.push(imageReferenceBlock, '');
    }

    parts.push(
        '请根据下面的当前对话上下文，生成用于当前楼层配图的 JSON。',
        '',
        `当前用户默认 LoRA 权重：lighting_strength=${defaults.lighting_strength}, front_lighting_strength=${defaults.front_lighting_strength}, female_pov_strength=${defaults.female_pov_strength}`,
    );
    const referenceBlock = buildCharacterReferenceBlock();
    if (referenceBlock) {
        parts.push('', referenceBlock);
    }
    parts.push('', '[对话上下文开始]', buildContext(messageId), '[对话上下文结束]');
    return parts.join('\n');
}

function buildImageReferenceBlock(imageReference) {
    if (!imageReference?.prompt) {
        return '';
    }

    const lines = [
        '[已生成图片参考开始]',
        '下面是一张已生成图片对应的提示词和参数。请基于它重新构建一个新的候选 JSON，保留当前楼层语境，修正或补充画面表达，不要机械复读。',
        `prompt: ${imageReference.prompt}`,
        `negative_prompt: ${imageReference.negative_prompt || ''}`,
        `lighting_strength: ${imageReference.lighting_strength}`,
        `front_lighting_strength: ${imageReference.front_lighting_strength}`,
        `female_pov_strength: ${imageReference.female_pov_strength}`,
    ];

    const extraInstruction = String(imageReference.extraInstruction || '').trim();
    if (extraInstruction) {
        lines.push('[用户追加重构指令]', extraInstruction);
    }

    lines.push('[已生成图片参考结束]');
    return lines.join('\n');
}

function getCurrentReferenceTarget() {
    const context = getContext();
    if (context.groupId) {
        const group = context.groups?.find(x => String(x.id) === String(context.groupId));
        return {
            key: `group:${context.groupId}`,
            label: group?.name ? `群组：${group.name}` : `群组：${context.groupId}`,
        };
    }

    const character = context.characters?.[context.characterId];
    if (context.characterId !== undefined && character) {
        const stableId = character.avatar || context.characterId;
        return {
            key: `character:${stableId}`,
            label: character.name ? `角色：${character.name}` : `角色：${stableId}`,
        };
    }

    const chatId = context.chatId || context.getCurrentChatId?.() || 'current';
    return {
        key: `chat:${chatId}`,
        label: `当前聊天：${chatId}`,
    };
}

function getCurrentReferenceEntry() {
    const settings = ensureSettings();
    const target = getCurrentReferenceTarget();
    return settings.characterReferences[target.key] || null;
}

function buildCharacterReferenceBlock() {
    const settings = ensureSettings();
    const entry = getCurrentReferenceEntry();
    const referenceText = String(entry?.text || '').trim();
    if (!referenceText) {
        return '';
    }

    const referencePrompt = String(entry?.prompt || settings.referencePrompt || DEFAULT_REFERENCE_PROMPT).trim();
    return [
        '[角色特征参考开始]',
        referencePrompt,
        referenceText,
        '[角色特征参考结束]',
    ].join('\n');
}

function updateReferenceStatusUi() {
    const status = $('#cia_reference_status');
    if (!status.length) {
        return;
    }

    const target = getCurrentReferenceTarget();
    const entry = getCurrentReferenceEntry();
    const hasReference = Boolean(String(entry?.text || '').trim());
    status.text(`${target.label}：${hasReference ? '已保存人物特征参考。' : '尚未保存人物特征参考。'}`);
}

function getSavedReferenceEntries() {
    const references = ensureSettings().characterReferences;
    return Object.entries(references)
        .filter(([, entry]) => entry && typeof entry === 'object')
        .sort(([, a], [, b]) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function populateReferenceSelect(select, currentKey) {
    select.empty();
    const saved = getSavedReferenceEntries();
    if (!saved.length) {
        select.append($('<option></option>').val('').text('暂无已保存参考'));
        select.prop('disabled', true);
        return;
    }

    select.prop('disabled', false);
    for (const [key, entry] of saved) {
        select.append($('<option></option>')
            .val(key)
            .text(entry.label || key));
    }
    select.val(saved.some(([key]) => key === currentKey) ? currentKey : saved[0][0]);
}

async function openCharacterReferenceEditor() {
    const target = getCurrentReferenceTarget();
    const settings = ensureSettings();
    const entry = settings.characterReferences[target.key] || {};
    const content = $(`
        <div class="cia-reference-editor">
            <div class="cia-note cia-current-reference-target"></div>
            <div class="cia-reference-load-row">
                <label class="cia-field" for="cia_reference_saved_select">
                    <span>加载已保存参考</span>
                    <select id="cia_reference_saved_select" class="text_pole"></select>
                </label>
                <button id="cia_reference_load_saved" class="menu_button" type="button">加载</button>
            </div>
            <label class="cia-field" for="cia_reference_prompt_popup">
                <span>发给 AI 的提示消息</span>
                <textarea id="cia_reference_prompt_popup" class="text_pole textarea_compact" rows="3"></textarea>
            </label>
            <label class="cia-field" for="cia_reference_text_popup">
                <span>当前对话人物的特征参考</span>
                <textarea id="cia_reference_text_popup" class="text_pole textarea_compact" rows="14"></textarea>
            </label>
        </div>
    `);

    content.find('.cia-current-reference-target').text(`当前保存对象：${target.label}`);
    content.find('#cia_reference_prompt_popup').val(entry.prompt || settings.referencePrompt || DEFAULT_REFERENCE_PROMPT);
    content.find('#cia_reference_text_popup').val(entry.text || '');
    populateReferenceSelect(content.find('#cia_reference_saved_select'), target.key);
    content.find('#cia_reference_load_saved').on('click', () => {
        const selectedKey = String(content.find('#cia_reference_saved_select').val() || '');
        const selectedEntry = ensureSettings().characterReferences[selectedKey];
        if (!selectedEntry) {
            return;
        }
        content.find('#cia_reference_prompt_popup').val(selectedEntry.prompt || ensureSettings().referencePrompt || DEFAULT_REFERENCE_PROMPT);
        content.find('#cia_reference_text_popup').val(selectedEntry.text || '');
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: '保存',
        cancelButton: '取消',
        wide: true,
        large: true,
        leftAlign: true,
        customButtons: [
            {
                text: '清空内容',
                action: () => {
                    content.find('#cia_reference_text_popup').val('');
                },
            },
        ],
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const latestSettings = ensureSettings();
    const prompt = String(content.find('#cia_reference_prompt_popup').val() || DEFAULT_REFERENCE_PROMPT).trim() || DEFAULT_REFERENCE_PROMPT;
    const text = String(content.find('#cia_reference_text_popup').val() || '').trim();
    latestSettings.referencePrompt = prompt;

    if (text) {
        latestSettings.characterReferences[target.key] = {
            label: target.label,
            prompt,
            text,
            updatedAt: new Date().toISOString(),
        };
        toastr.success('人物特征参考已保存。', 'Context Image Assistant');
    } else {
        delete latestSettings.characterReferences[target.key];
        toastr.info('已清空当前对象的人物特征参考。', 'Context Image Assistant');
    }

    saveSettingsDebounced();
    updateReferenceStatusUi();
}

async function requestImageCandidate(messageId, { force = false, manual = false, imageReference = null, autoGenerate = null, expectedSnapshot = null, silentIfStale = false } = {}) {
    const settings = ensureSettings();
    const autoPipelineEnabled = Boolean(settings.enabled || settings.autoGenerate);
    const initialTarget = resolveMessageTarget(messageId, expectedSnapshot);
    if (!initialTarget) {
        return;
    }
    messageId = initialTarget.messageId;
    const message = initialTarget.message;
    let shouldAutoGenerate = false;
    if (!manual && !autoPipelineEnabled) {
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
    runtimeState.status = `分析 #${messageId}`;
    runtimeState.lastResult = imageReference ? '正在基于图片向 LLM 重构生图 JSON...' : '正在向 LLM 请求生图 JSON...';
    updateStatusUi();
    renderMessageControls(messageId);

    try {
        const rawResponse = await callPlannerLlm(messageId, { imageReference, signal: plannerController.signal });
        const latestTarget = resolveMessageTarget(messageId, expectedSnapshot);
        if (!latestTarget) {
            setMessageState(messageId, {
                status: 'cancelled',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            if (!silentIfStale) {
                runtimeState.status = 'idle';
                runtimeState.lastResult = `#${messageId} 任务已跳过（楼层已变化或删除）`;
            }
            return;
        }
        messageId = latestTarget.messageId;
        const parsed = normalizeCandidate(parseCandidateJson(rawResponse));
        setMessageState(messageId, {
            status: 'ready',
            error: '',
            rawResponse,
            parsed,
            sourceMediaIndex: imageReference?.mediaIndex ?? null,
            updatedAt: new Date().toISOString(),
        });
        writeCandidateJsonToMessage(messageId, parsed);
        runtimeState.status = 'ready';
        runtimeState.lastResult = imageReference ? `#${messageId} 已基于图片重构候选提示词` : `#${messageId} 已生成候选提示词`;
        shouldAutoGenerate = autoGenerate === null ? Boolean(settings.autoGenerate) : Boolean(autoGenerate);
        toastr.success(imageReference ? '已基于图片重构生图候选。' : '已生成生图候选，按钮已插入当前楼层。', 'Context Image Assistant');
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
            runtimeState.lastResult = `#${messageId} 已取消等待模型回复`;
            toastr.info('已取消等待模型回复。', 'Context Image Assistant');
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
        activeRequests.delete(messageId);
        plannerAbortControllers.delete(messageId);
        cancelRequestedPlanner.delete(messageId);
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
    } else {
        // generateRaw() does not accept an external signal; it listens this global stop event.
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

    if (settings.providerMode === 'custom_proxy') {
        return callCustomProxyLlm(settings, userPrompt, signal);
    }

    if (!settings.useStPromptPreset && main_api === 'openai') {
        return callCurrentOpenAiLlm(settings, userPrompt, signal);
    }

    return generateRaw({
        prompt: userPrompt,
        systemPrompt: settings.systemPrompt,
        responseLength: settings.responseTokens,
        trimNames: false,
        jsonSchema: getEffectiveJsonSchema(settings),
    });
}

async function callCurrentOpenAiLlm(settings, userPrompt, signal = null) {
    const jsonSchema = getEffectiveJsonSchema(settings);
    const data = await sendOpenAIRequest(
        'quiet',
        [
            { role: 'system', content: substituteParams(settings.systemPrompt) },
            { role: 'user', content: substituteParams(userPrompt) },
        ],
        signal || new AbortController().signal,
        { jsonSchema },
    );

    const text = typeof data === 'string' ? data : extractMessageFromData(data, 'openai');
    if (!text) {
        throw new Error('ST 当前 Chat Completion 没有返回文本。');
    }
    return text;
}

async function callStCustomConfigLlm(settings, userPrompt, signal = null) {
    if (!oai_settings.custom_url) {
        throw new Error('请先在 ST 的 Chat Completion 里配置 Custom API URL。');
    }
    if (!oai_settings.custom_model) {
        throw new Error('请先在 ST 的 Chat Completion 里配置 Custom 模型名。');
    }

    const jsonSchema = getEffectiveJsonSchema(settings);
    return callCustomChatCompletion({
        messages: [
            { role: 'system', content: substituteParams(settings.systemPrompt) },
            { role: 'user', content: substituteParams(userPrompt) },
        ],
        model: oai_settings.custom_model,
        temperature: Number(oai_settings.temp_openai ?? settings.customTemperature),
        maxTokens: settings.responseTokens,
        customUrl: oai_settings.custom_url,
        customIncludeBody: oai_settings.custom_include_body || '',
        customExcludeBody: oai_settings.custom_exclude_body || '',
        customIncludeHeaders: oai_settings.custom_include_headers || '',
        jsonSchema,
        signal,
    });
}

async function callCustomProxyLlm(settings, userPrompt, signal = null) {
    if (!settings.customUrl) {
        throw new Error('请先填写自定义 LLM 端点。');
    }
    if (!settings.customModel) {
        throw new Error('请先填写自定义 LLM 模型名。');
    }

    const jsonSchema = getEffectiveJsonSchema(settings);
    return callCustomChatCompletion({
        messages: [
            { role: 'system', content: substituteParams(settings.systemPrompt) },
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
        throw new Error(data.error.message || '自定义 LLM 返回错误。');
    }

    const text = extractMessageFromData(data, 'openai');
    if (!text) {
        throw new Error('自定义 LLM 没有返回文本。');
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
        throw new Error('已启用自定义 JSON Schema，但内容为空。');
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('自定义 JSON Schema 不是合法 JSON。');
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

    throw new Error('自定义 JSON Schema 格式无效。');
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
        throw new Error('LLM 返回了空内容。');
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
        try {
            return unwrapCandidateResponse(JSON.parse(attempt));
        } catch {
            // Try fixing common JSON errors (loose parse)
            try {
                const fixed = attempt
                    .replace(/,\s*([}\]])/g, '$1') // Trailing commas
                    .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '"$2":') // Unquoted or single-quoted keys
                    .replace(/:\s*'((?:\\.|[^'])*?)'/g, ':"$1"'); // Single-quoted values
                return unwrapCandidateResponse(JSON.parse(fixed));
            } catch {
                // Keep trying
            }
        }
    }

    throw new Error('LLM 返回的内容不是可解析的 JSON。已尝试多种提取策略均失败。');
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
        throw new Error('JSON 根节点必须是对象。');
    }

    const strengths = value.strengths || value.lora_strengths || value.lora || value;
    const prompt = String(value.prompt || value.positive_prompt || value.image_prompt || '').trim();
    if (!prompt) {
        throw new Error('JSON 缺少 prompt。');
    }
    assertCandidatePromptIsNotEmpty(prompt);

    const normalized = {
        prompt,
        negative_prompt: String(value.negative_prompt || value.negative || '').trim(),
    };

    const useLegacyStrengthDefaults = !ensureSettings().useCustomJsonSchema;
    const applyStrengthIfNeeded = (key, fallback) => {
        const hasExplicitValue = strengths[key] !== undefined || value[key] !== undefined;
        if (!hasExplicitValue && !useLegacyStrengthDefaults) {
            return;
        }
        normalized[key] = clampNumber(strengths[key], -10, 10, getComfyPlaceholderDefault(key, fallback));
    };

    applyStrengthIfNeeded('lighting_strength', 0);
    applyStrengthIfNeeded('front_lighting_strength', 1);
    applyStrengthIfNeeded('female_pov_strength', 0);

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
        throw new Error(`LLM 返回的 prompt 内容过短（${length}/${minLength}），已跳过生图。`);
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
    const generateText = data.imageGeneratedAt ? '重新生成图片' : '生成图片';
    const statusText = getMessageStatusText(data, messageId);
    const rebuildMediaIndex = getCurrentRebuildableMediaIndex(message);

    row.empty();
    row.append($('<button type="button" class="menu_button cia-generate-image"></button>')
        .attr('data-message-id', messageId)
        .prop('disabled', !canGenerate)
        .text(generateText));
    row.append($('<button type="button" class="menu_button cia-edit-prompt"></button>')
        .attr('data-message-id', messageId)
        .prop('disabled', isBusy)
        .text('查看/编辑提示词'));
    if (activeRequests.has(messageId)) {
        row.append($('<button type="button" class="menu_button cia-cancel-planner"></button>')
            .attr('data-message-id', messageId)
            .text('取消等待模型回复'));
    }
    if (activeGenerations.has(messageId)) {
        row.append($('<button type="button" class="menu_button cia-cancel-image"></button>')
            .attr('data-message-id', messageId)
            .text('取消图片生成'));
    }
    if (rebuildMediaIndex !== null) {
        row.append($('<button type="button" class="menu_button cia-rebuild-from-image"></button>')
            .attr('data-message-id', messageId)
            .attr('data-media-index', rebuildMediaIndex)
            .prop('disabled', isBusy)
            .attr('title', '基于当前图片预览，让 LLM 重新生成候选提示词')
            .text('重新生成提示词'));
    }
    row.append($('<span class="cia-status-text"></span>').text(statusText));
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
        return '正在生成候选...';
    }
    if (activeGenerations.has(messageId)) {
        return '正在生图...';
    }
    if (data.status === 'error') {
        return `错误: ${data.error || '未知错误'}`;
    }
    if (data.status === 'done') {
        return '图片已生成';
    }
    if (data.status === 'ready') {
        return '候选已就绪';
    }
    return data.status || '';
}

async function editCandidate(messageId) {
    const message = chat[messageId];
    const data = message?.extra?.[EXTRA_KEY];
    if (!data) {
        return;
    }

    const value = JSON.stringify(data.parsed || parseCandidateJson(data.rawResponse || '{}'), null, 2);
    const edited = await Popup.show.input(
        '查看/编辑生图提示词',
        '保存后点击“生成图片”会使用这里的 JSON。',
        value,
        { rows: 18, wide: true, large: true, okButton: '保存' },
    );
    if (edited === null) {
        return;
    }

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
    } catch (error) {
        toastr.error(String(error?.message || error), 'Context Image Assistant');
    }
}

async function rebuildCandidateFromImage(messageId, mediaIndex) {
    const message = chat[messageId];
    const attachment = message?.extra?.media?.[mediaIndex];
    if (!message || !isRebuildableImageAttachment(attachment)) {
        toastr.warning('这张图片没有可用于重构的生图信息。', 'Context Image Assistant');
        return;
    }

    const currentCandidate = message.extra?.[EXTRA_KEY]?.parsed || {};
    const imageCandidate = attachment[EXTRA_KEY] || {};
    const imageReference = {
        mediaIndex,
        prompt: String(imageCandidate.prompt || attachment.title || currentCandidate.prompt || '').trim(),
        negative_prompt: String(imageCandidate.negative_prompt || attachment.negative || currentCandidate.negative_prompt || '').trim(),
        lighting_strength: clampNumber(imageCandidate.lighting_strength ?? currentCandidate.lighting_strength, -10, 10, getComfyPlaceholderDefault('lighting_strength', 0)),
        front_lighting_strength: clampNumber(imageCandidate.front_lighting_strength ?? currentCandidate.front_lighting_strength, -10, 10, getComfyPlaceholderDefault('front_lighting_strength', 1)),
        female_pov_strength: clampNumber(imageCandidate.female_pov_strength ?? currentCandidate.female_pov_strength, -10, 10, getComfyPlaceholderDefault('female_pov_strength', 0)),
    };

    if (!imageReference.prompt) {
        toastr.warning('这张图片缺少 prompt，无法重构。', 'Context Image Assistant');
        return;
    }

    const extraInstruction = await Popup.show.input(
        '重新生成提示词额外指令',
        '可补充你希望这次怎么改。留空则只基于这张图片和当前楼层重构候选 JSON。',
        '',
        { rows: 6, wide: true, okButton: '开始重构', cancelButton: '取消' },
    );
    if (extraInstruction === null) {
        return;
    }
    imageReference.extraInstruction = String(extraInstruction || '').trim();

    await requestImageCandidate(messageId, {
        force: true,
        manual: true,
        imageReference,
        autoGenerate: false,
    });
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
    const message = initialTarget.message;
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
    runtimeState.status = `生图 #${messageId}`;
    runtimeState.lastResult = '正在调用 ComfyUI...';
    updateStatusUi();

    try {
        const result = await generateComfyImage(data.parsed, imageController.signal);
        const latestTarget = resolveMessageTarget(messageId, expectedSnapshot);
        if (!latestTarget) {
            setMessageState(messageId, {
                status: 'ready',
                error: '',
                updatedAt: new Date().toISOString(),
            });
            if (!silentIfStale) {
                runtimeState.status = 'idle';
                runtimeState.lastResult = `#${messageId} 生图结果已丢弃（楼层已变化或删除）`;
            }
            return;
        }
        messageId = latestTarget.messageId;
        attachImageToMessage(messageId, data.parsed, result);
        setMessageState(messageId, {
            status: 'done',
            error: '',
            imageGeneratedAt: new Date().toISOString(),
        });
        runtimeState.status = 'done';
        runtimeState.lastResult = `#${messageId} 图片已生成`;
        activeGenerations.delete(messageId);
        updateStatusUi();
        renderMessageControls(messageId);
        toastr.success('图片已插入当前楼层。', 'Context Image Assistant');
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
            runtimeState.lastResult = `#${messageId} 已取消图片生成`;
            renderMessageControls(messageId);
            toastr.info('已取消图片生成。', 'Context Image Assistant');
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
        activeGenerations.delete(messageId);
        imageAbortControllers.delete(messageId);
        cancelRequestedImage.delete(messageId);
        updateStatusUi();
        renderMessageControls(messageId);
    }
}

async function generateComfyImage(candidate, signal = null) {
    const sd = extension_settings.sd || {};
    if (sd.source && sd.source !== 'comfy') {
        throw new Error('当前 ST 生图 Source 不是 ComfyUI。请在 Image Generation 里切到 ComfyUI。');
    }
    if (!sd.comfy_url) {
        throw new Error('请先在 ST Image Generation 里配置 ComfyUI URL。');
    }
    if (!sd.comfy_workflow) {
        throw new Error('请先在 ST Image Generation 里选择 ComfyUI Workflow。');
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
    const finalPrompt = combinePrefixes(sd.prompt_prefix, candidate.prompt, '{prompt}');
    const negativePrompt = candidate.negative_prompt
        ? combinePrefixes(sd.negative_prompt, candidate.negative_prompt)
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
        throw new Error('ComfyUI 没有返回图片数据。');
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
        [EXTRA_KEY]: {
            prompt: candidate.prompt,
            negative_prompt: candidate.negative_prompt || '',
            lighting_strength: candidate.lighting_strength,
            front_lighting_strength: candidate.front_lighting_strength,
            female_pov_strength: candidate.female_pov_strength,
        },
    });
    message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    message.extra.media_index = message.extra.media.length - 1;
    message.extra.inline_image = true;

    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length) {
        appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
        setTimeout(() => renderMessageControls(messageId), 100);
    }
}

function scheduleAutoAnalyze(messageId, type) {
    const settings = ensureSettings();
    const autoPipelineEnabled = Boolean(settings.enabled || settings.autoGenerate);
    if (!autoPipelineEnabled || type === 'extension') {
        return;
    }

    const id = Number(messageId);
    if (!Number.isInteger(id) || id < 0) {
        return;
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
eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(renderAllMessageControls, 250));
eventSource.on(event_types.MESSAGE_UPDATED, (messageId) => setTimeout(() => renderMessageControls(Number(messageId)), 250));
eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (messageId) => setTimeout(() => renderMessageControls(Number(messageId)), 50));
eventSource.on(event_types.IMAGE_SWIPED, ({ message }) => {
    const messageId = chat.indexOf(message);
    if (messageId >= 0) {
        setTimeout(() => renderMessageControls(messageId), 100);
    }
});

jQuery(async () => {
    createMenuEntry();
    registerDomHandlers();
    registerSlashCommands();
    await createSettingsUi();
    renderAllMessageControls();
});
