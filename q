#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class LocalAIReleaseAssistant {
    constructor() {
        this.repoPath = process.cwd();
        console.log('🤖 极致版 AI 发布助手已就绪');
    }

    execGit(command) {
        try {
            return execSync(`git ${command}`, { cwd: this.repoPath, encoding: 'utf8' }).trim();
        } catch (e) {
            console.error(`❌ Git Error: ${e.message}`);
            return null;
        }
    }

    getCurrentVersion() {
        return JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
    }

    bumpVersion(current, level = 'patch') {
        const parts = current.split('.').map(Number);
        if (level === 'minor') { parts[1] += 1; parts[2] = 0; }
        else { parts[2] += 1; }
        return parts.join('.');
    }

    async _smartCommitAndPush(newVersion, message, targetBranch = 'qq') {
        console.log(`🚀 准备发布 v${newVersion}...`);
        
        // 更新版本号
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        pkg.version = newVersion;
        fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');

        // 清理缓存
        ['dist', 'build-artifacts', 'out'].forEach(f => {
            if (fs.existsSync(f)) fs.rmSync(f, { recursive: true, force: true });
        });

        // 提交并强制推送
        this.execGit('add .');
        const commitResult = this.execGit(`commit -m "${message}"`);
        if (!commitResult) {
            console.log('⚠️ 无变更或提交失败，尝试强制同步版本号并推送...');
        }
        
        console.log(`📤 正在推送到 origin/${targetBranch}...`);
        // 显式指定本地 HEAD 推送到远程 qq 分支
        execSync(`git push origin HEAD:${targetBranch} --force`, { stdio: 'inherit' });
        return true;
    }

    // 7 平台打包核心逻辑
    async packageAll(isPublish = false) {
        const version = this.getCurrentVersion();
        const targets = {
            'win32-x64': 'q_win_x64.exe',
            'win32-arm64': 'q_win_arm64.exe',
            'win32-ia32': 'q_win_x86.exe',
            'linux-x64': 'q_linux_x64',
            'darwin-x64': 'q_mac_x64',
            'darwin-arm64': 'q_mac_arm64',
            'universal': null // 兜底版，不含特定二进制
        };

        console.log('📦 正在执行 esbuild 合体打包...');
        execSync('npm run bundle', { stdio: 'inherit' });

        if (!fs.existsSync('dist')) fs.mkdirSync('dist');

        for (const [target, binName] of Object.entries(targets)) {
            console.log(`\n🛠️  正在处理平台: ${target}...`);
            const enginePath = path.join('assets', binName ? (target.startsWith('win') ? 'q_engine.exe' : 'q_engine') : 'dummy');
            
            if (binName) {
                const srcBin = path.join('assets', binName);
                if (!fs.existsSync(srcBin)) {
                    console.warn(`⚠️ 缺失二进制: ${srcBin}，跳过该平台`);
                    continue;
                }
                fs.copyFileSync(srcBin, enginePath);
            }

            try {
                const output = `dist/qqq-${version}-${target}.vsix`;
                const cmd = isPublish ? 'publish' : 'package';
                const targetFlag = target === 'universal' ? '' : `--target ${target}`;
                
                console.log(`🚀 正在执行 vsce ${cmd}...`);
                execSync(`npx @vscode/vsce ${cmd} ${targetFlag} -o ${output} --allow-missing-repository --no-dependencies`, { stdio: 'inherit' });
            } finally {
                if (fs.existsSync(enginePath)) fs.unlinkSync(enginePath);
            }
        }
    }

    async process(cmd, summary = '') {
        const current = this.getCurrentVersion();
        if (cmd === 'q3') {
            const next = this.bumpVersion(current, 'patch');
            await this._smartCommitAndPush(next, `chore: v${next} (q3) ${summary}`);
        } else if (cmd === 'q2') {
            const next = this.bumpVersion(current, 'minor');
            await this._smartCommitAndPush(next, `release: v${next} (q2) ${summary}`);
        } else if (cmd === 'q1') {
            const next = this.bumpVersion(current, 'minor');
            const branch = `release/v${next}`;
            this.execGit(`checkout -b ${branch}`);
            await this._smartCommitAndPush(next, `release: prepare v${next} (q1) ${summary}`, branch);
            this.execGit('checkout qq');
        } else if (cmd === 'package') {
            await this.packageAll(false);
        } else if (cmd === 'publish') {
            await this.packageAll(true);
        }
    }
}

const assistant = new LocalAIReleaseAssistant();
const cmd = process.argv[2] || 'help';
const summary = process.argv.slice(3).join(' ');

if (cmd === 'help') {
    console.log('用法: node q q1/q2/q3/package/publish [说明]');
} else {
    assistant.process(cmd, summary).catch(console.error);
}
