const fs = require('fs');
const path = require('path');

console.log('开始测试主扩展激活...');

try {
    // 模拟 vscode API
    const vscodeMock = {
        commands: {
            registerCommand: (command, callback) => {
                console.log(`✅ 注册命令: ${command}`);
                return { dispose: () => {} };
            }
        },
        window: {
            createWebviewPanel: () => ({
                webview: {
                    html: '',
                    onDidReceiveMessage: () => ({ dispose: () => {} })
                },
                onDidDispose: () => ({ dispose: () => {} })
            })
        },
        languages: {
            registerCodeLensProvider: () => ({ dispose: () => {} })
        },
        workspace: {
            onDidChangeTextDocument: () => ({ dispose: () => {} })
        }
    };

    // 加载 qqq.js
    const qqqPath = path.join(__dirname, 'src', 'qqq.js');
    let content = fs.readFileSync(qqqPath, 'utf8');
    
    // 替换 vscode require 语句
    content = content.replace(/^const vscode = require\("vscode"\);/m, '');
    
    // 创建模块环境
    const moduleExports = {};
    const module = { exports: moduleExports };
    
    // 修改 require 路径
    content = content.replace(/require\('\.\/q1'\)/g, `require('${path.join(__dirname, 'src', 'q1.js')}')`);
    content = content.replace(/require\('\.\/q2'\)/g, `require('${path.join(__dirname, 'src', 'q2.js')}')`);
    
    // 在模拟的环境中执行代码
    const evalCode = `
        (function(module, exports, vscode) {
            ${content}
            return module.exports;
        })(module, moduleExports, vscodeMock)
    `;
    
    // 执行代码
    const result = eval(evalCode);
    
    console.log('✅ qqq.js 模块加载成功！');
    
    // 检查 activate 函数
    if (typeof result === 'object' && typeof result.activate === 'function') {
        console.log('✅ activate 函数存在');
        
        // 创建模拟的 context 对象
        const mockContext = {
            subscriptions: []
        };
        
        // 尝试调用 activate 函数
        try {
            result.activate(mockContext);
            console.log('✅ activate 函数执行成功');
            console.log(`✅ 总共注册了 ${mockContext.subscriptions.length} 个命令`);
        } catch (error) {
            console.error('❌ activate 函数执行失败:', error.message);
            console.error('错误堆栈:', error.stack);
        }
    } else {
        console.error('❌ activate 函数不存在或导出格式不正确');
        console.log('导出结果:', typeof result, result);
    }
} catch (error) {
    console.error('❌ 测试失败:', error.message);
    console.error('错误位置:', error.stack);
}