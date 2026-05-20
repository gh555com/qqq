// src/i18n/index.js
// 运行时国际化模块 - 支持实时语言切换
'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// 当前语言
let currentLang = 'zh';

// 语言包缓存
let locales = null;

// 扩展路径
let extensionPath = null;

// ★ Extension context for globalState access
let extensionContext = null;

// ★ 动态配置命名空间（与 global.js 同逻辑）
function _cfgNs() { return extensionContext?.extension?.packageJSON?.name || 'qqq'; }

// ★ Key for tracking first-time language initialization
const LANG_INIT_KEY = 'qqq_language_initialized';

// 语言代码映射 (qqq.language 设置值 → 语言文件名)
const LANG_MAP = {
    '中文': 'zh',
    '繁體中文': 'zh-tw',
    'English': 'en',
    '日本語': 'ja',
    'Deutsch': 'de',
    'Русский': 'ru',
    'العربية': 'ar',
    '한국어': 'ko',
    'Español': 'es',
    'Français': 'fr',
    'Português BR': 'pt-br',
    'हिन्दी': 'hi',
    'Tiếng Việt': 'vi'
};

// VS Code 语言 → 我们的语言代码
const VSCODE_LANG_MAP = {
    'zh-cn': 'zh',
    'zh-tw': 'zh-tw',
    'zh': 'zh',
    'en': 'en',
    'en-us': 'en',
    'en-gb': 'en',
    'ja': 'ja',
    'de': 'de',
    'ru': 'ru',
    'ar': 'ar',
    'ko': 'ko',
    'es': 'es',
    'fr': 'fr',
    'pt-br': 'pt-br',
    'pt': 'pt-br',
    'hi': 'hi',
    'vi': 'vi'
};

/**
 * 加载所有语言包（优化版：只预加载 zh 和 en，其他延迟加载）
 */
function loadAllLocales() {
    // 如果已经成功加载了语言包，直接返回
    if (locales && Object.keys(locales).length > 0 && locales['zh']) {
        return;
    }

    locales = {};

    // 尝试多个可能的路径
    const possibleDirs = [
        extensionPath ? path.join(extensionPath, 'src', 'i18n') : null,
        __dirname,
        path.join(__dirname, '..', 'i18n'),
        path.dirname(__filename || ''),
    ].filter(Boolean);

    // ★ Optimization: only preload essential languages (zh, en), others lazy-load
    const preloadLangs = ['zh', 'en'];
    let foundDir = null;

    for (const dir of possibleDirs) {
        try {
            const testFile = path.join(dir, 'zh.json');
            if (fs.existsSync(testFile)) {
                foundDir = dir;
                break;
            }
        } catch (e) {
            // ignore
        }
    }

    if (!foundDir) {
        console.error('[i18n] Could not find i18n directory! Tried:', possibleDirs);
        return;
    }

    // ★ Store foundDir for lazy loading
    _i18nDir = foundDir;

    // ★ Only preload zh and en for fast startup
    for (const lang of preloadLangs) {
        const filePath = path.join(foundDir, `${lang}.json`);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                locales[lang] = JSON.parse(content);
            }
        } catch (e) {
            locales[lang] = {};
        }
    }
}

// ★ i18n directory for lazy loading
let _i18nDir = null;

/**
 * Lazy load a language pack (called when switching language)
 */
function _lazyLoadLocale(lang) {
    if (locales[lang]) return locales[lang];
    if (!_i18nDir) return {};

    const filePath = path.join(_i18nDir, `${lang}.json`);
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            locales[lang] = JSON.parse(content);
            return locales[lang];
        }
    } catch (e) {
        console.error(`[i18n] Failed to lazy-load ${lang}.json:`, e.message);
    }
    locales[lang] = {};
    return locales[lang];
}

/**
 * 获取嵌套对象的值
 */
function getNestedValue(obj, keyPath) {
    if (!obj || typeof obj !== 'object') return undefined;

    // 先尝试直接匹配
    if (obj[keyPath] !== undefined) return obj[keyPath];

    // 嵌套路径
    const keys = keyPath.split('.');
    let value = obj;
    for (const k of keys) {
        if (value === null || value === undefined || typeof value !== 'object') {
            return undefined;
        }
        value = value[k];
    }
    return value;
}

/**
 * 获取翻译文本
 */
function q(key, ...args) {
    loadAllLocales();

    // ★ Lazy load current language if not preloaded
    const locale = locales[currentLang] || _lazyLoadLocale(currentLang);
    const fallback = locales['zh'] || {};

    let value = getNestedValue(locale, key);
    if (value === undefined) {
        value = getNestedValue(fallback, key);
    }
    if (value === undefined) {
        return key;
    }

    // 替换占位符 {0}, {1}, {2}, ...
    if (args.length > 0 && typeof value === 'string') {
        value = value.replace(/\{(\d+)\}/g, (match, index) => {
            const i = parseInt(index, 10);
            return i < args.length ? String(args[i]) : match;
        });
    }

    return value;
}

/**
 * 设置当前语言
 */
function setLanguage(lang) {
    const code = LANG_MAP[lang] || lang;
    if (code !== currentLang) {
        currentLang = code;
    }
}

/**
 * 获取当前语言代码
 */
function getLanguage() {
    return currentLang;
}

/**
 * 初始化 i18n 模块
 * @param {string} [extPath] - 扩展路径
 * @param {vscode.ExtensionContext} [context] - Extension context for globalState
 */
function init(extPath, context) {
    // 设置扩展路径
    if (extPath) {
        extensionPath = extPath;
    }

    // ★ Store context for globalState access
    if (context) {
        extensionContext = context;
    }

    // 先加载所有语言包
    loadAllLocales();

    // ★ Check if language was already initialized (persisted in globalState)
    const alreadyInitialized = extensionContext?.globalState?.get(LANG_INIT_KEY, false);

    const config = vscode.workspace.getConfiguration(_cfgNs());
    const langInspect = config.inspect('language');

    // Check if user has explicitly set the language
    const hasUserSetLang = langInspect && (
        langInspect.globalValue !== undefined ||
        langInspect.workspaceValue !== undefined ||
        langInspect.workspaceFolderValue !== undefined
    );

    if (hasUserSetLang) {
        // ★ User explicitly set a language → use it
        const userLang = config.get('language');
        if (userLang && LANG_MAP[userLang]) {
            setLanguage(userLang);
            console.log(`[i18n] Using user-set language: ${userLang} → ${currentLang}`);
        }
    } else if (alreadyInitialized) {
        // ★ Already initialized before, but user removed their setting → use default (zh)
        // This handles the case where globalState says "initialized" but settings.json has no value
        const defaultLang = config.get('language'); // Will be package.json default
        if (defaultLang && LANG_MAP[defaultLang]) {
            setLanguage(defaultLang);
            console.log(`[i18n] Using default language (already initialized): ${defaultLang} → ${currentLang}`);
        }
    } else {
        // ★ First time installation: auto-detect VS Code language and persist
        const vscodeLang = (vscode.env.language || 'en').toLowerCase();
        const mappedLang = VSCODE_LANG_MAP[vscodeLang] || 'en';

        // Find the display name for this language code
        const displayName = Object.entries(LANG_MAP).find(([k, v]) => v === mappedLang)?.[0];

        if (displayName) {
            // ★ Persist to user settings (globalValue) so it survives across sessions
            config.update('language', displayName, vscode.ConfigurationTarget.Global).then(() => {
                console.log(`[i18n] First-time init: persisted language to settings: ${displayName}`);
            }).catch(e => {
                console.error(`[i18n] Failed to persist language setting:`, e);
            });

            setLanguage(mappedLang);
        } else {
            // Fallback to English if no mapping found
            config.update('language', 'English', vscode.ConfigurationTarget.Global).catch(() => {});
            setLanguage('en');
        }

        // ★ Mark as initialized in globalState
        extensionContext?.globalState?.update(LANG_INIT_KEY, true);
        console.log(`[i18n] First-time auto-detected: VS Code ${vscodeLang} → ${mappedLang}, persisted to settings`);
    }

    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration(`${_cfgNs()}.language`)) {
            const newLang = vscode.workspace.getConfiguration(_cfgNs()).get('language');
            if (newLang && LANG_MAP[newLang]) {
                setLanguage(newLang);
                onLanguageChange.fire(currentLang);
            }
        }
    });
}

// 语言变更事件发射器
const onLanguageChange = new vscode.EventEmitter();

/**
 * 清除语言包缓存
 */
function clearCache() {
    locales = null;
}

module.exports = {
    q,
    setLanguage,
    getLanguage,
    init,
    clearCache,
    onLanguageChange: onLanguageChange.event,
    LANG_MAP,
    VSCODE_LANG_MAP
};
