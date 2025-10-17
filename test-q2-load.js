const path = require('path');

console.log('开始测试 q2.js 模块加载...');

try {
  const q2Path = path.join(__dirname, 'src', 'q2.js');
  console.log('尝试加载:', q2Path);
  
  // 删除 require 缓存
  delete require.cache[require.resolve(q2Path)];
  
  const q2 = require(q2Path);
  console.log('q2 模块加载成功');
  console.log('q2 模块导出:', Object.keys(q2));
  
  if (typeof q2.activate === 'function') {
    console.log('q2.activate 是函数');
  } else {
    console.log('q2.activate 不是函数');
  }
} catch (error) {
  console.error('加载 q2 模块失败:', error);
  console.error('错误堆栈:', error.stack);
}