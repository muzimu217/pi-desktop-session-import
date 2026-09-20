# 宿主导入功能迁移清单（host import surface → plugin）

> 背景：vastsa 在 pi-desktop-plugins#56 合并留言中提出——把宿主**所有**导入功能（含模型配置）吸
> 收进本插件，之后宿主可以下掉内置导入页。本文档是迁移前的事实盘点与分步计划，逐块单独 PR。
>
> 基准：PI-Desktop `upstream/main`（2026-09-20，7a59a25c 一线）；本插件 0.4.9。

## 一、宿主现状盘点（要被下掉的面）

入口：设置 → 导入（`apps/desktop/src/features/settings/import-page.tsx`，1152 行），
四条线各配一对 scan/import 通道：

| # | 功能 | Electron 实现 | IPC 通道 | 落点 |
|---|---|---|---|---|
| 1 | **会话导入**（Claude Code / Codex / OpenCode / Pi 四源） | `electron/main/importers/`：claude.ts、codex.ts、opencode.ts、pi.ts、index.ts（scanAllSources）、types.ts | `sessionImportScan` / `sessionImportRun` | 扫描在 Electron 主进程；写入走宿主 RPC `session.import`（host-core `sessions.rs:3077 import_session`） |
| 2 | **模型配置导入**（Claude Code / Codex / OpenCode / Pi / **cc-switch** 五种配置） | `importers/model-config.ts`（parse* 系列在 @pi-desktop/shared） | `modelConfigImportScan` / `modelConfigImportRun` | 扫描在 Electron；导入写 providers（宿主 providers RPC） |
| 3 | **外部 MCP 导入**（扫描其他 agent CLI 的 MCP 配置，stdio/http 两种 transport、dir/file 两种形态） | `importers/agent-mcp-scan.ts` | `scanExternalMcp` / `runExternalMcpImport` | 写 mcp_servers |
| 4 | **外部技能导入** | `importers/agent-skill-scan.ts` | `scanExternalSkills` / `runExternalSkillsImport` | 写 user_skills |

规模：`importers/` 共 **9 文件 / 2207 行**（另加 import-page.tsx 1152 行 UI、i18n 键 ~40 个、
E2E 场景若干）。

### 与本插件的能力对比（会话线）

| 维度 | 宿主内置 | 本插件 0.4.9 |
|---|---|---|
| 会话源数量 | 4（Claude/Codex/OpenCode/Pi） | **6**（+ ZCode / WorkBuddy） |
| 自定义来源 | 无 | 声明式 JSON 驱动（3 种 driver，纯数据安全边界） |
| OpenCode 格式 | 待核对（可能为旧 JSONL 布局） | **v1.x SQLite**（三平台路径探测，#682） |
| 预览/分组/批量 | 设置页 UI | 面板 UI（按项目归组、搜索、整组全选、幂等导入） |
| 熔炉（导入后蒸馏） | 无 | 有（pi.agent.complete） |

结论：**会话线本插件已是严格超集**，迁移主要是入口切换与行为对齐核对，不是补功能。

## 二、缺口分析（迁移真正要解决的事）

插件 SDK 现有面：`contributes.providers / skills / mcpServers` 是**静态声明**（清单里写死、
宿主加载时登记），不是运行时"扫描本机其他工具的配置 → 创建 provider/skill/MCP"的通道。
因此：

1. **会话线（#1）**：无缺口。`session.import` 宿主 RPC 已是插件可用通道（本插件在用）。
2. **模型配置线（#2）**：**缺口 = 运行时创建 provider 的插件 API**。扫描本身插件能做
   （`fs.read` 扩到用户主目录的若干已知配置路径即可——需要放宽权限作用域并过安审），
   但扫出来的 provider 没有运行时写入通道。需要的宿主能力（二选一）：
   - 新插件权限 + API：`providers.write`（运行时 `pi.providers.create/update`，逐字段白名单，
     API Key 永不经手插件——与现有 providersSetSecret 语义对齐）；
   - 或宿主保留一个极薄的"导入网关" RPC：插件把解析好的 provider 草稿递过去，宿主校验落库。
3. **外部 MCP 线（#3）**：缺口 = 运行时注册 mcp_servers 的插件 API（现有
   `contributes.mcpServers` 是静态的；`mcp.server.local/remote` 权限是"调用"而非"注册"）。
4. **外部技能线（#4）**：缺口 = 运行时写 user_skills 的插件 API（`contributes.skills` 同为静态；
   现有 `fs.write` 只作用工作区，而 user_skills 在数据目录）。

## 三、分步计划（每步独立 PR，全部可单独回滚）

| 步骤 | 内容 | 依赖 | 落点 |
|---|---|---|---|
| **M0** | 行为对齐核对：宿主 4 个会话导入器的特判（codex 截断上限、claude 合成行过滤、thinking 保留等）逐条与本插件适配器比对，差异补进适配器 + 测试 | 无 | 本仓库 |
| **M1** | 入口切换准备：面板补"从宿主导入页迁移"的一次性引导（检测宿主版本 ≥ 下线版时提示）；文档同步 | 无 | 本仓库 |
| **M2** | 宿主 Core PR：`providers.write` 插件 API（或导入网关 RPC，按 vastsa 二选一）——权限字典、SDK、spec、E2E 成套 | vastsa 认可缺口方案 | PI-Desktop 主仓 |
| **M3** | 模型配置导入进插件：移植 model-config.ts 的 5 种 parser（shared 包里的实现可直接复用/上移），面板新增"模型配置"页签 | M2 | 本仓库 |
| **M4** | 宿主 Core PR：MCP/技能运行时注册 API（同 M2 模式） | M2 经验 | PI-Desktop 主仓 |
| **M5** | 外部 MCP + 外部技能导入进插件 | M4 | 本仓库 |
| **M6** | 宿主下线：Import 页、importers/、8 条 IPC、i18n、E2E 场景移除；`session.import` RPC **保留**（它是插件的数据通道，不是"导入页"的一部分） | M1–M5 全部合入且平台版稳定一个版本 | PI-Desktop 主仓 |

## 四、给维护者的开放问题

1. M2 的形态选哪种：`providers.write` 运行时 API，还是薄导入网关 RPC？（前者通用、后者面小好审）
2. 独立仓库已建：`muzimu217/pi-desktop-session-import`（本仓库）。平台侧本插件当前绑定在
   fork monorepo 上——**需要操作员把绑定切到本仓库**（或告知控制台入口，我们自助切）；
   0.4.9 的 pending_review 版本等审时一并处理即可。
3. monorepo 里的 `plugins/io.github.muzimu217.session-import/` 目录：独立仓库成为唯一源后，
   那边保留一个指路 README 还是直接删除？
4. 迁移期版本策略：宿主下线（M6）之前，本插件发版继续走平台（当前 0.4.9 在审）；
   monorepo 不再单独发 0.4.x 之后的版（避免双源漂移）。
