const fs = require('fs');
const path = require('path');

console.log('=== 测试扩展激活修复 ===\n');

// 检查package.json中的入口点
try {
    const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    console.log('✅ package.json入口点:', packageJson.main);
    
    if (packageJson.main === './src/qqq.js') {
        console.log('✅ 入口点配置正确');
    } else {
        console.log('❌ 入口点配置错误，应该是./src/qqq.js');
    }
} catch (error) {
    console.log('❌ 读取package.json失败:', error.message);
}

// 检查qqq.js是否正确导入q1和q2
try {
    const qqqContent = fs.readFileSync('./src/qqq.js', 'utf8');
    if (qqqContent.includes("const q1 = require('./q1')")) {
        console.log('✅ qqq.js正确导入q1模块');
    } else {
        console.log('❌ qqq.js未正确导入q1模块');
    }
    
    if (qqqContent.includes("const q2 = require('./q2')")) {
        console.log('✅ qqq.js正确导入q2模块');
    } else {
        console.log('❌ qqq.js未正确导入q2模块');
    }
} catch (error) {
    console.log('❌ 读取qqq.js失败:', error.message);
}

// 检查q1.js是否有循环依赖
try {
    const q1Content = fs.readFileSync('./src/q1.js', 'utf8');
    if (q1Content.includes("require('./qqq')")) {
        console.log('❌ q1.js存在循环依赖');
    } else {
        console.log('✅ q1.js无循环依赖');
    }
    
    if (q1Content.includes('function logMessage')) {
        console.log('✅ q1.js已定义logMessage函数');
    } else {
        console.log('❌ q1.js未定义logMessage函数');
    }
} catch (error) {
    console.log('❌ 读取q1.js失败:', error.message);
}

// 检查q2.js是否有循环依赖
try {
    const q2Content = fs.readFileSync('./src/q2.js', 'utf8');
    if (q2Content.includes("require('./qqq')")) {
        console.log('❌ q2.js存在循环依赖');
    } else {
        console.log('✅ q2.js无循环依赖');
    }
    
    if (q2Content.includes('function logMessage')) {
        console.log('✅ q2.js已定义logMessage函数');
    } else {
        console.log('❌ q2.js未定义logMessage函数');
    }
} catch (error) {
    console.log('❌ 读取q2.js失败:', error.message);
}

// 检查q2.js是否注册了qqq.q2命令
try {
    const q2Content = fs.readFileSync('./src/q2.js', 'utf8');
    if (q2Content.includes('vscode.commands.registerCommand("qqq.q2"')) {
        console.log('✅ q2.js已注册qqq.q2命令');
    } else {
        console.log('❌ q2.js未注册qqq.q2命令');
    }
} catch (error) {
    console.log('❌ 读取q2.js失败:', error.message);
}

console.log('\n=== 测试完成 ===');