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

// 语言代码映射 (qqq.language 设置值 → 语言文件名)
const LANG_MAP = {
    '中文': 'zh',
    'English': 'en',
    '日本語': 'ja',
    'Deutsch': 'de',
    'Русский': 'ru',
    'العربية': 'ar'
};

// VS Code 语言 → 我们的语言代码
const VSCODE_LANG_MAP = {
    'zh-cn': 'zh',
    'zh-tw': 'zh',
    'zh': 'zh',
    'en': 'en',
    'en-us': 'en',
    'en-gb': 'en',
    'ja': 'ja',
    'de': 'de',
    'ru': 'ru',
    'ar': 'ar'
};

/**
 * 加载所有语言包
 */
function loadAllLocales() {
    if (locales) return;

    locales = {};

    // 尝试多个可能的路径
    const possibleDirs = [
        extensionPath ? path.join(extensionPath, 'src', 'i18n') : null,
        __dirname,
        path.join(__dirname, '..', 'i18n'),
        path.dirname(__filename || ''),
    ].filter(Boolean);

    const langFiles = ['zh', 'en', 'ja', 'ar', 'de', 'ru'];
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

    console.log('[i18n] Found i18n directory:', foundDir);

    for (const lang of langFiles) {
        const filePath = path.join(foundDir, `${lang}.json`);
        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                locales[lang] = JSON.parse(content);
                console.log(`[i18n] Loaded ${lang}.json, keys:`, Object.keys(locales[lang]));
            }
        } catch (e) {
            console.error(`[i18n] Failed to load ${lang}.json:`, e.message);
            locales[lang] = {};
        }
    }
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

    const locale = locales[currentLang] || {};
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
 */
function init(extPath) {
    // 设置扩展路径
    if (extPath) {
        extensionPath = extPath;
    }

    // 先加载所有语言包
    loadAllLocales();

    // 读取用户设置
    const config = vscode.workspace.getConfiguration('qqq');
    const userLang = config.get('language');

    if (userLang && LANG_MAP[userLang]) {
        setLanguage(userLang);
    } else {
        // 跟随 VS Code 显示语言
        const vscodeLang = (vscode.env.language || 'en').toLowerCase();
        const mappedLang = VSCODE_LANG_MAP[vscodeLang] || 'en';
        setLanguage(mappedLang);
    }

    // 监听配置变更
    vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('qqq.language')) {
            const newLang = vscode.workspace.getConfiguration('qqq').get('language');
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
