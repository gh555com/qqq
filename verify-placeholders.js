#!/usr/bin/env node

/**
 * 验证 q2.html 占位符修复
 */

const fs = require('fs');
const path = require('path');

console.log('===== q2.html 占位符验证 =====\n');

const htmlPath = path.join(__dirname, 'src', 'q2.html');
const content = fs.readFileSync(htmlPath, 'utf8');

// 检查占位符格式
const placeholders = [
	'SIDEBAR_WIDTH',
	'LINE_SPACING',
	'DRIVES_HTML',
	'RECYCLE_BIN_HTML',
	'RECENT_DIRS_HTML',
	'CURRENT_PATH',
	'PIN_CLASS',
	'PIN_CHECKBOX',
	'SIZE_MODE_NONE_CLASS',
	'SIZE_MODE_M_CLASS',
	'SIZE_MODE_K_CLASS',
	'SIZE_MODE_B_CLASS',
	'INLINE_SCRIPT'
];

let allPass = true;

placeholders.forEach(placeholder => {
	const correctFormat = `{{${placeholder}}}`;
	const badFormat1 = new RegExp(`\\{\\s+\\{\\s+${placeholder}`, 'g');
	const badFormat2 = new RegExp(`${placeholder}\\s+\\}\\s+\\}`, 'g');

	if (content.includes(correctFormat)) {
		console.log(`✅ ${placeholder} - 格式正确`);
	} else {
		console.log(`❌ ${placeholder} - 未找到或格式错误`);
		allPass = false;
	}

	if (badFormat1.test(content) || badFormat2.test(content)) {
		console.log(`   ⚠️  发现带空格的占位符！`);
		allPass = false;
	}
});

console.log('\n===== 验证结果 =====\n');

if (allPass) {
	console.log('🎉 所有占位符格式正确！\n');
	process.exit(0);
} else {
	console.log('❌ 存在格式错误的占位符\n');
	process.exit(1);
}
