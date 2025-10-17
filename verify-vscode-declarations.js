// 验证所有模块的 vscode 声明是否正确
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, 'src');

const files = {
	'qqq.js': { shouldHaveVscode: false, reason: '主入口，只需要 fs 和 path' },
	'q1.js': { shouldHaveVscode: true, reason: 'q1 模块需要 vscode API' },
	'q2.js': { shouldHaveVscode: true, reason: 'q2 模块需要 vscode API' }
};

console.log('\n========== 模块 vscode 声明验证 ==========\n');

let allPassed = true;

for (const [fileName, expected] of Object.entries(files)) {
	const filePath = path.join(srcDir, fileName);

	if (!fs.existsSync(filePath)) {
		console.log(`❌ ${fileName}: 文件不存在`);
		allPassed = false;
		continue;
	}

	const content = fs.readFileSync(filePath, 'utf8');
	const lines = content.split('\n');

	// 查找所有 vscode 声明
	const vscodeDeclarations = [];
	lines.forEach((line, index) => {
		if (line.match(/^\s*const\s+vscode\s*=\s*require\s*\(\s*["']vscode["']\s*\)/)) {
			vscodeDeclarations.push(index + 1);
		}
	});

	const hasVscode = vscodeDeclarations.length > 0;
	const hasDuplicate = vscodeDeclarations.length > 1;

	// 验证是否符合预期
	if (hasVscode !== expected.shouldHaveVscode) {
		console.log(`❌ ${fileName}: `);
		console.log(`   预期: ${expected.shouldHaveVscode ? '应该有' : '不应该有'} vscode 声明`);
		console.log(`   实际: ${hasVscode ? '有' : '没有'} vscode 声明`);
		console.log(`   原因: ${expected.reason}`);
		allPassed = false;
	} else if (hasDuplicate) {
		console.log(`❌ ${fileName}: 存在重复的 vscode 声明！`);
		console.log(`   声明位置: 第 ${vscodeDeclarations.join(', ')} 行`);
		allPassed = false;
	} else {
		console.log(`✅ ${fileName}: vscode 声明正确`);
		if (hasVscode) {
			console.log(`   声明位置: 第 ${vscodeDeclarations[0]} 行`);
		}
		console.log(`   说明: ${expected.reason}`);
	}

	console.log();
}

console.log('\n========== 验证结果 ==========\n');

if (allPassed) {
	console.log('✅ 所有模块的 vscode 声明都正确！');
	console.log('\n可以安全地重新加载窗口测试扩展。');
	process.exit(0);
} else {
	console.log('❌ 发现问题，请检查上述错误。');
	process.exit(1);
}
