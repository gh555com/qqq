#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const semver = require('semver');

class VersionManager {
    constructor() {
        this.packagePath = path.join(__dirname, '..', 'package.json');
        this.currentVersion = this.getCurrentVersion();
    }

    getCurrentVersion() {
        const packageJson = JSON.parse(fs.readFileSync(this.packagePath, 'utf8'));
        return packageJson.version;
    }

    getNextVersion() {
        // 简单的patch版本递增
        const parts = this.currentVersion.split('.');
        parts[2] = parseInt(parts[2]) + 1;
        return parts.join('.');
    }

    updatePackageVersion(newVersion) {
        const packageJson = JSON.parse(fs.readFileSync(this.packagePath, 'utf8'));
        packageJson.version = newVersion;

        fs.writeFileSync(this.packagePath, JSON.stringify(packageJson, null, 2) + '\n');
        console.log(`✅ 版本已更新: ${this.currentVersion} → ${newVersion}`);
        return newVersion;
    }

    // 主要命令
    bump() {
        const nextVersion = this.getNextVersion();
        this.updatePackageVersion(nextVersion);
        return nextVersion;
    }

    validate() {
        console.log('=== 版本验证报告 ===');
        console.log(`当前版本: ${this.currentVersion}`);
        console.log(`下一个版本: ${this.getNextVersion()}`);
        return {
            current: this.currentVersion,
            next: this.getNextVersion()
        };
    }
}

// CLI接口
const manager = new VersionManager();
const command = process.argv[2];

switch (command) {
    case 'bump':
        manager.bump();
        break;
    case 'get-next':
        console.log(manager.getNextVersion());
        break;
    case 'validate':
        manager.validate();
        break;
    default:
        console.log(`
版本管理工具

用法:
  node version-manager.js bump      # 递增版本
  node version-manager.js get-next  # 获取下一个版本号
  node version-manager.js validate  # 验证版本信息
        `);
}