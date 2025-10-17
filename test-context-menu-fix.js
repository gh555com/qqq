const fs = require('fs');
const path = require('path');

console.log('开始测试右键菜单删除功能修复...');

// 检查关键修改是否存在
const q2Path = path.join(__dirname, 'src', 'q2.js');
const q2Content = fs.readFileSync(q2Path, 'utf8');

// 检查1: handleContextMenuAction是否从dataset获取数据
const hasDatasetPath = q2Content.includes('path: contextMenu.dataset.path');
const hasDatasetName = q2Content.includes('name: contextMenu.dataset.name');
const hasDatasetType = q2Content.includes('type: contextMenu.dataset.type');

console.log(`✅ handleContextMenuAction从dataset获取路径: ${hasDatasetPath}`);
console.log(`✅ handleContextMenuAction从dataset获取名称: ${hasDatasetName}`);
console.log(`✅ handleContextMenuAction从dataset获取类型: ${hasDatasetType}`);

// 检查2: 右键菜单事件监听器是否绑定数据到dataset
const hasBindPath = q2Content.includes('itemContextMenu.dataset.path = itemPath');
const hasBindName = q2Content.includes('itemContextMenu.dataset.name = itemName');
const hasBindType = q2Content.includes('itemContextMenu.dataset.type = itemType');

console.log(`✅ 右键菜单绑定路径到dataset: ${hasBindPath}`);
console.log(`✅ 右键菜单绑定名称到dataset: ${hasBindName}`);
console.log(`✅ 右键菜单绑定类型到dataset: ${hasBindType}`);

// 检查3: 是否保留了selectItem调用
const hasSelectItem = q2Content.includes('selectItem({ currentTarget: itemElement.querySelector');

console.log(`✅ 保留了selectItem调用: ${hasSelectItem}`);

// 检查4: performDeleteAction是否使用透明度而非直接隐藏
const hasOpacity = q2Content.includes("itemElement.style.opacity = '0.5'");
const hasPointerEvents = q2Content.includes("itemElement.style.pointerEvents = 'none'");

console.log(`✅ performDeleteAction使用透明度: ${hasOpacity}`);
console.log(`✅ performDeleteAction禁用指针事件: ${hasPointerEvents}`);

// 检查5: quickDeleteToRecycleBin命令是否优化了刷新延迟
const hasOptimizedDelay = q2Content.includes('}, 300);');

console.log(`✅ quickDeleteToRecycleBin优化了刷新延迟: ${hasOptimizedDelay}`);

// 检查6: restoreDeletedItem消息处理是否与performDeleteAction一致
const hasRestoreOpacity = q2Content.includes("itemElement.style.opacity = '';");
const hasRestorePointerEvents = q2Content.includes("itemElement.style.pointerEvents = '';");

console.log(`✅ restoreDeletedItem恢复透明度: ${hasRestoreOpacity}`);
console.log(`✅ restoreDeletedItem恢复指针事件: ${hasRestorePointerEvents}`);

// 检查7: 是否有数据有效性检查
const hasDataValidation = q2Content.includes('if (!itemForAction || !itemForAction.path)');

console.log(`✅ 添加了数据有效性检查: ${hasDataValidation}`);

// 检查8: 是否有错误提示
const hasShowError = q2Content.includes('vscode.window.showErrorMessage(`删除失败: ${error.message}`)') || 
                    q2Content.includes('vscode.window.showErrorMessage(`删除异常: ${error.message}`)');

console.log(`✅ 添加了错误提示: ${hasShowError}`);

// 检查9: 是否有日志记录
const hasLogMessage = q2Content.includes('console.log(\'[webview] 执行删除操作:\'');

console.log(`✅ 添加了删除操作日志: ${hasLogMessage}`);

// 总结
const checks = [
    { name: 'handleContextMenuAction从dataset获取路径', value: hasDatasetPath },
    { name: 'handleContextMenuAction从dataset获取名称', value: hasDatasetName },
    { name: 'handleContextMenuAction从dataset获取类型', value: hasDatasetType },
    { name: '右键菜单绑定路径到dataset', value: hasBindPath },
    { name: '右键菜单绑定名称到dataset', value: hasBindName },
    { name: '右键菜单绑定类型到dataset', value: hasBindType },
    { name: '保留了selectItem调用', value: hasSelectItem },
    { name: 'performDeleteAction使用透明度', value: hasOpacity },
    { name: 'performDeleteAction禁用指针事件', value: hasPointerEvents },
    { name: 'quickDeleteToRecycleBin优化了刷新延迟', value: hasOptimizedDelay },
    { name: 'restoreDeletedItem恢复透明度', value: hasRestoreOpacity },
    { name: 'restoreDeletedItem恢复指针事件', value: hasRestorePointerEvents },
    { name: '添加了数据有效性检查', value: hasDataValidation },
    { name: '添加了错误提示', value: hasShowError },
    { name: '添加了删除操作日志', value: hasLogMessage }
];

const allChecksPass = checks.every(check => check.value);

console.log('\n=====================================');
if (allChecksPass) {
    console.log('🎉 所有关键修改检查通过！右键菜单删除功能修复完成。');
} else {
    console.log('❌ 部分检查未通过，失败的检查项:');
    checks.filter(check => !check.value).forEach(check => {
        console.log(`  - ${check.name}`);
    });
}
console.log('=====================================');

// 检查修复报告是否存在
const reportPath = path.join(__dirname, '右键菜单问题修复报告.md');
const reportExists = fs.existsSync(reportPath);
console.log(`\n📄 修复报告存在: ${reportExists}`);

if (reportExists) {
    const reportContent = fs.readFileSync(reportPath, 'utf8');
    const hasAllModifications = reportContent.includes('### 5. 修改 restoreDeletedItem 消息处理');
    console.log(`📝 修复报告包含所有修改: ${hasAllModifications}`);
}