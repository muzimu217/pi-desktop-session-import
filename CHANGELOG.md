# Changelog — Universal Session Import

All notable changes to this plugin are documented here. Versions follow
semver; the plugin id is `io.github.muzimu217.session-import`.

## 0.1.0 — 2026-09-09

- 首个版本：一体化来源检测与导入。
- 「扫描本机工具」并行探测六个来源并显示各自会话数：
  ZCode / WorkBuddy / Claude Code / Codex / OpenCode / Pi。
- 选择来源后按项目分组列出会话，支持搜索、整组全选、会话预览
  （用户 / 助手 / 工具调用，含参数与结果，错误标红）。
- 「导入为会话」经宿主 `session.import` 桥接把勾选会话写入 PI-Desktop
  会话库：按会话原始工作目录自动建项目、左侧即刻展开可见、
  幂等 id（`import-<source>-<externalId>`）重复导入自动跳过。
- 来源实现来源：ZCode / WorkBuddy 适配器沿用本仓库两个单体插件的已验证逻辑；
  Claude Code / Codex / OpenCode / Pi 移植自 PI-Desktop 内置导入器。
- 官方 `pi-plugin check` 通过。
