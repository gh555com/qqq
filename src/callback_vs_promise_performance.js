const fs = require('fs');
const path = require('path');

// 测试文件路径
const testFile = __filename; // 使用当前文件作为测试对象

// 回调风格的实现
function getFileSizeCallback(filePath, callback) {
    fs.stat(filePath, (err, stats) => {
        if (err) {
            callback(null);
            return;
        }
        callback(stats.size);
    });
}

// Promise风格的实现
function getFileSizePromise(filePath) {
    return new Promise((resolve, reject) => {
        fs.stat(filePath, (err, stats) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(stats.size);
        });
    });
}

// 性能测试函数
async function performanceTest() {
    const iterations = 10000; // 迭代次数
    
    console.log(`开始性能测试，迭代次数: ${iterations}`);
    console.log('测试文件:', testFile);
    console.log('');
    
    // 测试回调风格
    console.time('回调风格总耗时');
    let callbackResults = 0;
    let callbackErrors = 0;
    
    for (let i = 0; i < iterations; i++) {
        await new Promise(resolve => {
            getFileSizeCallback(testFile, (size) => {
                if (size !== null) {
                    callbackResults++;
                } else {
                    callbackErrors++;
                }
                resolve();
            });
        });
    }
    
    console.timeEnd('回调风格总耗时');
    console.log(`回调成功: ${callbackResults}, 失败: ${callbackErrors}`);
    
    // 测试Promise风格
    console.time('Promise风格总耗时');
    let promiseResults = 0;
    let promiseErrors = 0;
    
    for (let i = 0; i < iterations; i++) {
        try {
            await getFileSizePromise(testFile);
            promiseResults++;
        } catch (e) {
            promiseErrors++;
        }
    }
    
    console.timeEnd('Promise风格总耗时');
    console.log(`Promise成功: ${promiseResults}, 失败: ${promiseErrors}`);
    
    console.log('');
    console.log('性能测试完成');
}

// 运行测试
performanceTest().catch(console.error);