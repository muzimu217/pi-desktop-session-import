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

## 0.2.0 — 2026-09-09

- 来源会话列表新增**可折叠手风琴**：点击项目标题栏（箭头 + 项目名 + 会话数）
  展开或收起该项目下的会话；「全选该项目」按钮阻止事件冒泡，不会触发展开/收起。
- 动效：箭头展开时顺时针平滑旋转 90°；列表区域以高度 + 透明度过渡展开收起
  （CSS grid-template-rows 过渡，Chromium 原生支持，无额外依赖）。
- 默认全部展开；用户的展开/折叠偏好通过面板 localStorage 持久化，
  重开面板后保持。

## 0.3.0 — 2026-09-09（待官方 a7e466fa 推送后实测发布）

- **适配官方会话 API（[PI-Desktop#169](https://github.com/vastsa/PI-Desktop/issues/169) P0/P1）**：
  导入路径改为双通道——
  - 宿主提供 `pi.session.importBatch` 时走**官方契约**：
    manifest 声明 `contributes.sessionSources`（六来源）与 `session.import` 权限；
    批量导入（契约上限 100 会话/批自动分批、mode: skip）、幂等键
    `(pluginId, source, externalId)`、host 生成 id。
  - 旧宿主回退到本地 dev 构建的 `session.import` 桥接（行为与 0.2.0 相同）。
- **契约校验护栏**（转换输出 → `PluginSessionMessage`）：
  严格 RFC3339 时间戳；`createdAt ≤ updatedAt`；消息时间单调不减（越界钳制）；
  title ≤ 200 字符、externalId ≤ 256 字符；单条 content ≤ 512 KiB；
  toolArgs/toolResult 序列化 ≤ 256 KiB、JSON 深度 ≤ 8（超深自动降级为字符串）。
- 导入结果反馈细化：imported / skipped / failed 分开统计并逐条展示失败原因。
- 注：官方契约中导入会话默认不绑定项目/provider/model（`project_id` NULL，
  历史值存 origin 侧车）；侧栏呈现方案见我们在 #169 的反馈建议。
