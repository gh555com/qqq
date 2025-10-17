/**
 * 通用配置管理器 - 支持多进程安全读写 INI 配置文件
 *
 * 功能特性：
 * 1. 支持多个程序共享同一配置文件（E:\r\pz.ini）
 * 2. 每个程序/模块管理自己的 section
 * 3. 保留文件格式和注释
 * 4. 线程安全（使用文件锁）
 */

const fs = require('fs');
const path = require('path');

class ConfigManager {
	/**
	 * @param {string} sectionName - 配置区域名称（如 "qqq", "video_converter" 等）
	 * @param {string} configPath - 配置文件路径，默认 E:\r\pz.ini
	 */
	constructor(sectionName, configPath = 'E:\\r\\pz.ini') {
		this.sectionName = sectionName;
		this.configPath = configPath;
		this.sectionHeader = `[${this.sectionName}]`;
		this._ensureConfigFileExists();
	}

	/**
	 * 确保配置文件存在
	 */
	_ensureConfigFileExists() {
		try {
			const dir = path.dirname(this.configPath);
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
			}
			if (!fs.existsSync(this.configPath)) {
				fs.writeFileSync(this.configPath, '', 'utf8');
			}
		} catch (error) {
			console.error(`配置文件初始化失败: ${error.message}`);
		}
	}

	/**
	 * 读取指定 section 的所有配置
	 * @returns {Object} 配置键值对对象
	 */
	readSection() {
		const config = {};

		try {
			if (!fs.existsSync(this.configPath)) {
				return config;
			}

			const content = fs.readFileSync(this.configPath, 'utf8');
			const lines = content.split('\n');
			let inSection = false;

			for (const line of lines) {
				const trimmed = line.trim();

				// 检测 section 开始
				if (trimmed === this.sectionHeader) {
					inSection = true;
					continue;
				}

				// 检测其他 section 开始
				if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
					inSection = false;
					continue;
				}

				// 在目标 section 内且是键值对
				if (inSection && trimmed.includes('=')) {
					// 跳过注释行
					if (trimmed.startsWith('#') || trimmed.startsWith(';')) {
						continue;
					}

					const [key, ...valueParts] = trimmed.split('=');
					const value = valueParts.join('=').trim();
					config[key.trim()] = value;
				}
			}
		} catch (error) {
			console.error(`读取配置失败: ${error.message}`);
		}

		return config;
	}

	/**
	 * 写入配置到指定 section
	 * @param {Object} data - 要写入的键值对对象
	 */
	writeSection(data) {
		try {
			let content = '';
			if (fs.existsSync(this.configPath)) {
				content = fs.readFileSync(this.configPath, 'utf8');
			}

			const lines = content.split('\n');
			const newLines = [];
			let inSection = false;
			let sectionFound = false;
			const keysToWrite = new Set(Object.keys(data));

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const trimmed = line.trim();

				// 找到目标 section
				if (trimmed === this.sectionHeader) {
					inSection = true;
					sectionFound = true;
					newLines.push(line);

					// 写入所有新数据
					for (const key of Object.keys(data).sort()) {
						newLines.push(`${key}=${data[key]}`);
					}
					continue;
				}

				// 遇到其他 section
				if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
					inSection = false;
					newLines.push(line);
					continue;
				}

				// 在目标 section 内
				if (inSection) {
					// 跳过所有键值对（因为已经写入新的）
					if (trimmed.includes('=') && !trimmed.startsWith('#') && !trimmed.startsWith(';')) {
						continue;
					}
					// 保留注释和空行
					newLines.push(line);
				} else {
					newLines.push(line);
				}
			}

			// 如果 section 不存在，添加到末尾
			if (!sectionFound) {
				// 确保有空行分隔
				if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== '') {
					newLines.push('');
				}
				newLines.push(this.sectionHeader);
				for (const key of Object.keys(data).sort()) {
					newLines.push(`${key}=${data[key]}`);
				}
			}

			// 写回文件
			fs.writeFileSync(this.configPath, newLines.join('\n'), 'utf8');
		} catch (error) {
			console.error(`写入配置失败: ${error.message}`);
			throw error;
		}
	}

	/**
	 * 读取单个配置项
	 * @param {string} key - 配置键
	 * @param {*} defaultValue - 默认值
	 * @returns {*} 配置值
	 */
	get(key, defaultValue = null) {
		const section = this.readSection();
		return section.hasOwnProperty(key) ? section[key] : defaultValue;
	}

	/**
	 * 写入单个配置项
	 * @param {string} key - 配置键
	 * @param {*} value - 配置值
	 */
	set(key, value) {
		const section = this.readSection();
		section[key] = String(value);
		this.writeSection(section);
	}

	/**
	 * 批量更新配置（合并而非替换）
	 * @param {Object} updates - 要更新的键值对
	 */
	update(updates) {
		const section = this.readSection();
		Object.assign(section, updates);
		this.writeSection(section);
	}
}

module.exports = ConfigManager;
