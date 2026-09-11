# 自定义扫描来源（Custom Sources）

除了内置的 6 个来源（ZCode、WorkBuddy、Claude Code、Codex、OpenCode、Pi），
你可以**用一份声明式 JSON 描述自己的工具**，让它出现在扫描列表里并像内置来源一样导入。

> **安全边界**：配置**只允许纯数据**。任何 `eval` / `code` / `require` / `transform` / `script`
> 之类的键（任意层级）都会被直接拒绝——插件运行时对用户主目录有读权限，
> 允许配置文件携带代码等同于任意代码执行。因此这里**不支持、也不会执行**任何自定义 JS。

## 放哪儿

在**当前工作区**创建：

```
docs/session-import-sources.json
```

`docs/**` 已经在插件声明的 `fs.read` 范围内，所以这个位置**不需要新增任何权限**。
文件格式可以是数组，也可以是 `{ "sources": [...] }`：

```json
[
  { "id": "mytool", "label": "My Tool", "driver": "jsonl-transcript", "root": "~/.mytool/sessions", "entry": { ... } }
]
```

写完在面板点「自定义来源 → 重新加载」，新来源会立刻出现在扫描卡片上（带 `自定义` 标签）。

## 三个 driver（对应三种磁盘格式）

| driver | 适用 | 内置使用者 |
| --- | --- | --- |
| `jsonl-transcript` | 一行一条记录的 JSONL 对话文件 | Claude Code、Codex、WorkBuddy、Pi |
| `sqlite-session` | SQLite：`session → message → part` 三层（或 session+message 两层） | ZCode、OpenCode |
| `json-tree` | 一个 JSON 文件即一个会话，对话嵌在其中 | 旧版 OpenCode / Claude 布局 |

### 1. jsonl-transcript

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "jsonl-transcript",
  "root": "~/.mytool/sessions",
  "extension": ".jsonl",
  "recursive": true,
  "session": {
    "idFrom": "filename",
    "titleFrom": "firstUser",
    "projectFrom": "parentDir"
  },
  "entry": {
    "rolePath": "role",
    "roleMap": { "human": "user" },
    "content": { "blocks": { "path": "message.content", "typeField": "type", "types": ["text"], "textField": "text" } },
    "tsPath": "timestamp",
    "skipTypePath": "type",
    "skipTypes": ["summary", "system"],
    "tool": {
      "typePath": "type",
      "toolTypes": ["tool_use"],
      "namePath": "name",
      "argsPath": "input",
      "resultPath": "output",
      "statusPath": "status"
    }
  }
}
```

`content` 支持四种写法（决定了文本怎么取）：

| 写法 | 含义 |
| --- | --- |
| `"content"` 或 `{ "path": "content" }` | 取该字段 |
| `{ "blocks": { "path": "message.content", "typeField": "type", "types": ["text"], "textField": "text" } }` | 数组里挑出指定 type 的块，拼接其 text（Claude 的 content 就是这种块数组） |
| `{ "first": [ {...}, {...} ] }` | 依次尝试，取第一个非空 |
| `{ "literal": "固定文本" }` | 常量 |

### 2. sqlite-session

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "sqlite-session",
  "db": "~/.mytool/data.db",
  "session": { "table": "session", "idCol": "id", "titleCol": "title", "pathCol": "directory", "createdCol": "time_created", "updatedCol": "time_updated" },
  "message": { "table": "message", "idCol": "id", "sessionIdCol": "session_id", "createdCol": "time_created", "dataCol": "data", "rolePath": "role", "tsPath": "time.created", "modelIdPath": "modelID", "providerIdPath": "providerID" },
  "part": { "table": "part", "messageIdCol": "message_id", "sessionIdCol": "session_id", "createdCol": "time_created", "dataCol": "data", "textTypes": ["text"], "toolType": "tool", "toolNamePath": "tool", "argsPath": "state.input", "resultPath": "state.output", "statusPath": "state.status" }
}
```

如果工具把正文直接存在 message 行里（没有 part 表），**省略 `part`** 并在 `message` 上加 `contentPath`。
数据库一律以 `readOnly` 打开，不会写入你的数据。

### 3. json-tree

```json
{
  "id": "mytool",
  "label": "My Tool",
  "driver": "json-tree",
  "root": "~/.mytool/sessions",
  "extension": ".json",
  "session": { "idPath": "id", "titlePath": "title", "tsPath": "createdAt", "pathPath": "directory", "messagesPath": "messages" },
  "message": { "rolePath": "role", "content": { "path": "content" }, "tsPath": "createdAt" }
}
```

## 校验规则（会被拒绝的情况）

- `id` 不合法：必须匹配 `^[a-zA-Z][a-zA-Z0-9._-]{0,63}$`
- `id` 撞内置来源：`zcode` / `workbuddy` / `claude-code` / `codex` / `opencode` / `pi`（内置永远优先）
- `driver` 不是上表三个之一
- 出现 `eval` / `code` / `require` / `transform` / `script` / `__proto__` / `prototype` / `constructor` 等键（**任意层级**）
- 出现非数据值（函数等）
- 数据根目录是 `/` 或整个 home（拒绝扫描整个磁盘/家目录；请指到具体子目录）
- 配置文件 > 512 KB，或来源数 > 25

被拒绝的来源不会中断扫描：其它来源照常工作，面板的「自定义来源」区域会显示具体原因。

## 资源上限

默认每个来源最多扫 **2000 个文件**、单文件 **32 MB**（可在 spec 里用 `maxFiles` / `maxBytes` 覆盖）。
加上既有的看门狗超时（单源扫描 90s），一个配置错误的来源不会拖死面板。
