// 剪切板历史功能测试
const ClipboardHistoryManager = require('../src/clipboard-history');

// 模拟 VS Code 上下文
const mockContext = {
    globalState: {
        get: function (key, defaultValue) {
            return this.data[key] || defaultValue;
        },
        update: function (key, value) {
            this.data[key] = value;
            return Promise.resolve();
        },
        data: {}
    }
};

async function runTest() {
    console.log('🚀 开始测试剪切板历史功能...');

    // 创建管理器实例
    const manager = new ClipboardHistoryManager(mockContext);

    // 测试添加历史记录
    console.log('\n📝 测试添加历史记录...');
    manager.addToHistory('测试文本内容');
    manager.addToHistory('https://www.example.com');
    manager.addToHistory('user@example.com');
    manager.addToHistory('function test() { return "hello"; }');

    // 测试获取历史记录
    console.log('\n📋 测试获取历史记录...');
    const history = manager.getHistory();
    console.log(`历史记录数量: ${history.length}`);

    history.forEach((item, index) => {
        console.log(`${index + 1}. [${item.type}] ${item.preview} (${manager.getFormattedTime(item.timestamp)})`);
    });

    // 测试类型检测
    console.log('\n🔍 测试内容类型检测...');
    const testCases = [
        '普通文本内容',
        'https://www.google.com',
        '/path/to/file.txt',
        'user@example.com',
        'function hello() { console.log("world"); }'
    ];

    testCases.forEach(content => {
        const type = manager.detectContentType(content);
        console.log(`"${content.substring(0, 30)}..." -> ${type}`);
    });

    // 测试统计信息
    console.log('\n📊 测试统计信息...');
    const stats = manager.getStats();
    console.log(`总计: ${stats.totalCount} 项`);
    console.log('类型分布:', stats.typeCounts);

    console.log('\n✅ 所有测试完成！');
}

// 运行测试
runTest().catch(console.error);