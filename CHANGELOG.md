# Changelog

All notable changes to this project will be documented in this file.

## 变更日志

本项目所有重要变更将在此文件中记录。

---

## [15.73.111] - 2026-03-03

### Added / 新增
- **w 键 .lnk 跳转增强**: 在指向文件夹的 .lnk 快捷方式上按 w 键，直接在 q2 漫游器内跳转（纯 Node.js Buffer 解析，<1ms）
- **退格返回来源**: 通过 .lnk 跳转后按退格键，直接返回跳转前的目录
- **预览模式**: 用 q 键打开文档时使用预览模式，连续打开多个文档只保留一个标签页

### Fixed / 修复
- 修复中文路径的 .lnk 快捷方式解析失败问题

### Changed / 变更
- .lnk 解析从 PowerShell 切换为纯 Node.js Buffer 解析，速度提升 500 倍+

---

## [15.73.0] - Previous Release

See [GitHub Releases](https://github.com/gh555com/qqq/releases) for older changelog entries.
