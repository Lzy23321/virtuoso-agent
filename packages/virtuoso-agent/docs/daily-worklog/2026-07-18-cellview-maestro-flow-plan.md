# 2026-07-18 工作总结：CellView 识别、Maestro 流程规划与现有 inspect 能力定位

本文记录本次围绕 `virtuoso-agent` 后续能力边界的讨论结论，以及当前已经具备的 CellView 读取能力在后续架构中的定位。

## 本次讨论目标

目标是明确如果要实现以下完整流程，`virtuoso-agent` 需要补齐哪些能力：

- 识别所有已有 library / cell / view 信息。
- 重点识别并读取 maestro cellview / ADE Explorer / ADE Assembler setup 信息。
- 把已有设计和仿真配置总结给用户。
- 新建原理图。
- 新建仿真 test / analysis / output / spec。
- 生成或保存 maestro setup。
- 对已有 schematic、simulation、outputs、specs 等进行受控修改。

结论是：这套能力应该继续遵守三层分离原则。

```text
src/runtime
  Virtuoso / Maestro 领域模型、schema、SKILL bridge、diff/proposal、artifacts

src/extension
  pi agent tool adapter

src/cli
  CLI adapter，服务 Codex、Claude Code、shell 和脚本
```

pi agent 不负责重新实现 agent runtime，也不直接承载 Virtuoso 业务逻辑。

## 当前代码现状

当前 `packages/virtuoso-agent` 已经具备一条基础受控 bridge：

```text
packages/virtuoso-agent/skill-runtime/bridge.il
packages/virtuoso-agent/src/runtime/backends/virtuoso/bridge.ts
packages/virtuoso-agent/src/runtime/workflows/virtuoso-bridge.ts
packages/virtuoso-agent/src/cli/runner.ts
```

已有能力包括：

- `vaPing()`：验证 Virtuoso 能加载 `bridge.il`。
- `vaOpenCellView(library cell view mode)`：headless 打开指定 cellview 并返回 JSON。
- `vaShowCellView(library cell view mode)`：在 Virtuoso UI 中展示指定 cellview。
- `vaGetCurrentCellView()`：读取当前编辑 cellview。
- `vaListInstances(library cell view mode)`：列出 cellview 中的 instances。
- `vaGetInstanceParameters(library cell view instanceName mode)`：读取指定 instance 的参数。
- `vaCellViewSummary(library cell view mode)`：汇总 cellview 中的 instances 和参数摘要。

这些能力已经在 TypeScript runtime 中有对应包装：

- `pingVirtuosoBridge()`
- `openVirtuosoCellView()`
- `showVirtuosoCellView()`
- `getCurrentVirtuosoCellView()`
- `listVirtuosoInstances()`
- `getVirtuosoInstanceParameters()`
- `summarizeVirtuosoCellView()`

## 关于已有 CellView 参数读取和 summary 函数的结论

不建议删除已有的读取 cellview 器件参数和 summary 函数。

它们应当重新定位为后续 `inspect` 层的基础能力：

- 修改 schematic 前，需要先读取当前状态。
- 生成 proposal / diff 前，需要知道当前 instances、masters、parameters。
- 修改后，需要再次读取并验证结果。
- Maestro test 通常会指向某个 schematic design，Maestro inspect 需要能下钻查看该 schematic 摘要。
- pi agent 给用户解释已有电路时，需要低成本、结构化、可压缩的 cellview summary。

后续可以重构其对外形态，但不应直接移除：

- 可以把 `listInstances` / `getInstanceParameters` 变成内部 helper。
- 可以统一到新的 `inspectCellView` / `summarizeSchematic` API。
- 可以保留旧 CLI 命令作为兼容 alias。
- 需要补齐 CDF effective value、pin/net 连接、master 信息、terminal 信息等更完整字段。

## 后续需要补齐的能力

### 1. Library / CellView Inventory

新增只读 inventory 能力，扫描当前 Virtuoso 环境可见的 libraries、cells、views，并识别 view 类型：

- schematic
- symbol
- layout
- maestro
- config
- extracted / av_extracted
- 其它 PDK 或项目自定义 view

该能力应使用 Virtuoso `dd/db` 相关 API，而不是单纯扫描文件系统目录。原因是 `cds.lib`、library mapping、managed library、viewType 等信息不能可靠地从目录名推断。

建议新增 runtime API：

```ts
listVirtuosoLibraries()
listVirtuosoCellViews()
inspectVirtuosoCellView()
```

建议 CLI：

```bash
vab inventory list --json
vab cellview inspect --lib <lib> --cell <cell> --view <view> --json
```

### 2. Maestro 读取模型

新增 `MaestroSetupSummary` 结构，用于读取并总结 maestro setup：

- setup library / cell / view
- session 名称
- tests
- 每个 test 的 design：lib / cell / view
- simulator
- analyses：tran / dc / ac / noise / pss 等
- variables / global variables
- corners
- outputs / expressions
- specs：min / max / target / pass-fail
- run mode / run options
- histories / results 摘要

本次查看 `/mnt/hgfs/Share/maeSKILLref.pdf`，确认该文件是 `Virtuoso ADE SKILL Reference`，Product Version `IC25.1`，日期为 `June 2025`。其中包含 Maestro / ADE Explorer / ADE Assembler 相关 MAE API，可作为实现依据。

后续重点 API 类别包括：

- `maeOpenSetup`
- `maeGetSessions`
- `maeGetSetup`
- `maeGetAnalysis`
- `maeGetEnabledAnalysis`
- `maeGetVar`
- `maeGetParameter`
- `maeGetTestOutputs`
- `maeGetSpecStatus`
- `maeGetSimOption`
- `maeCloseSession`

建议新增 CLI：

```bash
vab maestro inspect --lib <lib> --cell <cell> --view <view> --json
```

### 3. Maestro 新建和修改

新增结构化 patch schema，不允许 LLM 直接生成任意 SKILL 执行。

示例目标结构：

```json
{
  "operation": "update_maestro",
  "target": {
    "library": "myLib",
    "cell": "ota_tb",
    "view": "maestro"
  },
  "changes": [
    {
      "op": "create_test",
      "name": "tran_test",
      "design": {
        "library": "myLib",
        "cell": "ota_tb",
        "view": "schematic"
      }
    },
    {
      "op": "set_analysis",
      "test": "tran_test",
      "analysis": "tran",
      "options": {
        "stop": "10u"
      }
    },
    {
      "op": "add_output",
      "test": "tran_test",
      "name": "gain",
      "expression": "value(...)"
    },
    {
      "op": "set_spec",
      "output": "gain",
      "min": "60"
    }
  ]
}
```

MAE API 映射方向：

- `maeOpenSetup`
- `maeCreateTest`
- `maeSetDesign` / `maeSetDesignForTest`
- `maeSetAnalysis`
- `maeSetSimOption`
- `maeSetVar`
- `maeSetCorner`
- `maeAddOutput`
- `maeSetSpec`
- `maeSaveSetup`
- `maeCloseSession`

建议 CLI：

```bash
vab maestro propose <plan.json> --json
vab maestro apply <plan.json> --json
```

### 4. Schematic 新建和修改

新增 schematic patch schema，覆盖：

- 新建 schematic cellview。
- 放置 instance。
- 设置 CDF 参数。
- 创建 pin / terminal。
- 创建 net。
- 连线。
- 修改已有 instance 参数。
- 替换 instance master。
- 删除 instance / wire / net。
- 保存并检查。

必须明确输入：

- 目标 library / cell / view。
- 使用的 PDK master library / cell / view。
- instance name。
- 坐标或自动布局策略。
- pins / terminals / nets。
- CDF 参数名和值。
- 是否允许覆盖已有 cellview。

建议 CLI：

```bash
vab schematic propose <plan.json> --json
vab schematic apply <plan.json> --json
```

### 5. 权限、安全和 artifacts

所有写操作默认走三步：

```text
inspect -> propose -> apply
```

安全策略：

- 默认只读。
- 默认 dry-run。
- 写操作需要 `allowWrite: true` 或用户明确确认。
- 写之前生成 proposal / diff。
- 尽可能支持 backup / copy cellview。
- 检查 lock 状态。
- 禁止默认覆盖 production cell。
- 失败时保留 artifacts。

建议 artifacts：

- generated SKILL script
- stdout / stderr
- result JSON
- proposal JSON
- before / after summary
- Virtuoso log path

### 6. 仿真运行和结果总结

后续在 Maestro 创建/修改后，需要支持运行和读取结果：

- 启动 simulation。
- 等待完成。
- 读取 outputs。
- 读取 specs 状态。
- 汇总 pass / fail。
- 输出用户可读报告。

相关 API 方向：

- `maeRunSimulation`
- `maeWaitUntilDone`
- `maeCheckSimStatus`
- `maeGetOutputValue`
- `maeGetResultOutputs`
- `maeGetSpecStatus`
- `maeGetOverallSpecStatus`

建议 CLI：

```bash
vab maestro run --lib <lib> --cell <cell> --view <view> --json
vab results summarize --history <history> --json
```

## 推荐实现顺序

1. 完成 read-only inventory，列出所有 library / cell / view，并识别 maestro view。
2. 完成 `cellview inspect`，把现有 instance / parameter summary 升级为统一 inspect API。
3. 完成 `maestro inspect`，能告诉用户已有 tests、analyses、variables、outputs、specs。
4. 完成 `maestro propose`，先只生成结构化修改计划和 diff，不写库。
5. 完成 `maestro apply`，先支持 create test、set design、set analysis、add output、set spec、save。
6. 完成 schematic patch，先支持修改已有 instance 参数，再支持新增 instance 和新建 schematic。
7. 完成 run / result summary，形成创建、修改、运行、读取结果的闭环。
8. 将 runtime API 接入 pi tools，extension 只做 adapter。

## 今天记录的功能

今天没有修改 runtime 源码；本次工作主要是梳理方向、确认现有能力定位，并新增本文档。

当前已经存在并应继续保留的功能包括：

- 打通 TypeScript runtime 到 Virtuoso SKILL bridge 的调用链。
- 支持 headless `virtuoso -nograph -restore` 执行受控 SKILL 调用。
- 支持 visible UI 模式打开 cellview。
- 支持读取当前 cellview。
- 支持打开指定 cellview。
- 支持列出 cellview 中的 instances。
- 支持读取指定 instance 的参数。
- 支持生成 cellview summary。

其中读取 instance 参数和 cellview summary 不是临时功能，应作为后续 `inspect`、`proposal`、`apply verification` 的基础能力继续演进。
