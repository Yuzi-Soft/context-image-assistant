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
import { delay, getBase64Async } from '../../../utils.js';
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
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const CANDIDATE_JSON_BLOCK_LANG = 'cia-candidate-json';
const CANDIDATE_JSON_BLOCK_REGEX = /```cia-candidate-json\s*[\r\n]+[\s\S]*?```/gi;
const CANDIDATE_JSON_BODY_REGEX = /"prompt"\s*:/i;

const DEFAULT_SYSTEM_PROMPT = `You are SillyTavern's image generation prompt planner. Based on the current chat context provided by the user, extract suitable image generation parameters for ComfyUI/SDXL anime workflow.

Return ONLY a JSON object, no Markdown, no explanations, no code blocks. The JSON must contain:
{
  "prompt": "English image prompt, focusing on the current scene, characters, actions, composition, expressions, environment, camera lens, do not write as prose",
  "negative_prompt": "optional extra negative prompt; return empty string if none",
  "example_lora_1_strength": 0,
  "example_lora_2_strength": 0
}

The strength is the LoRA weight, ranging from [-1, 1]. Keep default value 0 if no obvious modification is needed.`;

const DEFAULT_REFERENCE_PROMPT = 'This is character reference info. Prioritize maintaining these appearance, clothing, traits, and fixed settings; if in conflict with the current context, the current context prevails.';

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
    loraMin: -1,
    loraMax: 1,
    autoClear: false,
    autoGenerateOnRebuild: false,
    galleryCollapsed: false,
    recycleCollapsed: false,
    largeGridColumns: 3,
    preventShortLlmImages: false,
    shortLlmLengthThreshold: 10,
    filterCiaJsonFromMain: false,
    filterCiaJsonFromPlugin: false,
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
        required: ['prompt', 'negative_prompt', 'example_lora_1_strength', 'example_lora_2_strength'],
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
    if (!Array.isArray(settings.apiProfiles)) {
        settings.apiProfiles = [];
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
    $('#cia_filter_cia_json_from_main').prop('checked', settings.filterCiaJsonFromMain);
    $('#cia_filter_cia_json_from_plugin').prop('checked', settings.filterCiaJsonFromPlugin);
    $('#cia_system_prompt').val(settings.systemPrompt);
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
    settings.filterCiaJsonFromMain = !!$('#cia_filter_cia_json_from_main').prop('checked');
    settings.filterCiaJsonFromPlugin = !!$('#cia_filter_cia_json_from_plugin').prop('checked');
    settings.systemPrompt = String($('#cia_system_prompt').val() || DEFAULT_SYSTEM_PROMPT);
    settings.prependMessage = String($('#cia_prepend_message').val() || '');
    settings.customJsonSchema = String($('#cia_custom_json_schema').val() || '').trim() || JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
    settings.autoClear = !!$('#cia_auto_clear').prop('checked');
    settings.autoGenerateOnRebuild = !!$('#cia_auto_generate_on_rebuild').prop('checked');
    settings.preventShortLlmImages = !!$('#cia_prevent_short_llm_images').prop('checked');
    settings.shortLlmLengthThreshold = clampInteger($('#cia_short_llm_length_threshold').val(), 1, 1000, DEFAULT_SETTINGS.shortLlmLengthThreshold || 10);
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

    $('#cia_enabled, #cia_auto_generate, #cia_use_st_prompt_preset, #cia_use_json_schema, #cia_use_custom_json_schema, #cia_include_system, #cia_include_names, #cia_filter_cia_json_from_main, #cia_filter_cia_json_from_plugin, #cia_auto_clear, #cia_auto_generate_on_rebuild, #cia_prevent_short_llm_images').on('change', saveFromUi);
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

    $('#cia_restore_prompt').on('click', () => {
        $('#cia_system_prompt').val(DEFAULT_SYSTEM_PROMPT);
        saveFromUi();
    });
    $('#cia_edit_system_prompt_btn').on('click', openSystemPromptEditor);
    $('#cia_edit_json_schema_btn').on('click', openCustomJsonSchemaEditor);
    $('#cia_character_reference').on('click', openCharacterReferenceEditor);
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
        renderGalleryList();
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
        for (const item of bin) {
            await deletePhysicalImage(item.url);
        }
        saveRecycleBin([]);
        await saveChatWhenGeneratorIdle();
        renderRecycleBinList();
        renderGalleryList();
        toastr.success(t`Cleared Recycle Bin and deleted related disk files.`, 'Context Image Assistant');
    });

    updateStatusUi();

    // If the recycle/gallery tab is already selected, trigger a render
    if ($(`#${PANEL_CONTAINER_ID} .cia-tab-btn[data-tab="tab-recycle"]`).hasClass('active')) {
        renderRecycleBinList();
        renderGalleryList();
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
        let text = getMessageText(message).trim();
        if (settings.filterCiaJsonFromPlugin) {
            text = stripCandidateJsonBlocks(text);
        }
        if (!text) {
            continue;
        }
        lines.push(`#${i} ${role} ${name}`.trim() + `:\n${text}`);
    }

    let context = lines.join('\n\n');
    if (settings.contextChars > 0 && context.length > settings.contextChars) {
        context = `[Context truncated from top]\n${context.slice(-settings.contextChars)}`;
    }

    return context;
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
    const prependMessage = String(settings.prependMessage || '').trim();
    if (prependMessage) {
        parts.push('[Additional Info Start]', prependMessage, '[Additional Info End]', '');
    }

    if (imageReference) {
        const mode = imageReference.mode || 'adjust';
        if (mode === 'adjust') {
            const imageReferenceBlock = buildImageReferenceBlock(imageReference);
            if (imageReferenceBlock) {
                parts.push(imageReferenceBlock, '');
            }
        } else if (mode === 'rewrite') {
            const extraInstruction = String(imageReference.extraInstruction || '').trim();
            if (extraInstruction) {
                parts.push(
                    '[User Extra Requirements Start]',
                    `This is the user's extra requirement:\n${extraInstruction}`,
                    '[User Extra Requirements End]',
                    '',
                );
            }
        }
    }

    parts.push(
        'Please generate a JSON object for the current message illustration based on the following conversation context.',
        '',
        defaultsStr ? `Default LoRA strengths for current user: ${defaultsStr}` : '',
    );
    const referenceBlock = buildCharacterReferenceBlock();
    if (referenceBlock) {
        parts.push('', referenceBlock);
    }
    parts.push('', '[Conversation Context Start]', buildContext(messageId), '[Conversation Context End]');
    return parts.join('\n');
}

function buildImageReferenceBlock(imageReference) {
    if (!imageReference?.prompt) {
        return '';
    }

    const lines = [
        '[Generated Image Reference Start]',
        'Below are the prompts and parameters of a previously generated image. Please reconstruct a new candidate JSON based on it, maintaining the context of the current message floor, correcting or enhancing the visual expression, and avoiding robotic repetition.',
        `prompt: ${imageReference.prompt}`,
        `negative_prompt: ${imageReference.negative_prompt || ''}`,
    ];

    const settings = ensureSettings();
    const numericProps = getNumericSchemaProperties(settings);
    for (const prop of numericProps) {
        const val = imageReference[prop.key] !== undefined ? imageReference[prop.key] : prop.default;
        lines.push(`${prop.key}: ${val}`);
    }

    const extraInstruction = String(imageReference.extraInstruction || '').trim();
    if (extraInstruction) {
        lines.push('[User Reconstruct Instructions]', extraInstruction);
    }

    lines.push('[Generated Image Reference End]');
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

function buildCharacterReferenceBlock() {
    const settings = ensureSettings();
    const entry = getCurrentReferenceEntry();
    const referenceText = String(entry?.text || '').trim();
    if (!referenceText) {
        return '';
    }

    const referencePrompt = String(entry?.prompt || settings.referencePrompt || DEFAULT_REFERENCE_PROMPT).trim();
    return [
        '[Character Reference Start]',
        referencePrompt,
        referenceText,
        '[Character Reference End]',
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
    const currentPrompt = settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const content = $(applyLocale(`
        <div class="cia-prompt-editor-wrapper">
            <div class="cia-ref-toolbar-row" style="margin-bottom: 4px;">
                <div class="cia-ref-selector-group">
                    <i class="fa-solid fa-gears" style="color: var(--SmartThemeQuoteColor, #78beff); margin-right: 6px;"></i>
                    <span style="font-size: 1.05em; font-weight: 600;" data-i18n="System Instructions Configuration (System Prompt)">System Instructions Configuration (System Prompt)</span>
                </div>
                <div class="cia-ref-toolbar">
                    <button id="cia_prompt_reset_btn" class="cia-icon-btn" type="button" data-i18n="[title]Reset to default system prompt" title="Reset to default system prompt">
                        <i class="fa-solid fa-rotate-left"></i>
                    </button>
                </div>
            </div>

            <div class="cia-ref-status-banner" style="gap: 10px; padding: 10px 14px;">
                <i class="fa-solid fa-circle-info" style="color: var(--SmartThemeQuoteColor, #78beff); font-size: 1.1em; flex-shrink: 0;"></i>
                <div class="context-label" style="font-size: 0.88em; line-height: 1.45; opacity: 0.85;" data-i18n="This instruction block serves as the core system prompt for the prompt planner model. It defines how the model generates prompts, what format it returns, and the range of values for parameter weights.">
                    This instruction block serves as the core system prompt for the prompt planner model. It defines how the model generates prompts, what format it returns, and the range of values for parameter weights.
                </div>
            </div>

            <textarea id="cia_prompt_editor_textarea" class="cia-monospace-textarea" style="height: 60vh;" data-i18n="[placeholder]Please enter system prompt..." placeholder="Please enter system prompt..."></textarea>
        </div>
    `));

    content.find('#cia_prompt_editor_textarea').val(currentPrompt);

    content.find('#cia_prompt_reset_btn').on('click', () => {
        content.find('#cia_prompt_editor_textarea').val(DEFAULT_SYSTEM_PROMPT);
        toastr.info(t`Restored default system prompt. Click "Save" below to apply changes.`, 'Context Image Assistant');
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        okButton: t`Save`,
        cancelButton: t`Cancel`,
        wide: true,
        large: true,
        leftAlign: true,
    });

    const result = await popup.show();
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const edited = String(content.find('#cia_prompt_editor_textarea').val() || '').trim();
    $('#cia_system_prompt').val(edited).trigger('input');
    saveFromUi();
    toastr.success(t`System prompt saved successfully.`, 'Context Image Assistant');
}

function ensureSchemaConstraints(schema) {
    if (!schema || typeof schema !== 'object') return schema;

    let properties = null;
    if (schema.value && typeof schema.value === 'object' && !Array.isArray(schema.value)) {
        properties = schema.value.properties;
    } else if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
        properties = schema.properties;
    }

    if (properties && typeof properties === 'object') {
        for (const [key, prop] of Object.entries(properties)) {
            if (key === 'prompt' || key === 'negative_prompt') {
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

function createLoraCardHtml(key, title, description, min, max, defaultValue) {
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
            </div>
        </div>
    `);
}

function serializeVisualToSchemaObj(content) {
    const properties = {
        prompt: { type: 'string' },
        negative_prompt: { type: 'string' },
    };
    const required = ['prompt', 'negative_prompt'];

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
        if (rawKey === 'prompt' || rawKey === 'negative_prompt') {
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

function deserializeSchemaObjToVisual(schemaObj, loraListContainer) {
    loraListContainer.empty();
    const properties = schemaObj?.value?.properties || schemaObj?.properties;
    if (!properties || typeof properties !== 'object') {
        return;
    }

    for (const [key, prop] of Object.entries(properties)) {
        if (key === 'prompt' || key === 'negative_prompt') {
            continue;
        }
        if (prop && (prop.type === 'number' || prop.type === 'integer')) {
            const title = prop.title || '';
            const desc = prop.description || '';
            const min = prop.minimum !== undefined ? prop.minimum : '';
            const max = prop.maximum !== undefined ? prop.maximum : '';
            const defVal = prop.default !== undefined ? prop.default : '';

            const cardHtml = createLoraCardHtml(key, title, desc, min, max, defVal);
            loraListContainer.append(cardHtml);
        }
    }
}

function savePopupStateToProfile(profileName, schemaStr) {
    const settings = ensureSettings();
    const index = settings.jsonSchemaProfiles.findIndex(x => String(x?.name || '') === profileName);
    const next = {
        name: profileName,
        useCustomJsonSchema: true,
        customJsonSchema: schemaStr,
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
                </div>
            </div>

            <div class="cia-schema-tab-content" id="cia-schema-tab-source">
                <div class="cia-editor-desc" style="font-size: 0.9em; opacity: 0.75; margin-bottom: 8px;" data-i18n="Edit JSON schema template constraining the output.">Edit JSON schema template constraining the output.</div>
                <textarea id="cia_schema_source_textarea" class="cia-monospace-textarea" rows="24"></textarea>
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

        const activeTab = content.find('.cia-schema-tab-btn.active').attr('data-tab');
        try {
            const schemaObj = validateSchemaString(schemaStr);
            deserializeSchemaObjToVisual(schemaObj, content.find('#cia_schema_lora_list'));
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
                const rawText = content.find('#cia_schema_source_textarea').val();
                const schemaObj = validateSchemaString(rawText);
                deserializeSchemaObjToVisual(schemaObj, content.find('#cia_schema_lora_list'));
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
                schemaStr = String(content.find('#cia_schema_source_textarea').val() || '').trim();
                validateSchemaString(schemaStr);
            }
        } catch (err) {
            toastr.error(err.message, 'Context Image Assistant');
            return;
        }

        if (!selectVal) {
            content.find('#cia_schema_popup_new_btn').click();
            return;
        }

        savePopupStateToProfile(selectVal, schemaStr);
        saveSettingsDebounced();
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
                schemaStr = String(content.find('#cia_schema_source_textarea').val() || '').trim();
                validateSchemaString(schemaStr);
            }
        } catch (e) {
            schemaStr = JSON.stringify(IMAGE_JSON_SCHEMA, null, 2);
        }

        savePopupStateToProfile(name, schemaStr);
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
        large: true,
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
                    schemaStr = String(content.find('#cia_schema_source_textarea').val() || '').trim();
                    validateSchemaString(schemaStr);
                }

                // Sync current value to select profile
                const selectVal = content.find('#cia_schema_popup_profile_select').val();
                if (selectVal) {
                    savePopupStateToProfile(selectVal, schemaStr);
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
                    <button id="cia_ref_save_btn" class="cia-icon-btn" type="button" data-i18n="[title]Save current schema profile" title="Save current schema profile">
                        <i class="fa-solid fa-floppy-disk"></i>
                    </button>
                    <button id="cia_ref_rename_btn" class="cia-icon-btn" type="button" data-i18n="[title]Rename current schema profile" title="Rename current schema profile">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button id="cia_ref_new_btn" class="cia-icon-btn" type="button" data-i18n="[title]Create new schema profile" title="Create new schema profile">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                    <button id="cia_ref_delete_btn" class="cia-icon-btn" type="button" data-i18n="[title]Delete current schema profile" title="Delete current schema profile">
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
                <textarea id="cia_ref_prompt_textarea" class="text_pole" rows="3" data-i18n="[placeholder]e.g., Character reference descriptors as follows..." placeholder="e.g., Character reference descriptors as follows..."></textarea>
            </div>
            <div class="cia-ref-field">
                <span data-i18n="Character Visual Baseline Descriptors">Character Visual Baseline Descriptors</span>
                <textarea id="cia_ref_text_textarea" class="text_pole" rows="12" data-i18n="[placeholder]Enter hairstyle, eyes, attire details here, one per line..." placeholder="Enter hairstyle, eyes, attire details here, one per line..."></textarea>
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
        const selectVal = content.find('#cia_ref_profile_select').val();
        if (!selectVal) return;
        const prompt = String(content.find('#cia_ref_prompt_textarea').val() || '').trim() || DEFAULT_REFERENCE_PROMPT;
        const text = String(content.find('#cia_ref_text_textarea').val() || '').trim();

        const label = settings.characterReferences[selectVal]?.label || (selectVal === target.key ? target.label : selectVal);

        if (text) {
            settings.characterReferences[selectVal] = {
                label,
                prompt,
                text,
                updatedAt: new Date().toISOString(),
            };
            toastr.success(t`Profile "${label}" saved.`, 'Context Image Assistant');
        } else {
            delete settings.characterReferences[selectVal];
            toastr.info(t`Profile "${label}" cleared.`, 'Context Image Assistant');
        }

        saveSettingsDebounced();
        updateStatusDisplay();
        populateSelect(selectVal);
        loadSelectedProfile();
        updateReferenceStatusUi();
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
        large: true,
        leftAlign: true,
        onClosing: async (p) => {
            if (p.result !== POPUP_RESULT.AFFIRMATIVE) {
                return true;
            }

            const selectVal = content.find('#cia_ref_profile_select').val();
            if (selectVal) {
                const prompt = String(content.find('#cia_ref_prompt_textarea').val() || '').trim() || DEFAULT_REFERENCE_PROMPT;
                const text = String(content.find('#cia_ref_text_textarea').val() || '').trim();

                const label = settings.characterReferences[selectVal]?.label || (selectVal === target.key ? target.label : selectVal);

                if (text) {
                    settings.characterReferences[selectVal] = {
                        label,
                        prompt,
                        text,
                        updatedAt: new Date().toISOString(),
                    };
                } else {
                    delete settings.characterReferences[selectVal];
                }
            }

            saveSettingsDebounced();
            updateReferenceStatusUi();
            return true;
        },
    });

    await popup.show();
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
    runtimeState.status = t`Analyzing #${messageId}`;
    runtimeState.lastResult = imageReference ? t`Reconstructing prompt JSON from image...` : t`Requesting prompt JSON from LLM...`;
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
                runtimeState.lastResult = t`#${messageId} task skipped (floor changed or deleted)`;
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
        runtimeState.lastResult = imageReference ? t`#${messageId} rebuilt candidate from image` : t`#${messageId} candidate generated`;
        shouldAutoGenerate = autoGenerate === null ? Boolean(settings.autoGenerate) : Boolean(autoGenerate);
        toastr.success(imageReference ? t`Rebuilt image candidate based on reference image.` : t`Generated image candidate, button inserted into current message.`, 'Context Image Assistant');
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
        jsonSchema: stripSchemaConstraints(getEffectiveJsonSchema(settings)),
    });
}

async function callCurrentOpenAiLlm(settings, userPrompt, signal = null) {
    const jsonSchema = stripSchemaConstraints(getEffectiveJsonSchema(settings));
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
        throw new Error(t`ST current Chat Completion returned no text.`);
    }
    return text;
}

async function callCustomProxyLlm(settings, userPrompt, signal = null) {
    if (!settings.customUrl) {
        throw new Error(t`Please fill in the custom endpoint URL first.`);
    }
    if (!settings.customModel) {
        throw new Error(t`Please fill in the custom LLM model name first.`);
    }

    const jsonSchema = stripSchemaConstraints(getEffectiveJsonSchema(settings));
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
    const value = JSON.stringify(parsedData, null, 2);

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
                    <div style="font-size: 0.85em; opacity: 0.85; font-weight: 600;" data-i18n="Interactive Segmented Editor">Interactive Segmented Editor</div>

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

            textareaJson.val(JSON.stringify(obj, null, 2));
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
        <div style="display: flex; gap: 16px; width: 100%; height: 60vh; max-width: 100% !important;">
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
                <textarea class="cia-rebuild-instruction text_pole" style="flex-grow: 1; resize: none; font-size: 0.88em; padding: 10px; border-radius: 8px; line-height: 1.4;" placeholder="${escapeHtmlAttr(t('Enter your adjustment requests for this image (e.g. change background, change clothes, adjust expression). Leave empty to rebuild based on the original image and current context.'))}"></textarea>
            </div>
        </div>
    `));

    let currentMode = 'adjust';
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
            leftCol.css('opacity', '0.4');
            popupContent.find('.cia-rebuild-instruction').attr('placeholder', t('Enter your extra instructions for rewriting. Leave empty to perform a standard freshness generation based only on the chat context.'));
        } else {
            leftCol.css('opacity', '1');
            popupContent.find('.cia-rebuild-instruction').attr('placeholder', t('Enter your adjustment requests for this image (e.g. change background, change clothes, adjust expression). Leave empty to rebuild based on the original image and current context.'));
        }
    });

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, t('Replan Image Generation'), {
        okButton: t('Start Rebuild'),
        cancelButton: t('Cancel'),
        wide: true,
        wider: true,
        large: true,
    });

    const result = await popup.show();
    if (result === POPUP_RESULT.AFFIRMATIVE) {
        const extraInstruction = String(popupContent.find('.cia-rebuild-instruction').val() || '').trim();
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
    runtimeState.status = t`Generating image #${messageId}`;
    runtimeState.lastResult = t`Calling ComfyUI...`;
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
                runtimeState.lastResult = t`#${messageId} image generation result discarded (floor changed or deleted)`;
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
        runtimeState.lastResult = t`#${messageId} image generated`;
        activeGenerations.delete(messageId);
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

function getOrCreateMessageCiaId(message) {
    message.extra ??= {};
    if (!message.extra.cia_msg_id) {
        message.extra.cia_msg_id = 'cia-msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
    }
    return message.extra.cia_msg_id;
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

function saveRecycleBin(bin) {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return;
    }
    chat_metadata[RECYCLE_BIN_KEY] = Array.isArray(bin) ? bin : [];
    if (chat?.[0]?.extra) {
        delete chat[0].extra[RECYCLE_BIN_KEY];
    }
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

function applyGalleryUiStateToFilters() {
    const state = getGalleryUiState();
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked', state.favoritesOnly);
    $(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val(state.floorFilter);
}

function saveGalleryFilterStateFromUi() {
    const state = getGalleryUiState();
    state.favoritesOnly = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    state.floorFilter = String($(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_floor`).val() || '');
    void saveChatConditional();
}

function saveGallerySortDirection(direction) {
    const state = getGalleryUiState();
    state.sortDirection = direction === 'desc' ? 'desc' : 'asc';
    void saveChatConditional();
}

function sortGalleryItemsForLargeGrid(items) {
    const direction = getGalleryUiState().sortDirection;
    const multiplier = direction === 'desc' ? -1 : 1;
    return [...items].sort((a, b) => {
        const floorA = Number.isInteger(a.floorNumber) ? a.floorNumber : Number.MAX_SAFE_INTEGER;
        const floorB = Number.isInteger(b.floorNumber) ? b.floorNumber : Number.MAX_SAFE_INTEGER;
        if (floorA !== floorB) {
            return (floorA - floorB) * multiplier;
        }
        const mediaA = Number.isInteger(a.mediaIndex) ? a.mediaIndex : Number.MAX_SAFE_INTEGER;
        const mediaB = Number.isInteger(b.mediaIndex) ? b.mediaIndex : Number.MAX_SAFE_INTEGER;
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
let lastChatLength = 0;
let lastActiveImagesCount = 0;
let lastRecycledImagesCount = 0;

function refreshImageManagementViews({ force = false } = {}) {
    if (!force && !isImageManagementTabActive()) {
        return;
    }

    const currentChatId = typeof getCurrentChatId === 'function' ? getCurrentChatId() : null;
    const currentChatLength = Array.isArray(chat) ? chat.length : 0;
    const currentActiveCount = getActiveGalleryImages().length;
    const currentRecycledCount = getRecycleBin().length;

    const hasChatChanged = force ||
        currentChatId !== lastChatId ||
        currentChatLength !== lastChatLength ||
        currentActiveCount !== lastActiveImagesCount ||
        currentRecycledCount !== lastRecycledImagesCount;

    if (hasChatChanged) {
        lastChatId = currentChatId;
        lastChatLength = currentChatLength;
        lastActiveImagesCount = currentActiveCount;
        lastRecycledImagesCount = currentRecycledCount;

        applyGalleryUiStateToFilters();
        renderGalleryList();
        renderRecycleBinList();
    }
}

async function deletePhysicalImage(url) {
    if (!url || typeof url !== 'string' || url.startsWith('data:')) {
        return;
    }
    try {
        const response = await fetch('/api/images/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: url }),
        });
        if (response.ok) {
            console.log(`[context-image-assistant] physically deleted image: ${url}`);
        }
    } catch (e) {
        console.error(`[context-image-assistant] failed to delete physical file: ${url}`, e);
    }
}

async function deleteRecycleItem(reference) {
    const bin = getRecycleBin();
    const index = findRecycleBinIndex(reference);
    const item = bin[index];
    if (!item) return;

    await deletePhysicalImage(item.url);
    bin.splice(index, 1);
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
    const message = chat[item.msgId];
    if (!message || !message.extra || !Array.isArray(message.extra.media)) return;

    const attachment = message.extra.media[item.mediaIndex];
    if (!attachment) return;

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

    // Remove from message media
    message.extra.media.splice(item.mediaIndex, 1);

    // Adjust media_index
    if (message.extra.media.length === 0) {
        delete message.extra.media;
        delete message.extra.media_index;
        delete message.extra.media_display;
        delete message.extra.inline_image;
    } else {
        message.extra.media_index = Math.max(0, message.extra.media_index - 1);
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

function getActiveGalleryImages() {
    const items = [];

    for (let msgId = 0; msgId < chat.length; msgId++) {
        const message = chat[msgId];
        if (!message || !message.extra || !Array.isArray(message.extra.media)) {
            continue;
        }
        const media = message.extra.media;
        for (let mediaIdx = 0; mediaIdx < media.length; mediaIdx++) {
            const attachment = media[mediaIdx];
            if (isRebuildableImageAttachment(attachment)) {
                items.push({
                    id: `active:${msgId}:${mediaIdx}`,
                    type: 'active',
                    msgId: msgId,
                    floorNumber: msgId + 1,
                    mediaIndex: mediaIdx,
                    url: attachment.url,
                    title: attachment.title,
                    negative: attachment.negative || '',
                    [EXTRA_KEY]: attachment[EXTRA_KEY] || {},
                    isFavorited: !!attachment[EXTRA_KEY]?.isFavorited,
                    createdAt: attachment[EXTRA_KEY]?.updatedAt || message.send_date || '',
                });
            }
        }
    }

    return items;
}

function getRecycleGalleryImages() {
    const items = [];
    const bin = getRecycleBin();
    for (let binIdx = 0; binIdx < bin.length; binIdx++) {
        const item = bin[binIdx];
        const originalMsgIndex = chat.findIndex(msg => msg?.extra?.cia_msg_id === item.cia_msg_id);
        items.push({
            id: `recycle:${binIdx}`,
            type: 'recycle',
            binIndex: binIdx,
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
        });
    }

    return items;
}

function getFilteredGalleryImages() {
    const all = getActiveGalleryImages();
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

async function toggleGalleryFavorite(item) {
    if (item.type === 'active') {
        const message = chat[item.msgId];
        if (message && message.extra && Array.isArray(message.extra.media)) {
            const attachment = message.extra.media[item.mediaIndex];
            if (attachment) {
                attachment[EXTRA_KEY] ??= {};
                attachment[EXTRA_KEY].isFavorited = !attachment[EXTRA_KEY].isFavorited;
                item.isFavorited = attachment[EXTRA_KEY].isFavorited;
            }
        }
    } else if (item.type === 'recycle') {
        const bin = getRecycleBin();
        const idx = findRecycleBinIndex(item);
        if (idx !== -1) {
            const binItem = bin[idx];
            binItem.isFavorited = !binItem.isFavorited;
            item.isFavorited = binItem.isFavorited;
            saveRecycleBin(bin);
        }
    }

    hasUnsavedGalleryChanges = true;
    $(`#${PANEL_CONTAINER_ID} #cia_save_gallery, .cia-large-grid-popup-wrapper #cia_large_save_gallery`).css('display', 'inline-flex');

    const showOnlyFav = !!$(`#${PANEL_CONTAINER_ID} #cia_gallery_filter_fav`).prop('checked');
    const isFav = !!item.isFavorited;

    // 1. Direct sidebar card DOM update to avoid full list reconstruction lag
    const sidebarCards = $(`#${PANEL_CONTAINER_ID} .cia-recycle-card[data-id="${item.id}"]`);
    if (sidebarCards.length) {
        if (showOnlyFav && !isFav) {
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
        if (largeGridMode === 'gallery' && showOnlyFav && !isFav) {
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
    const total = getActiveGalleryImages().length;
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

async function showPromptInspector() {
    const messageId = getLastAssistantMessageId();
    if (messageId === null) {
        toastr.warning(t`No character reply available to inspect.`, 'Context Image Assistant');
        return;
    }

    const settings = ensureSettings();
    const systemPrompt = substituteParams(settings.systemPrompt);
    const userPrompt = substituteParams(buildUserPrompt(messageId));
    const jsonSchema = JSON.stringify(stripSchemaConstraints(getEffectiveJsonSchema(settings)), null, 2);

    const popupContent = $(applyLocale(`
        <div class="cia-prompt-inspector-wrapper" style="width: 100%; display: flex; flex-direction: column; gap: 12px;">
            <div style="font-size: 0.95em; opacity: 0.85; margin-bottom: 4px;" data-i18n="Prompt Inspector Intro">This is the final raw prompt that would be sent to the planning LLM if generated at this moment.</div>
            
            <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-weight: 600;" data-i18n="System Prompt">System Prompt</span>
                <div class="cia-textarea-container" style="position: relative;">
                    <textarea readonly id="cia_inspect_sys" class="text_pole" style="width: 100%; height: 110px; font-family: monospace; font-size: 0.85em; resize: vertical; box-sizing: border-box; padding-right: 36px;"></textarea>
                    <button class="menu_button cia-copy-btn" data-target="#cia_inspect_sys" type="button" title="Copy System Prompt" data-i18n="[title]Copy System Prompt" style="position: absolute; top: 4px; right: 4px; margin: 0; padding: 2px 6px; font-size: 0.82em; height: auto; width: auto; min-height: 20px;">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            
            <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-weight: 600;" data-i18n="User Prompt & Context">User Prompt & Context</span>
                <div class="cia-textarea-container" style="position: relative;">
                    <textarea readonly id="cia_inspect_user" class="text_pole" style="width: 100%; height: 260px; font-family: monospace; font-size: 0.85em; resize: vertical; box-sizing: border-box; padding-right: 36px;"></textarea>
                    <button class="menu_button cia-copy-btn" data-target="#cia_inspect_user" type="button" title="Copy User Prompt" data-i18n="[title]Copy User Prompt" style="position: absolute; top: 4px; right: 4px; margin: 0; padding: 2px 6px; font-size: 0.82em; height: auto; width: auto; min-height: 20px;">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
            
            <div class="cia-field" style="display: flex; flex-direction: column; gap: 4px;">
                <span style="font-weight: 600;" data-i18n="JSON Schema Constraint">JSON Schema Constraint</span>
                <div class="cia-textarea-container" style="position: relative;">
                    <textarea readonly id="cia_inspect_schema" class="text_pole" style="width: 100%; height: 90px; font-family: monospace; font-size: 0.85em; resize: vertical; box-sizing: border-box; padding-right: 36px;"></textarea>
                    <button class="menu_button cia-copy-btn" data-target="#cia_inspect_schema" type="button" title="Copy JSON Schema" data-i18n="[title]Copy JSON Schema" style="position: absolute; top: 4px; right: 4px; margin: 0; padding: 2px 6px; font-size: 0.82em; height: auto; width: auto; min-height: 20px;">
                        <i class="fa-solid fa-copy"></i>
                    </button>
                </div>
            </div>
        </div>
    `));

    // Fill values safely using .val()
    popupContent.find('#cia_inspect_sys').val(systemPrompt);
    popupContent.find('#cia_inspect_user').val(userPrompt);
    popupContent.find('#cia_inspect_schema').val(jsonSchema);

    // Bind copy actions
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

    const popup = new Popup(popupContent, POPUP_TYPE.TEXT, t`Prompt Inspector`, {
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

    const renderCards = () => {
        const currentItems = mode === 'gallery' ? sortGalleryItemsForLargeGrid(getFilteredGalleryImages()) : getFilteredRecycleImages();
        popupContent.find('.cia-large-grid-count').text(currentItems.length);
        container.empty();

        if (currentItems.length === 0) {
            container.append($(applyLocale('<div class="cia-recycle-empty" style="width: 100%;" data-i18n="No images">No images</div>')));
            return;
        }

        currentItems.forEach((item) => {
            const isFavorited = !!item.isFavorited;
            const card = $(applyLocale(`
                <div class="cia-recycle-card cia-large-card" data-id="${escapeHtmlAttr(item.id)}">
                    <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" />
                    ${mode === 'gallery' ? `
                        <div class="cia-gallery-card-heart ${isFavorited ? 'favorited' : ''}" title="${isFavorited ? t('Remove from favorites') : t('Add to favorites')}">
                            <i class="${isFavorited ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                        </div>
                    ` : ''}
                    <div class="cia-recycle-actions">
                        ${mode === 'gallery' ? `
                            <button class="cia-recycle-btn btn-delete btn-recycle-active" type="button" title="Move to Recycle Bin" data-i18n="[title]Move to Recycle Bin"><i class="fa-solid fa-trash-can"></i></button>
                        ` : ''}
                        ${mode === 'recycle' ? `
                            <button class="cia-recycle-btn btn-restore" type="button" title="Restore to original floor" data-i18n="[title]Restore to original floor"><i class="fa-solid fa-arrow-rotate-left"></i></button>
                            <button class="cia-recycle-btn btn-delete" type="button" title="Permanently delete from disk" data-i18n="[title]Permanently delete from disk"><i class="fa-solid fa-trash-can"></i></button>
                        ` : ''}
                    </div>
                    <div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); font-size: 0.76em; padding: 4px 6px; display: flex; justify-content: center; pointer-events: none;">
                        <span style="opacity: 0.85;">${item.type === 'active' ? t`Floor #${item.floorNumber || item.msgId + 1}` : t`Recycled`}</span>
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

            container.append(card);
        });
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
    const total = getActiveGalleryImages().length;
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

    items.forEach(item => {
        const isFavorited = !!item.isFavorited;
        const card = $(applyLocale(`
            <div class="cia-recycle-card" data-id="${escapeHtmlAttr(item.id)}">
                <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" />
                <div class="cia-gallery-card-heart ${isFavorited ? 'favorited' : ''}" title="${isFavorited ? t('Remove from favorites') : t('Add to favorites')}">
                    <i class="${isFavorited ? 'fa-solid' : 'fa-regular'} fa-heart"></i>
                </div>
                <div class="cia-recycle-actions">
                    <button class="cia-recycle-btn btn-delete btn-recycle-active" type="button" title="Move to Recycle Bin" data-i18n="[title]Move to Recycle Bin"><i class="fa-solid fa-trash-can"></i></button>
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

        grid.append(card);
    });
}

function renderRecycleBinList() {
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

    items.forEach(item => {
        const card = $(applyLocale(`
            <div class="cia-recycle-card" data-id="${escapeHtmlAttr(item.id)}">
                <img src="${escapeHtmlAttr(item.url)}" class="cia-recycle-thumb" />
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

        grid.append(card);
    });
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
    const autoPipelineEnabled = Boolean(settings.enabled || settings.autoGenerate);
    if (!autoPipelineEnabled || type === 'extension') {
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
    setTimeout(renderAllMessageControls, 250);
    refreshImageManagementViews();
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
