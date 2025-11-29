const trash = require('trash');
const fs = require('fs');
const path = require('path');

// 创建一个测试文件
const testFilePath = path.join(__dirname, 'test-delete-me.txt');
fs.writeFileSync(testFilePath, 'This is a test file for deletion.');

console.log('测试文件已创建:', testFilePath);

// 测试删除功能
async function testTrash() {
    try {
        console.log('开始测试删除功能...');
        await trash([testFilePath]);
        console.log('删除成功!');
        
        // 检查文件是否还存在
        if (fs.existsSync(testFilePath)) {
            console.log('警告: 文件仍然存在');
        } else {
            console.log('确认: 文件已被删除');
        }
    } catch (error) {
        console.error('删除失败:', error);
    }
}

testTrash();