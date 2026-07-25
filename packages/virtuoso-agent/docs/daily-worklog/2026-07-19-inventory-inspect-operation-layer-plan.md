# 2026-07-19 工作总结：Inventory 两层化、Schematic/Maestro Inspect 与 Operation Layer 路线

本文记录今天围绕 `virtuoso-agent` 的讨论、实现、真实 Virtuoso 验证结果，以及下一阶段路线。

## 背景结论

今天先确认了一个重要事实：MARCO/YAML 方案虽然是 Cadence IC25.1 之后的新方向，但它依赖较新的 Virtuoso/ADE 能力和 license。当前环境里 `Virtuoso_ADE_Artist` license 曾出现 checkout 问题，因此 MARCO 不能作为近期主线。

近期主线应继续面向更常见的 IC6.1.8 / IC25.1 兼容自动化方式：

```text
schematic / OA database
  db/dd/cdf SKILL API

maestro / ADE setup
  mae* SKILL API

agent integration
  只调用我们封装好的 va* API，不直接执行任意 SKILL
```

目标不是重新实现 agent runtime，而是在 `virtuoso-agent` 内建立稳定、可测试、可迁移的 Virtuoso Operation Layer。

## Inventory 两层化

最初实现过一次全量 `inventory list`，它会一次性读取所有 libraries / cells / views。真实测试显示：

```text
cds.lib: /home/userone/Projects/Project_2026/cds.lib
libraries: 19
cells: 2176
views: 7258
```

这个结果虽然正确，但如果完整 JSON 进入 agent 上下文，会带来明显上下文污染，尤其会把 PDK、analogLib、basic 等大量工艺/系统库内容带进对话。

因此今天改成两层 inventory：

```bash
vab inventory libraries --json --cds-lib /path/to/cds.lib
vab inventory cellviews --lib <lib> --json --cds-lib /path/to/cds.lib
```

### inventory libraries

只返回 library summary，不展开每个 cell/view：

```json
{
  "summary": {
    "counts": {
      "libraries": 19,
      "cells": 2176,
      "views": 7258
    },
    "libraries": [
      {
        "name": "sar_adc_12bit_1MHz",
        "path": "/home/userone/Projects/Project_2026/sar_adc_12bit_1MHz",
        "counts": {
          "cells": 15,
          "views": 33
        }
      }
    ]
  },
  "artifact": {
    "path": "/home/userone/Projects/Project_2026/.virtuoso-agent/inventory/libraries-20260719T090754Z.json",
    "format": "json",
    "kind": "libraries"
  }
}
```

### inventory cellviews

只展开用户指定的一个 library：

```bash
vab inventory cellviews --lib sar_adc_12bit_1MHz --json --cds-lib /home/userone/Projects/Project_2026/cds.lib
```

真实验证结果：

```text
library: sar_adc_12bit_1MHz
cells: 15
views: 33
artifact:
/home/userone/Projects/Project_2026/.virtuoso-agent/inventory/cellviews-sar_adc_12bit_1MHz-20260719T090639Z.json
```

### 删除 inventory list

今天删除了旧的 `inventory list` 兼容别名和相关全量接口：

- 删除 SKILL `vaInventory()`
- 删除 runtime `listVirtuosoInventory()`
- 删除 `VirtuosoInventory` export
- 删除对应测试
- CLI 只保留：

```bash
vab inventory libraries ...
vab inventory cellviews --lib ...
```

验证：

```text
inventory list --json --dry-run
  -> exit code 1, prints usage

inventory libraries --json --dry-run
  -> ok

inventory cellviews --lib sar_adc_12bit_1MHz --json --dry-run
  -> ok
```

基线勘误（2026-07-20）：上述删除范围适用于 CLI、runtime 全量接口和 SKILL
`vaInventory()`。pi extension 当前仍保留 `virtuoso_list_inventory` 旧工具名，并将其映射到
library summary；是否删除该兼容工具需要单独决定。

## Artifact 策略

今天确认并实现了默认 artifact 策略：

```text
默认返回 compact summary
默认保存 full JSON artifact
按需读取 artifact 或按 lib / cellview 重新查询
```

原因是 agent 上下文不应该承载完整工程 inventory 或完整 schematic/maestro 详情。

当前 artifact 目录：

```text
.virtuoso-agent/inventory/
  libraries-*.json
  cellviews-<lib>-*.json

.virtuoso-agent/inspect/
  schematic-<lib>-<cell>-<view>-*.json
  maestro-<lib>-<cell>-<view>-*.json
```

CLI / pi tool 返回中只放：

```text
summary
artifact.path
process/script metadata
```

完整内容放在 JSON 文件里。

## Schematic Inspect

今天实现了 schematic inspect：

```bash
vab schematic inspect \
  --lib test_tb \
  --cell two_stage_amp_tb \
  --view schematic \
  --json \
  --cds-lib /home/userone/Projects/Project_2026/cds.lib
```

底层 SKILL：

```skill
vaInspectSchematic(library cell view mode)
```

读取内容：

- cellView ref
- instances
- instance master lib/cell/view
- instance summary parameters / properties
- nets
- terminals
- counts

真实验证摘要：

```json
{
  "kind": "schematic",
  "cellView": {
    "library": "test_tb",
    "cell": "two_stage_amp_tb",
    "view": "schematic",
    "mode": "r"
  },
  "counts": {
    "instances": 7,
    "nets": 6,
    "terminals": 0
  }
}
```

artifact：

```text
/home/userone/Projects/Project_2026/.virtuoso-agent/inspect/schematic-test_tb-two_stage_amp_tb-schematic-20260719T093855Z.json
```

真实读到的 instances：

```text
IPRB0 -> analogLib/iprobe/symbol
C0    -> analogLib/cap/symbol
I2    -> test/two_stage_amp/symbol
V2    -> analogLib/vdc/symbol, vdc=0
V1    -> analogLib/vdc/symbol, vdc=1.1
V0    -> analogLib/vdc/symbol, vdc=600m, acm=1
I1    -> analogLib/gnd/symbol
```

真实读到的 nets：

```text
Vin-
Vin+
net1
VDD
GND
gnd!
```

## Maestro Inspect

今天实现了第一版 maestro inspect：

```bash
vab maestro inspect \
  --lib test_tb \
  --cell two_stage_amp_tb \
  --view maestro \
  --json \
  --cds-lib /home/userone/Projects/Project_2026/cds.lib
```

底层 SKILL：

```skill
vaInspectMaestro(library cell view)
```

当前读取内容：

- `maeOpenSetup(... ?mode "r")`
- `maeIsSingleTest(...)`
- `maeGetSetup(?typeName "tests" ?session session)`
- `maeGetSetup(?typeName "variables" ?session session)`
- `maeGetSetup(?typeName "outputs" ?session session)`

真实验证摘要：

```json
{
  "kind": "maestro",
  "cellView": {
    "library": "test_tb",
    "cell": "two_stage_amp_tb",
    "view": "maestro",
    "mode": "r"
  },
  "session": "fnxSession0",
  "singleTest": true,
  "counts": {
    "tests": 1,
    "variables": 1,
    "outputs": 0
  }
}
```

artifact：

```text
/home/userone/Projects/Project_2026/.virtuoso-agent/inspect/maestro-test_tb-two_stage_amp_tb-maestro-20260719T093927Z.json
```

artifact 中 MAE raw 结果：

```text
tests: ("test_tb_two_stage_amp_tb_1")
variables: ("Ibias")
outputs: empty
```

### Maestro Inspect 基线勘误（2026-07-20）

再次检查现有 artifact、MAE 官方参考和真实 maestro cellview 后，确认第一版
`vaInspectMaestro` 的 `variables` 和 `outputs` 不能理解为完整结果：

- `maeGetSetup(?typeName "variables")` 在该 setup 中只返回顶层 global variable
  `Ibias`，没有返回各 test 的 design variables。
- `test_tb_two_stage_amp_tb_1` 和 `test_tb_two_stage_amp_tb_1_1` 各自实际记录了 18 个
  design variables：`Ibias`、`W`、`Cc`、`Finput1`、`Finput2`、`Fload1`、`Lbias`、
  `Linput1`、`Linput2`、`Lload1`、`Mul4`、`Mul5`、`Mul8`、`Rz`、`Wbias`、
  `Winput1`、`Winput2`、`Wload1`。
- 当前调用 `maeGetSetup(?typeName "outputs")` 会产生 `EXPLORER-8046` warning；
  `outputs` 不是 `maeGetSetup` 支持的 typeName，因此当前 `outputs: 0` 不代表没有输出。
- 2026-07-20 的只读真实复验返回 `tests: 2`、`variables: 1`、`outputs: 0`；其中
  `variables: 1` 只能解释为当前调用读到的 global-variable name 数量。

这次检查只用于确认基线缺陷。runtime 后续仍应通过受支持的 MAE/ASI API 读取 test-level
design variables 和 outputs，不应把直接解析 `maestro.sdb` 或 `active.state` 作为正式实现。

## Maestro DD Metadata 发现

用户手动查看 `test_tb/two_stage_amp_tb/maestro` 属性，发现：

```text
readPath:
/home/userone/Projects/Project_2026/test_tb/two_stage_amp_tb/maestro

files:
data.dm.ic-design.64281.20260529230506.tmp.a
data.dm
active.state
master.tag
maestro.sdb

Properties:
testName    string "test_tb_two_stage_amp_tb_1"
viewSubType string "explorer"
```

这说明 maestro view 在 DD/OA 层可以读到有价值的轻量 metadata，包括：

- readPath / writePath
- 文件列表
- `testName`
- `viewSubType = explorer`

但真正 ADE setup 内容仍应通过 MAE API 读取和修改，不能直接解析或手改 `maestro.sdb`。

后续 `maestro inspect` 应升级为双层（不一定是双层，得看看api能不能直接实现所有信息的读取）：

```json
{
  "dd": {
    "readPath": ".../maestro",
    "writePath": ".../maestro",
    "files": ["maestro.sdb", "active.state", "..."],
    "properties": {
      "testName": "test_tb_two_stage_amp_tb_1",
      "viewSubType": "explorer"
    }
  },
  "mae": {
    "session": "fnxSession0",
    "singleTest": true,
    "tests": "...",
    "variables": "...",
    "outputs": "..."
  }
}
```

## PDF / MAE API 路线

今天确认 `/mnt/hgfs/Share/maeSKILLref.pdf` 中的章节：

```text
Virtuoso ADE SKILL Reference
Maestro Cellview Functions
Functions to Create, View, Edit, and Save Setups in maestro Cellviews
```

这是后续 Maestro 自动化的核心依据。

但当前不打算先做完整 RAG 或完整函数库整理。更合适的工程路线是：

```text
PDF -> 人和 agent 一起挑常用基础函数
    -> 封装稳定 va* API
    -> 大量 dry-run / fake-output / 真实工程测试
    -> 让 agent 只调用 va* API
    -> 之后再做 RAG 作为辅助查文档能力
```

原因：

- 直接让 agent 每次查 PDF 再拼 SKILL 风险高。
- SKILL 函数名、参数组合、返回值容易出错。
- 修改操作需要权限策略、proposal/apply 分离、artifact 和验证。
- 我们需要的是稳定 operation layer，而不是文档搜索优先。

## 下一阶段：Virtuoso Operation Layer

下一阶段目标是建立一组常用、稳定、可测试的 `va*` 操作函数，覆盖 99% 常见手动点击工作。

### 第一层：只读 Inspect

覆盖“我打开 GUI 看信息”的常见操作：

```text
vaListLibraries
vaListCellViews
vaInspectSchematic
vaInspectMaestro
vaInspectMaestroDDMetadata
vaInspectMaestroVariables
vaInspectMaestroAnalyses
vaInspectMaestroOutputs
vaInspectMaestroCorners
```

这层全部只读，适合大量真实库测试。

### 第二层：受控 Modify

覆盖“我手动改参数/设置”的常见操作，但必须 proposal/apply 分离：

```text
vaProposeSetSchematicInstanceParam
vaApplySetSchematicInstanceParam

vaProposeSetMaestroVariable
vaApplySetMaestroVariable

vaProposeSetMaestroOutput
vaApplySetMaestroOutput

vaProposeSetAnalysisOption
vaApplySetAnalysisOption
```

修改原则：

```text
inspect current state
generate proposal
user confirms
apply
save
reopen / inspect verify
```

### 第三层：Create

覆盖“我新建 schematic / maestro setup / test”的常见操作：

```text
vaCreateSchematicFromTemplate
vaCreateMaestroFromSchematic
vaCreateMaestroTest
vaCreateMaestroVariable
vaCreateMaestroOutput
vaSaveMaestro
```

这一层最后做，因为最容易产生垃圾 cellview 或破坏工程结构。

## 建议下一个最小闭环

建议不要马上做“万能创建/修改”。下一步优先做一个真实闭环：

```text
maestro variable read
-> propose modify
-> apply modify
-> save
-> reopen inspect verify
```

目标对象：

```text
library: test_tb
cell: two_stage_amp_tb
view: maestro
variable: Ibias
```

如果这个闭环跑通，后续 analyses、outputs、corners、schematic instance params 都可以照这个模型扩展。

## 今日验证

今日测试：

```bash
npm test -- test/cli/runner.test.ts test/runtime/backends/virtuoso/bridge.test.ts
npm run build
```

结果：

```text
44 targeted tests passed
build passed
```

真实 Virtuoso 验证：

```text
inventory libraries
inventory cellviews --lib sar_adc_12bit_1MHz
schematic inspect test_tb/two_stage_amp_tb/schematic
maestro inspect test_tb/two_stage_amp_tb/maestro
```

均已跑通。

## 2026-07-20 基线复验

本轮只整理和复验现有基线，没有开始 proposal/apply 或新的 Maestro inspect 实现。

```text
targeted tests: 47 passed
npm run check: passed
package build: passed
real maestro inspect: completed in read-only mode
```

已知基线问题：

- 第一版 Maestro `variables` 只统计当前调用返回的 global-variable names，不包含 test-level
  design variables。
- 第一版 Maestro `outputs` 使用了 `maeGetSetup` 不支持的 typeName，当前计数不可信。
- CLI/runtime 的旧全量 inventory 接口已删除，但 pi extension 仍保留一个映射到 library
  summary 的旧工具名。
