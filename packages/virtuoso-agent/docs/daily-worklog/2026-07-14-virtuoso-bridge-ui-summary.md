# 2026-07-14 工作总结：Virtuoso SKILL bridge 与可见 UI 打通

本文记录本次围绕 `pi agent <-> virtuoso-agent <-> Cadence Virtuoso` 桥接的实现、真实环境验证结果，以及讨论中澄清的几个关键设计问题。

## 本次目标

本次目标不是实现完整自动设计流程，而是先把第一条受控桥接链路打通：

```text
pi agent / CLI
-> TypeScript runtime
-> generated SKILL call script
-> bridge.il
-> Cadence Virtuoso
-> 打开指定 cellView
```

重点原则：

- 不开放任意 SKILL 执行。
- 先包装少量明确、受控的 SKILL 函数。
- 先支持只读打开和展示 cellView。
- 保留 headless 模式，同时新增 visible UI 模式。

## 新增文件

```text
packages/virtuoso-agent/skill-runtime/bridge.il
```

受控 SKILL bridge。当前提供：

```skill
vaPing()
vaOpenCellView(library cell view mode)
vaShowCellView(library cell view mode)
vaGetCurrentCellView()
```

其中：

- `vaPing()` 用于验证 Virtuoso 能加载 bridge。
- `vaOpenCellView()` 用于 headless/batch 模式，只读打开数据库 cellView 并返回 JSON。
- `vaShowCellView()` 用于 visible UI 模式，在 Virtuoso 窗口中显示 cellView。
- `vaGetCurrentCellView()` 预留用于后续查询当前编辑对象。

重要：这里没有提供 `run arbitrary skill` 一类能力。agent 不能自由生成大段 SKILL 并直接执行。

```text
packages/virtuoso-agent/src/runtime/backends/virtuoso/bridge.ts
```

底层 Virtuoso bridge runner。职责：

- 生成 `bridge-call.il`
- 在脚本中 `load(...)` 项目内的 `bridge.il`
- 写入受控 SKILL 调用表达式
- 启动 Virtuoso
- 对 headless 调用解析 stdout 中的 JSON
- 对 visible UI 调用 detached 启动 Virtuoso，并返回 pid、scriptPath、日志路径

```text
packages/virtuoso-agent/src/runtime/workflows/virtuoso-bridge.ts
```

高层 runtime workflow。当前导出：

```ts
pingVirtuosoBridge()
openVirtuosoCellView()
showVirtuosoCellView()
```

CLI、pi extension 和未来其它 adapter 都应调用这些高层函数，而不是自己拼 SKILL。

```text
packages/virtuoso-agent/test/runtime/backends/virtuoso/bridge.test.ts
```

新增 bridge 单元测试，覆盖：

- dry-run 不启动 Virtuoso
- 生成受控 SKILL 调用脚本
- 解析 bridge JSON 响应
- bridge error 转成 runtime failure
- visible UI 脚本不包含 `exit()`

## 修改文件

```text
packages/virtuoso-agent/src/index.ts
```

导出 Virtuoso bridge 相关 runtime API。

```text
packages/virtuoso-agent/src/cli/runner.ts
```

新增 CLI 命令：

```bash
vab virtuoso ping --json
vab cellview open --lib <lib> --cell <cell> --view <view> --json
vab cellview show --lib <lib> --cell <cell> --view <view> --json
```

参数支持：

```text
--mode r|a|w
--work-dir <dir>
--virtuoso-bin <path>
--bridge-path <path>
--timeout-ms <ms>
--display <display>
--dry-run
```

`cellview open` 是 headless 模式。

`cellview show` 是 visible UI 模式。

```text
packages/virtuoso-agent/src/extension/index.ts
```

新增 pi tools：

```text
virtuoso_bridge_ping
virtuoso_open_cellview
virtuoso_show_cellview
```

extension 仍然只做 adapter，不实现 Virtuoso 业务逻辑。

```text
packages/virtuoso-agent/test/cli/runner.test.ts
```

补充 CLI 参数解析和 dry-run 输出测试。

## 两种运行模式

### Headless / batch 模式

命令形态：

```bash
virtuoso -nograph -restore bridge-call.il
```

脚本形态：

```skill
load("/path/to/bridge.il")
vaOpenCellView("test" "two_stage_amp" "schematic" "r")
exit()
```

特点：

- 不显示 UI。
- 适合后台读取、检查、dry-run、自动化任务。
- CLI 可以等待 Virtuoso 退出。
- runtime 可以解析 stdout 中的 JSON。

本次真实验证中，headless bridge 成功完成：

```json
{"bridge":"virtuoso-agent","status":"ok"}
```

并成功只读打开：

```json
{
  "library": "test",
  "cell": "two_stage_amp",
  "view": "schematic",
  "mode": "r"
}
```

### Visible UI 模式

命令形态：

```bash
virtuoso -restore bridge-call.il
```

脚本形态：

```skill
load("/path/to/bridge.il")
vaShowCellView("test" "two_stage_amp" "schematic" "r")
```

注意脚本不调用 `exit()`。这样 Virtuoso 图形界面会保留给工程师查看。

本次真实验证中，用户确认桌面 UI 上已经看到原理图打开。这说明 visible UI path 成功。

## 真实 Cadence 环境验证

本机发现：

```text
/opt/eda/cadence/IC251/tools/dfII/bin/virtuoso
/opt/eda/cadence/IC251/tools/dfII/bin/ocean
```

发现 `cds.lib`：

```text
/home/userone/Projects/Project_2026/cds.lib
/home/userone/Projects/Project_BTD/BO/BO/cds.lib
```

验证使用的 cellView：

```text
library: test
cell: two_stage_amp
view: schematic
mode: r
```

由于当前 sandbox 不能直接写 `/home/userone/Projects/Project_2026`，验证时在 `/tmp` 下创建了临时工作目录：

```text
/tmp/virtuoso-agent-project-2026
```

其中放置：

```text
cds.lib -> /home/userone/Projects/Project_2026/cds.lib
test    -> /home/userone/Projects/Project_2026/test
```

这个目录用于让 Virtuoso 在启动 cwd 下找到 `cds.lib` 和相对路径 library。

## 讨论中澄清的关键困惑

### 1. 为什么一开始看不到 UI？

因为最初使用的是：

```bash
virtuoso -nograph -restore bridge-call.il
```

`-nograph` 是 headless 模式，不会弹出 Virtuoso 窗口。它适合后台检查和结构化返回，但不适合工程师视觉审查。

后来新增了：

```bash
vab cellview show ...
```

该模式使用：

```bash
virtuoso -restore bridge-call.il
```

因此可以显示 Virtuoso UI 和指定 cellView。

### 2. 应该显示 UI 还是不显示 UI？

结论是两种都需要。

推荐产品流程：

```text
后台/headless：
  读取设计
  生成 patch
  dry-run
  schematic check
  跑仿真
  提取 metrics

可见 UI：
  打开目标 cellView
  修改前展示
  patch 应用后展示
  保存前给工程师审查
```

频繁弹 UI 会慢，也容易受 PDK 初始化、窗口状态和交互 form 影响。更合理的是：后台完成机械步骤，在关键审查点展示 UI。

### 3. 上面出现的问题是不是 SKILL 语法问题？

一部分是，一部分不是。

属于 SKILL/API 兼容问题：

- `rexReplace` 参数数量不兼容。
- 修改成 3 参数后，当前 Cadence 又提示第 3 个参数类型不对。
- 最后临时简化 `vaJsonEscape()` 后，headless open cellView 成功。

不属于 SKILL 问题：

- sandbox 内启动 Virtuoso 触发 Xvfb socket 权限错误。
- 在 `/home/userone/Projects/Project_2026` 写 `bridge-call.il` 失败，是文件系统 sandbox 权限问题。
- visible UI 初始日志出现 `DISPLAY "<not defined>"`，是图形显示环境问题。

后续应该用更保守、已验证的 SKILL 子集，少依赖不确定 helper API。

### 4. visible UI 的 pid 为什么看起来很快退出，但界面仍然打开了？

CLI 返回的 pid 可能是启动包装进程或父进程。Virtuoso GUI 可能已经脱离到桌面 session 中继续运行。因此进程探测不一定可靠。

这次用户在桌面上确认原理图已经打开，是 visible UI path 成功的关键证据。

为便于后续诊断，UI launcher 已支持输出日志路径：

```text
virtuoso-ui.stdout.log
virtuoso-ui.stderr.log
```

## pi agent 如何使用

pi agent 通过 extension 看到工具：

```text
virtuoso_bridge_ping
virtuoso_open_cellview
virtuoso_show_cellview
```

调用链：

```text
用户自然语言
-> pi agent / LLM
-> pi tool call
-> src/extension/index.ts
-> src/runtime/workflows/virtuoso-bridge.ts
-> src/runtime/backends/virtuoso/bridge.ts
-> generated bridge-call.il
-> bridge.il
-> Virtuoso
```

pi 不直接写 SKILL。它只填结构化参数，例如：

```json
{
  "library": "test",
  "cell": "two_stage_amp",
  "view": "schematic",
  "mode": "r",
  "workDir": "/tmp/virtuoso-agent-project-2026"
}
```

## Codex、Claude Code 或其它 agent app 如何使用

因为核心能力在 `src/runtime`，不是写死在 pi extension 里，所以其它 agent 有两种接入方式。

### 方式 1：通过 CLI

Codex、Claude Code、shell script 可以调用：

```bash
vab cellview show \
  --lib test \
  --cell two_stage_amp \
  --view schematic \
  --mode r \
  --json \
  --work-dir /tmp/virtuoso-agent-project-2026
```

当前源码未安装成最终 bin 时，也可以用：

```bash
node --experimental-strip-types packages/virtuoso-agent/src/cli/main.ts \
  cellview show \
  --lib test \
  --cell two_stage_amp \
  --view schematic \
  --mode r \
  --json \
  --work-dir /tmp/virtuoso-agent-project-2026
```

### 方式 2：直接调用 runtime API

TypeScript app 可以调用：

```ts
await showVirtuosoCellView({
  library: "test",
  cell: "two_stage_amp",
  view: "schematic",
  mode: "r",
  workDir: "/tmp/virtuoso-agent-project-2026",
});
```

未来 MCP server 也应该走同一套 runtime API：

```text
MCP tool
-> src/runtime
-> Virtuoso bridge
```

这样不会形成第二套业务逻辑。

## 当前验证命令

已运行并通过：

```bash
npm run check
```

已运行并通过：

```bash
npm run test -w @lzy23321/virtuoso-agent
```

测试结果：

```text
7 test files passed
40 tests passed
```

## 当前边界

已经完成：

```text
pi/CLI -> TS runtime -> generated SKILL -> bridge.il -> Virtuoso
```

已经验证：

```text
headless bridge ping
headless open cellView
visible UI show cellView
```

还没做：

```text
读取 instance list
读取 instance parameters
修改参数
保存 cellView
rollback/revision
长驻 Virtuoso session 通信
```

## 推荐下一步

下一步不要急着做写操作。建议先加只读能力：

```text
list_instances
get_instance_parameters
get_current_cellview
```

这样 agent 已经能打开可见 UI，同时能结构化读取原理图内容。等读取链路稳定后，再进入：

```text
dry-run patch
set_instance_parameter
schematic check
save/commit
```

