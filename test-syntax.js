const fs = require('fs');
const path = require('path');

console.log('开始测试 q2.js 语法...');

try {
    const q2Path = path.join(__dirname, 'src', 'q2.js');
    const content = fs.readFileSync(q2Path, 'utf8');
    
    // 尝试解析语法
    new Function(content);
    
    console.log('✅ q2.js 语法检查通过！');
    console.log('文件大小:', content.length, '字符');
} catch (error) {
    console.error('❌ q2.js 语法错误:', error.message);
    console.error('错误位置:', error.stack);
}