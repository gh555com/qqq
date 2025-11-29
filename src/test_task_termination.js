// 测试任务终止机制的有效性和资源使用情况

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

// 导入我们的模块
const { folderSizeTasks } = require('./q2.js');

// 测试函数
async function testTaskTermination() {
    console.log('开始测试任务终止机制...');
    
    // 创建一个测试文件夹路径
    const testPath = 'C:\\Windows\\System32'; // 一个较大的文件夹，用于测试
    
    // 1. 测试添加任务
    console.log('1. 测试添加任务...');
    const taskId1 = folderSizeTasks.addTask('python', ['kp.py', 'get_size', testPath]);
    const taskId2 = folderSizeTasks.addTask('python', ['kp.py', 'get_size', testPath]);
    
    console.log(`已添加任务: ${taskId1}, ${taskId2}`);
    console.log(`当前任务数量: ${folderSizeTasks.tasks.size}`);
    
    // 2. 等待一小段时间，让任务开始执行
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 3. 测试终止单个任务
    console.log('3. 测试终止单个任务...');
    const terminated = folderSizeTasks.terminateTask(taskId1);
    console.log(`任务 ${taskId1} 终止结果: ${terminated}`);
    console.log(`当前任务数量: ${folderSizeTasks.tasks.size}`);
    
    // 4. 测试终止所有任务
    console.log('4. 测试终止所有任务...');
    const terminatedCount = folderSizeTasks.terminateAllTasks();
    console.log(`终止的任务数量: ${terminatedCount}`);
    console.log(`当前任务数量: ${folderSizeTasks.tasks.size}`);
    
    // 5. 测试资源使用情况
    console.log('5. 测试资源使用情况...');
    
    // 添加多个任务
    const taskIds = [];
    for (let i = 0; i < 5; i++) {
        const id = folderSizeTasks.addTask('python', ['kp.py', 'get_size', testPath]);
        taskIds.push(id);
    }
    
    console.log(`已添加 ${taskIds.length} 个任务`);
    console.log(`当前任务数量: ${folderSizeTasks.tasks.size}`);
    
    // 记录内存使用情况
    const memBefore = process.memoryUsage();
    console.log('终止前内存使用:', {
        rss: `${Math.round(memBefore.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memBefore.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memBefore.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memBefore.external / 1024 / 1024)} MB`
    });
    
    // 终止所有任务
    const terminatedAllCount = folderSizeTasks.terminateAllTasks();
    console.log(`终止的任务数量: ${terminatedAllCount}`);
    
    // 等待一段时间，让资源释放
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 再次记录内存使用情况
    const memAfter = process.memoryUsage();
    console.log('终止后内存使用:', {
        rss: `${Math.round(memAfter.rss / 1024 / 1024)} MB`,
        heapTotal: `${Math.round(memAfter.heapTotal / 1024 / 1024)} MB`,
        heapUsed: `${Math.round(memAfter.heapUsed / 1024 / 1024)} MB`,
        external: `${Math.round(memAfter.external / 1024 / 1024)} MB`
    });
    
    console.log('内存变化:', {
        rss: `${Math.round((memAfter.rss - memBefore.rss) / 1024 / 1024)} MB`,
        heapTotal: `${Math.round((memAfter.heapTotal - memBefore.heapTotal) / 1024 / 1024)} MB`,
        heapUsed: `${Math.round((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024)} MB`,
        external: `${Math.round((memAfter.external - memBefore.external) / 1024 / 1024)} MB`
    });
    
    console.log('测试完成!');
}

// 导出测试函数
module.exports = {
    testTaskTermination
};