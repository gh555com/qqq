#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class LocalAIReleaseAssistant {
    constructor() {
        this.repoPath = process.cwd();
        console.log('🤖 本地AI发布助手已启动');
        console.log('请输入指令：q3 / q1 / q2');
    }

    // 执行git命令
    execGit(command) {
        try {
            const result = execSync(`git ${command}`, {
                cwd: this.repoPath,
                encoding: 'utf8'
            });
            return result.trim();
        } catch (error) {
            console.error('❌ Git命令执行失败:', error.message);
            return null;
        }
    }

    // 获取当前版本
    getCurrentVersion() {
        try {
            const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
            return packageJson.version;
        } catch (error) {
            console.error('❌ 无法读取package.json');
            return null;
        }
    }

    // 递增版本号
    bumpVersion(currentVersion, level = 'patch') {
        const parts = currentVersion.split('.').map(Number);

        switch (level) {
            case 'major':
                parts[0] += 1;
                parts[1] = 0;
                parts[2] = 0;
                break;
            case 'minor':
                parts[1] += 1;
                parts[2] = 0;
                break;
            case 'patch':
            default:
                parts[2] += 1;
                break;
        }

        return parts.join('.');
    }

    // q3: 快速保存
    async handleQ3() {
        console.log('🚀 执行q3 - 快速代码保存');

        const currentVersion = this.getCurrentVersion();
        if (!currentVersion) return;

        const newVersion = this.bumpVersion(currentVersion, 'patch');
        console.log(`📊 版本递增: ${currentVersion} → ${newVersion}`);

        // 更新package.json
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        packageJson.version = newVersion;
        fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');

        // 提交所有更改（确保工作区干净）
        this.execGit('add .');
        this.execGit(`commit -m "chore: quick save v${newVersion} (q3)"`);

        // 推送到远程
        console.log('📤 正在推送...');
        this.execGit('push origin qq');

        console.log(`✅ q3执行完成：代码已保存至版本v${newVersion}`);
    }

    // q1: 半自动化PR
    async handleQ1() {
        console.log('🔄 执行q1 - 半自动化PR流程');

        const currentVersion = this.getCurrentVersion();
        if (!currentVersion) return;

        const newVersion = this.bumpVersion(currentVersion, 'minor');
        const releaseBranch = `release/v${newVersion}`;

        console.log(`📊 预计版本: v${newVersion}`);
        console.log(`🌿 创建分支: ${releaseBranch}`);

        // 创建并切换到发布分支
        this.execGit(`checkout -b ${releaseBranch}`);

        // 更新版本号
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        packageJson.version = newVersion;
        fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');

        // 提交更改
        this.execGit('add package.json');
        this.execGit(`commit -m "release: prepare v${newVersion} (q1)"`);

        // 推送分支
        console.log('📤 推送发布分支...');
        this.execGit(`push origin ${releaseBranch}`);

        // 切换回主分支
        this.execGit('checkout qq');

        console.log(`✅ q1执行完成：`);
        console.log(`   - 发布分支 ${releaseBranch} 已创建`);
        console.log(`   - 版本号更新至 v${newVersion}`);
        console.log(`   - 请手动在GitHub上创建PR并合并`);
    }

    // q2: 完整发布
    async handleQ2() {
        console.log('🎉 执行q2 - 完整自动化发布');

        const currentVersion = this.getCurrentVersion();
        if (!currentVersion) return;

        const newVersion = this.bumpVersion(currentVersion, 'minor');
        console.log(`📊 版本递增: ${currentVersion} → ${newVersion}`);

        // 更新版本号
        const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        packageJson.version = newVersion;
        fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2) + '\n');

        // 提交版本更新
        this.execGit('add package.json');
        this.execGit(`commit -m "release: v${newVersion} (q2)"`);

        // TODO: 这里可以添加构建和发布的逻辑
        // 比如调用构建脚本、创建release等

        // 推送到远程
        console.log('📤 推送版本更新...');
        this.execGit('push origin qq');

        console.log(`✅ q2执行完成：版本v${newVersion}已发布`);
        console.log('💡 完整发布流程需要额外配置CI/CD集成');
    }

    // 处理用户指令
    async processCommand(command) {
        const cmd = command.trim().toLowerCase();

        switch (cmd) {
            case 'q3':
                await this.handleQ3();
                break;
            case 'q1':
                await this.handleQ1();
                break;
            case 'q2':
                await this.handleQ2();
                break;
            case 'help':
            case '帮助':
                this.showHelp();
                break;
            default:
                console.log('❓ 未知指令，请输入 q3 / q1 / q2 / help');
        }
    }

    // 显示帮助信息
    showHelp() {
        console.log(`
🤖 本地AI发布助手使用说明：

指令列表：
  q3    - 快速保存代码版本（仅递增版本号并推送）
  q1    - 半自动化PR流程（创建发布分支等待手动合并）
  q2    - 完整自动化发布（递增版本并推送，需额外配置）
  help  - 显示此帮助信息

当前工作目录: ${this.repoPath}
        `);
    }
}

// 主程序
async function main() {
    const assistant = new LocalAIReleaseAssistant();

    // 如果有命令行参数，直接执行
    if (process.argv.length > 2) {
        const command = process.argv[2];
        await assistant.processCommand(command);
        return;
    }

    // 交互式模式
    console.log('🤖 进入交互模式，输入指令开始操作：');

    process.stdin.setEncoding('utf8');
    process.stdin.on('readable', () => {
        let chunk;
        while ((chunk = process.stdin.read()) !== null) {
            const command = chunk.trim();
            if (command === 'exit' || command === 'quit') {
                console.log('👋 再见！');
                process.exit(0);
            }
            assistant.processCommand(command);
        }
    });
}

// 错误处理
process.on('uncaughtException', (error) => {
    console.error('❌ 程序异常:', error.message);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ 未处理的Promise拒绝:', reason);
});

// 启动程序
if (require.main === module) {
    main().catch(console.error);
}

module.exports = LocalAIReleaseAssistant;