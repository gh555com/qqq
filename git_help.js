#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class LocalAIReleaseAssistant {
    constructor() {
        this.repoPath = process.cwd();
        console.log('🤖 本地AI发布助手已启动');
        console.log('请键入指令：q3 / q1 / q2');
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

    // 核心：更新版本、添加所有文件并提交推送
    async _smartCommitAndPush(newVersion, message, targetBranch = 'qq') {
        console.log(`📊 版本递增: ${newVersion}`);

        // 1. 同步更新 package.json
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        pkg.version = newVersion;
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

        // 2. 清理多余的 build-artifacts 并确保 assets 是唯一真理
        const artifactsFolders = ['build-artifacts', 'build', 'target'];
        artifactsFolders.forEach(folder => {
            try {
                if (fs.existsSync(folder)) {
                    console.log(`🧹 正在清理 ${folder} 目录...`);
                    fs.rmSync(folder, { recursive: true, force: true });
                }
            } catch (e) {
                console.error(`❌ 清理 ${folder} 失败:`, e.message);
            }
        });

        // 3. 验证 assets 目录中的二进制文件
        const requiredAssets = [
            'q_win_x64.exe',
            'q_win_x86.exe',
            'q_linux_x64',
            'q_mac_x64',
            'q_mac_arm64'
        ];

        console.log('🔍 检查 assets 目录二进制完整性...');
        if (!fs.existsSync('assets')) {
            console.error('❌ 错误: assets 目录不存在！');
            return false;
        }

        const missing = requiredAssets.filter(asset => !fs.existsSync(path.join('assets', asset)));
        if (missing.length > 0) {
            console.warn(`⚠️ 警告: 以下二进制文件在 assets 中缺失: ${missing.join(', ')}`);
            console.warn('ℹ️ 这在本地环境是正常的，云端流水线会自动处理这些二进制。');
        } else {
            console.log('✅ assets 二进制文件验证通过。');
        }

        // 4. 检查是否有文件变化
        const status = this.execGit('status --porcelain');
        if (!status) {
            console.log('ℹ️ 工作区已经是干净的，仅同步版本号...');
        }

        // 5. 执行全量提交
        this.execGit('add .');
        this.execGit(`commit -m "${message}"`);

        // 6. 执行推送 (参考 q 的稳健逻辑)
        console.log(`📤 正在推送至 origin/${targetBranch}...`);
        try {
            // 显式指定推送到远程 qq 分支，并确保 Action 触发
            execSync(`git push origin HEAD:${targetBranch} --force`, { cwd: this.repoPath, stdio: 'inherit' });
            return true;
        } catch (e) {
            console.error('❌ 推送失败:', e.message);
            return false;
        }
    }

    // q3: 快速保存
    async handleQ3(summary = '') {
        console.log('🚀 执行 q3 - 极速保存快照');
        const current = this.getCurrentVersion();
        const next = this.bumpVersion(current, 'patch');
        const msg = `chore: v${next} (q3)${summary ? ' - ' + summary : ''}`;
        await this._smartCommitAndPush(next, msg);
        console.log(`✅ q3 完成：工作区已清空，版本升至 v${next}`);
    }

    // q1: 半自动化 PR
    async handleQ1(summary = '') {
        console.log('🔄 执行 q1 - 创建发布分支与 PR');
        const current = this.getCurrentVersion();
        const next = this.bumpVersion(current, 'minor');
        const branch = `release/v${next}`;
        const msg = `release: prepare v${next} (q1)${summary ? ' - ' + summary : ''} (q2)`;

        this.execGit(`checkout -b ${branch}`);
        await this._smartCommitAndPush(next, msg, branch);

        this.execGit('checkout qq');
        console.log(`✅ q1 完成：已推送分支 ${branch}，现已切回 qq 分支`);
    }

    // q2: 完整自动化发布
    async handleQ2(summary = '') {
        console.log('🎉 执行 q2 - 完整发布流水线');
        const current = this.getCurrentVersion();
        const next = this.bumpVersion(current, 'minor');
        const msg = `release: v${next} (q2)${summary ? ' - ' + summary : ''}`;
        await this._smartCommitAndPush(next, msg);
        console.log(`✅ q2 完成：版本 v${next} 已推送到主分支，触发远程全家桶发布`);
    }

    // 包装 vsce package/publish
    async packagePlatformSpecificVSIX(isPublish = false) {
        const platforms = {
            'win32-x64': { bin: 'q_win_x64.exe', engine: 'q_engine.exe', ffmpeg: 'ffmpeg.exe' },
            'win32-arm64': { bin: 'q_win_arm64.exe', engine: 'q_engine.exe', ffmpeg: 'ffmpeg.exe' },
            'win32-ia32': { bin: 'q_win_x86.exe', engine: 'q_engine.exe', ffmpeg: 'ffmpeg.exe' },
            'linux-x64': { bin: 'q_linux_x64', engine: 'q_engine', ffmpeg: 'ffmpeg' },
            'darwin-x64': { bin: 'q_mac_x64', engine: 'q_engine', ffmpeg: 'ffmpeg' },
            'darwin-arm64': { bin: 'q_mac_arm64', engine: 'q_engine', ffmpeg: 'ffmpeg' },
            'universal': { bin: null, engine: null, ffmpeg: null } // 兜底版
        };

        const targets = Object.keys(platforms);
        const version = this.getCurrentVersion();
        const action = isPublish ? 'publish' : 'package';

        console.log(`📦 开始执行多平台 ${action} (版本: v${version})...`);

        if (!fs.existsSync('dist')) fs.mkdirSync('dist');

        for (const t of targets) {
            const config = platforms[t];
            console.log(`\n🛠️  正在处理平台: ${t}...`);

            // 1. 准备 Rust 引擎
            const srcBin = config.bin ? path.join('assets', config.bin) : null;
            const destBin = config.engine ? path.join('assets', config.engine) : null;
            if (srcBin) {
                if (fs.existsSync(srcBin)) {
                    fs.copyFileSync(srcBin, destBin);
                } else {
                    console.warn(`⚠️ 缺失 Rust 引擎: ${srcBin}`);
                }
            }

            // 2. 准备 FFmpeg (从 node_modules 捞出)
            const ffDest = config.ffmpeg ? path.join('assets', config.ffmpeg) : null;
            if (ffDest) {
                try {
                    // 动态查找 ffmpeg-installer 的二进制路径
                    const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
                    if (fs.existsSync(ffmpegPath)) {
                        fs.copyFileSync(ffmpegPath, ffDest);
                        console.log(`✅ 已嵌入 FFmpeg: ${ffDest}`);
                    }
                } catch (e) {
                    console.warn(`⚠️ FFmpeg 准备失败: ${e.message}`);
                }
            }

            try {
                const outputName = `dist/qqq-${version}-${t}.vsix`;
                const targetFlag = t === 'universal' ? '' : `--target ${t}`;
                // 注意：发布到商店必须带 --target
                const cmd = `npx @vscode/vsce ${action} ${targetFlag} -o ${outputName} --allow-missing-repository --no-dependencies`;

                console.log(`🚀 执行: ${cmd}`);
                execSync(cmd, { stdio: 'inherit' });
            } catch (e) {
                console.error(`❌ ${action} ${t} 失败:`, e.message);
            } finally {
                // 清理临时重命名的文件
                if (destBin && fs.existsSync(destBin)) fs.unlinkSync(destBin);
                if (ffDest && fs.existsSync(ffDest)) fs.unlinkSync(ffDest);
            }
        }
    }

    // 处理用户指令
    async processCommand(command, summary = '') {
        const cmd = command.trim().toLowerCase();

        switch (cmd) {
            case 'q3':
                await this.handleQ3(summary);
                break;
            case 'q1':
                await this.handleQ1(summary);
                break;
            case 'q2':
                await this.handleQ2(summary);
                break;
            case 'package':
                // 先执行编译
                console.log('📦 正在执行 esbuild 打包...');
                try {
                    execSync('npm run bundle', { stdio: 'inherit' });
                } catch (e) {
                    console.error('❌ esbuild 打包失败，中止发布');
                    return;
                }
                await this.packagePlatformSpecificVSIX(false);
                break;
            case 'publish':
                // 商店发布流程
                console.log('🚀 正在执行多平台商店发布...');
                try {
                    execSync('npm run bundle', { stdio: 'inherit' });
                } catch (e) {
                    console.error('❌ esbuild 打包失败，中止发布');
                    return;
                }
                await this.packagePlatformSpecificVSIX(true);
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
  q3      - 快速保存代码版本（仅递增版本号并推送）
  q1      - 半自动化PR流程（创建发布分支等待手动合并）
  q2      - 完整自动化发布（递增版本并推送，需额外配置）
  package - 极致减肥打包：执行 esbuild 并生成 5 个平台的专用 VSIX
  help    - 显示此帮助信息

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
        const summary = process.argv.slice(3).join(' '); // 获取后面所有的参数作为总结
        await assistant.processCommand(command, summary);
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