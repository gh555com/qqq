// src/i18n/index.js
// 运行时国际化模块 - 支持实时语言切换
'use strict';

const vscode = require('vscode');
const path = require('path');

// 语言包缓存
const locales = {};

// 当前语言
let currentLang = 'zh';

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
 * 加载语言包
 */
function loadLocale(lang) {
  if (locales[lang]) return locales[lang];
  
  try {
    const filePath = path.join(__dirname, `${lang}.json`);
    // 使用 require 加载 JSON，Node 会自动解析
    delete require.cache[require.resolve(filePath)]; // 清除缓存以支持热重载
    locales[lang] = require(filePath);
  } catch (e) {
    console.warn(`[i18n] Failed to load locale "${lang}":`, e.message);
    locales[lang] = {};
  }
  
  return locales[lang];
}

/**
 * 获取翻译文本
 * @param {string} key - 翻译键，支持点号分隔的嵌套路径，如 'q2.error.fileExists'
 * @param {...any} args - 占位符参数，支持 {0}, {1} 等格式
 * @returns {string} 翻译后的文本
 */
function t(key, ...args) {
  const locale = loadLocale(currentLang);
  const fallback = loadLocale('zh'); // 中文作为回退
  
  // 支持嵌套键，如 'q2.error.fileExists'
  let value = getNestedValue(locale, key);
  if (value === undefined) {
    value = getNestedValue(fallback, key);
  }
  if (value === undefined) {
    console.warn(`[i18n] Missing translation for key: "${key}"`);
    return key; // 返回 key 本身作为最后回退
  }
  
  // 替换占位符 {0}, {1}, {2}, ...
  if (args.length > 0) {
    value = value.replace(/\{(\d+)\}/g, (match, index) => {
      const i = parseInt(index, 10);
      return i < args.length ? String(args[i]) : match;
    });
  }
  
  return value;
}

/**
 * 获取嵌套对象的值
 */
function getNestedValue(obj, keyPath) {
  if (!obj) return undefined;
  
  // 先尝试直接匹配（支持扁平键）
  if (obj[keyPath] !== undefined) return obj[keyPath];
  
  // 再尝试嵌套路径
  const keys = keyPath.split('.');
  let value = obj;
  for (const k of keys) {
    if (value === null || value === undefined) return undefined;
    value = value[k];
  }
  return value;
}

/**
 * 设置当前语言
 * @param {string} lang - 语言代码或显示名称
 */
function setLanguage(lang) {
  // 如果是显示名称（如 "中文"），转换为代码
  const code = LANG_MAP[lang] || lang;
  
  if (code !== currentLang) {
    currentLang = code;
    // 预加载语言包
    loadLocale(code);
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
 * - 读取 qqq.language 设置
 * - 如果未设置，使用 VS Code 显示语言
 * - 监听配置变更实现实时切换
 */
function init() {
  // 1. 读取用户设置
  const config = vscode.workspace.getConfiguration('qqq');
  const userLang = config.get('language');
  
  if (userLang && LANG_MAP[userLang]) {
    // 用户明确设置了语言
    setLanguage(userLang);
  } else {
    // 跟随 VS Code 显示语言
    const vscodeLang = vscode.env.language.toLowerCase();
    const mappedLang = VSCODE_LANG_MAP[vscodeLang] || 'en';
    setLanguage(mappedLang);
  }
  
  // 2. 监听配置变更，实现实时切换
  vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('qqq.language')) {
      const newLang = vscode.workspace.getConfiguration('qqq').get('language');
      if (newLang && LANG_MAP[newLang]) {
        setLanguage(newLang);
        // 触发语言变更事件，让各模块可以响应
        onLanguageChange.fire(currentLang);
      }
    }
  });
}

// 语言变更事件发射器
const onLanguageChange = new vscode.EventEmitter();

/**
 * 清除语言包缓存（用于开发调试）
 */
function clearCache() {
  Object.keys(locales).forEach(k => delete locales[k]);
}

// 导出
module.exports = {
  t,
  setLanguage,
  getLanguage,
  init,
  clearCache,
  onLanguageChange: onLanguageChange.event,
  LANG_MAP,
  VSCODE_LANG_MAP
};
