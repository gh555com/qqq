// 测试分割线位置和右键删除功能修复
const fs = require('fs');
const path = require('path');

console.log('测试分割线位置和右键删除功能修复...\n');

// 1. 检查q2.js文件中的修改
console.log('1. 检查q2.js文件中的修改...');
const q2JsPath = path.join(__dirname, 'src', 'q2.js');
const q2JsContent = fs.readFileSync(q2JsPath, 'utf8');

// 检查performDeleteAction函数是否已修改（移除了预先隐藏元素的代码）
const performDeleteActionMatch = q2JsContent.match(/function performDeleteAction\(itemToDelete\)[\s\S]*?vscode\.postMessage\({[\s\S]*?command: 'deleteToRecycleBin'[\s\S]*?}\);/);
if (performDeleteActionMatch) {
    const performDeleteActionCode = performDeleteActionMatch[0];
    const hasHiddenCode = performDeleteActionCode.includes('style.display = \'none\'');
    
    if (hasHiddenCode) {
        console.log('❌ performDeleteAction函数仍包含预先隐藏元素的代码');
    } else {
        console.log('✅ performDeleteAction函数已正确修改，移除了预先隐藏元素的代码');
    }
} else {
    console.log('❌ 无法找到performDeleteAction函数');
}

// 检查分割线初始化代码是否已添加
const sidebarInitMatch = q2JsContent.match(/if \(sidebarResizer && sidebar && mainContent\) \{[\s\S]*?初始化分割线位置[\s\S]*?sidebarResizer\.style\.left = sidebarWidth \+ 'px';[\s\S]*?mainContent\.style\.left = sidebarWidth \+ 'px';/);
if (sidebarInitMatch) {
    console.log('✅ 分割线初始化代码已正确添加');
} else {
    console.log('❌ 分割线初始化代码未找到或不完整');
}

// 2. 检查q2.html文件中的占位符
console.log('\n2. 检查q2.html文件中的占位符...');
const q2HtmlPath = path.join(__dirname, 'src', 'q2.html');
const q2HtmlContent = fs.readFileSync(q2HtmlPath, 'utf8');

// 检查是否包含{{SIDEBAR_WIDTH}}占位符
const hasSidebarWidthPlaceholder = q2HtmlContent.includes('{{SIDEBAR_WIDTH}}');
if (hasSidebarWidthPlaceholder) {
    console.log('✅ q2.html文件包含{{SIDEBAR_WIDTH}}占位符');
    
    // 检查具体位置
    const sidebarMatch = q2HtmlContent.match(/\.sidebar\s*\{[^}]*width:\s*{{SIDEBAR_WIDTH}}px[^}]*\}/);
    const resizerMatch = q2HtmlContent.match(/\.sidebar-resizer\s*\{[^}]*left:\s*{{SIDEBAR_WIDTH}}px[^}]*\}/);
    const mainContentMatch = q2HtmlContent.match(/\.main-content\s*\{[^}]*left:\s*{{SIDEBAR_WIDTH}}px[^}]*\}/);
    
    if (sidebarMatch) {
        console.log('✅ .sidebar样式包含{{SIDEBAR_WIDTH}}占位符');
    } else {
        console.log('❌ .sidebar样式不包含{{SIDEBAR_WIDTH}}占位符');
    }
    
    if (resizerMatch) {
        console.log('✅ .sidebar-resizer样式包含{{SIDEBAR_WIDTH}}占位符');
    } else {
        console.log('❌ .sidebar-resizer样式不包含{{SIDEBAR_WIDTH}}占位符');
    }
    
    if (mainContentMatch) {
        console.log('✅ .main-content样式包含{{SIDEBAR_WIDTH}}占位符');
    } else {
        console.log('❌ .main-content样式不包含{{SIDEBAR_WIDTH}}占位符');
    }
} else {
    console.log('❌ q2.html文件不包含{{SIDEBAR_WIDTH}}占位符');
}

// 3. 检查getWebviewContent函数是否正确替换占位符
console.log('\n3. 检查getWebviewContent函数是否正确替换占位符...');
const getWebviewContentMatch = q2JsContent.match(/function getWebviewContent\(currentPath\) [\s\S]*?htmlTemplate = htmlTemplate\.replace\(\/\\{\\{SIDEBAR_WIDTH\\}\\}\/g, SIDEBAR_WIDTH\);/);
if (getWebviewContentMatch) {
    console.log('✅ getWebviewContent函数正确替换{{SIDEBAR_WIDTH}}占位符');
} else {
    console.log('❌ getWebviewContent函数未正确替换{{SIDEBAR_WIDTH}}占位符');
}

// 总结
console.log('\n总结:');
console.log('1. 右键删除功能修复：移除了预先隐藏元素的代码，确保删除操作完成后才更新界面');
console.log('2. 分割线位置修复：添加了初始化代码，确保分割线和主内容区的位置与侧边栏宽度一致');
console.log('\n请在VS Code中测试以下功能：');
console.log('1. 打开qqq new新建对话框，检查分割线位置是否正确');
console.log('2. 尝试拖动分割线，检查是否正常工作');
console.log('3. 关闭并重新打开对话框，检查分割线位置是否保持');
console.log('4. 右键点击文件并选择删除，检查是否正常删除（不会恢复）');