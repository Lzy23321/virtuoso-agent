# virtuoso-agent 功能与架构规划

## 1. 项目定位

`virtuoso-agent` 提供可复用的 Cadence Virtuoso 自动化 runtime，并优先通过 pi agent 暴露能力。它不实现新的 agent runtime。

职责边界：

- pi agent：对话、LLM、tool calling、session 和 UI。
- virtuoso-agent：managed Virtuoso bridge、SKILL/OCEAN/Spectre backend、bundle、权限、仿真生命周期和结果解析。

代码保持三层：

```text
src/runtime    可迁移核心能力
src/extension  pi tool adapter
src/cli        CLI adapter
```

## 2. 当前读取方案

Schematic 和 Maestro 不再通过大量 SKILL API 逐项读取并重建自定义数据结构。

读取统一改为 Cadence-native simulation bundle：

```text
Schematic CellView
  -> Cadence createNetlist()
  -> complete Spectre netlist directory

Maestro CellView
  -> Assembler OCEAN XL
  -> test discovery
  -> one top-level Maestro OCEAN XL script
  -> one single-point OCEAN script per test
  -> one sweep/corners/parameters/specs/Monte Carlo OCEAN XL script per test
  -> one complete Spectre netlist directory per test
```

理由：

- Spectre/OCEAN 已表达拓扑、参数、模型、分析、变量、输出、spec、sweep 和 job setup。
- 避免维护容易出错的第二套 Cadence 数据格式。
- 不需要枚举 MOS 等器件的数百个属性。
- 不需要对自定义结构做复杂 round-trip 验证。
- 大文件保留在 artifact 中，agent 按需读取。

## 3. 长驻进程模型

所有导出操作复用 registered managed Virtuoso instance：

```text
agent / CLI
  -> managed instance registry
  -> command queue
  -> existing Virtuoso SKILL interpreter
  -> OCEAN / Maestro / createNetlist APIs
```

约束：

- 不为每个命令启动 `ocean -restore`。
- 不为每个 test 启动新的 Virtuoso。
- 首次使用时允许 Virtuoso 加载 Analog/ASI/OCEAN context。
- 后续调用复用已加载 context。
- bundle export 不调用 `run()`。
- 临时 Maestro/OCEAN session 可以关闭，但 bridge 进程保持运行。

## 4. Bundle 格式

### 4.1 Schematic

```text
bundle/
├── bundle.json
└── schematic/
    └── netlist/
        ├── input.scs
        ├── ade_e.scs
        ├── netlist
        ├── ihnl/
        ├── amap/
        └── other Cadence dependencies
```

### 4.2 Maestro

```text
bundle/
├── bundle.json
├── maestro/
│   └── maestro.ocn
└── tests/
    ├── 001/
    │   ├── test.json
    │   ├── single.ocn
    │   ├── sweep.ocn
    │   └── netlist/
    │       └── input.scs + dependencies
    └── 002/
        ├── test.json
        ├── single.ocn
        ├── sweep.ocn
        └── netlist/
            └── input.scs + dependencies
```

`bundle.json` 只保存：

- schema version 和 bundle kind
- CellView target
- generated time、Virtuoso version、managed instance ID
- 是否执行仿真
- Maestro test 名称和 enabled 状态
- artifact 相对路径和原始 Cadence 路径
- primary file SHA-256
- 文件级验证结果和 warnings

不解析并复制 OCN/SCS 的全部业务语义。

Maestro export 支持四种选择范围：

- `all`：顶层 Maestro OCN 和所有 test artifacts，默认值
- `top`：只导出 `maestro/maestro.ocn`
- `tests`：只导出所有 test 的 single、sweep 和 netlist
- `test`：通过精确 test name 只导出一个 test

## 5. 已完成功能

### 5.1 Managed Virtuoso

- managed Virtuoso instance 注册、发现、选择和 session binding
- command queue、heartbeat 和 result protocol
- 显式启动可见 Virtuoso UI，后续操作复用同一长驻进程
- library/cell/view inventory
- current/show CellView

pi tool：

- `virtuoso_instances`
- `virtuoso_instance_launch`
- `virtuoso_inventory`
- `virtuoso_cellview`

CLI：

- `vab session start/list`
- `vab inventory libraries/cellviews`
- `vab cellview current/show`

### 5.2 Cadence-native 读取与导出

- schematic native bundle export
- Maestro Assembler top-level OCEAN XL export
- Maestro test discovery
- per-test single-point OCEAN export
- per-test Sweeps, Corners, Parameters, Specs & Monte Carlo OCEAN XL export
- per-test no-run netlist generation
- 每个 test 完成后立即快照完整 netlist 目录
- bundle manifest、hash 和文件级验证
- Maestro `all/top/tests/test` 选择性导出
- 只读打开 Maestro setup，逐 test sweep 导出后恢复原 enabled 状态
- `virtuoso_export` pi tool
- `vab schematic export` 和 `vab maestro export` CLI

### 5.3 已完成验证

真实验收目标：

```text
test_tb / two_stage_amp_tb / schematic
test_tb / two_stage_amp_tb / maestro
```

已在同一个长驻 `-nograph` managed Virtuoso instance 中完成两类 bundle 导出。Maestro 的两个 test 生成了不同的 `input.scs`，未执行仿真。

选择性 Maestro export 已在真实 IC25.1 环境验证：

- `top` 只生成顶层 `maestro.ocn`
- `test` 只生成指定 test，并保留其原始 test index
- `all`、`top`、`tests`、`test` 均有 runtime、CLI 和 pi extension 回归测试

## 6. 当前能力边界

- `virtuoso_export` 只导出 Cadence-native 仿真输入 artifact，不执行仿真。
- export bundle 可用于审阅和前后比较，但不能恢复可编辑 schematic 或 Maestro，因此不作为设计 backup。
- 尚不支持 Maestro 全量或单 test 运行、运行状态查询、停止和结果读取。
- 尚不支持 scalar output、spec evaluation 或 waveform 读取。
- 尚不支持 schematic/Maestro 修改。
- 尚不支持 instance 创建、删除、连线或从零创建设计。

## 7. 下一阶段

### P1：Maestro Replay 闭环

目标是完成第一条无设计写入的真实闭环：

```text
Task JSON
  -> select managed instance and Maestro/test
  -> preflight
  -> start
  -> status/logs/stop
  -> existing output/spec extraction
  -> result artifacts
```

- 增加明确的 Replay task schema，目标使用 `library/cell/view`、Maestro scope 和可选 test name。
- 支持运行完整 Maestro 和指定 test。
- 使用异步 `runId` 生命周期，避免长仿真阻塞单次 tool call。
- 增加 timeout、stop、Spectre/Cadence error 和 partial result 状态。
- 第一版只读取 Maestro 已定义的 outputs/specs，不让 LLM 直接生成 OCEAN/Calculator 表达式。
- scalar metric 记录 value、unit、test、corner、sweep point 和 pass/fail/unknown。
- waveform 第一版保存为 artifact 引用；rise time、overshoot 等派生结果单独保存为 scalar metric。
- Replay 前后验证设计输入未发生变化。

P1 完成标准：

- 同一 managed Virtuoso instance 中可运行完整 Maestro 或单 test。
- 能查询进度、读取日志并停止运行。
- 能返回已有 scalar output/spec 及其 provenance。
- 成功、失败、超时和取消均生成完整 job result。

### P2：结果和比较能力

- 读取 Spectre raw result 和 waveform。
- 支持按 test/corner/sweep point 查询结果。
- 支持两个 job 的 scalar、spec 和 waveform comparison。
- 增加 bundle/job retention 和 cleanup 策略。

### P3：低风险 Simulation Modify

先只实现 Maestro design variable 修改：

```text
plan -> preview -> approve -> restore point -> apply -> export verify -> simulate -> compare
```

- 修改项包含 test、变量名、期望旧值、新值和单位。
- 旧值不匹配时拒绝执行，防止基于过期状态写入。
- 每次 apply 都创建可恢复 restore point，不采用“每个 TB 只备份一次”。
- `virtuoso_export` 保存修改前后的审阅证据，但不承担恢复职责。
- 在真实 Virtuoso 中通过 modify、restore、re-export 一致性验证后，才开放 apply。
- Analysis、Output、Spec 和 Corner 的新增删除继续暂缓。

### P4：Design Modify

- 第一批只支持已有 instance parameter set。
- target 必须包含 CellView、instance 标识、参数名和期望旧值。
- 不支持 device create/delete 和 connectivity。
- 继续使用 plan/approve/apply/verify/rollback 流程。

### P5：Create

Create 继续延期，首版应基于经过验证的模板或参数化 generator：

- schematic cellview、instance、parameter、wire 和 pin
- Maestro test、analysis、corner、output 和 spec
- 创建前生成 dry-run plan，显式批准后执行
- 创建后通过 export 和仿真验证

## 8. 已删除的旧读取方案

- schematic instances/parameters/terminals/nets/connections 逐项读取
- custom schematic inspect JSON
- custom schematic topology `.net`
- Maestro analyses/corners/models/outputs/variables 逐项读取
- custom Maestro inspect JSON
- 两套 inspect manifest validator
- `virtuoso_inspect`
- `vab schematic inspect`
- `vab maestro inspect`
- `cellview instances`
- `instance params`

历史 daily worklog 保留，用于说明旧设计和迁移原因，不代表当前 API。

## 9. 延后能力

- schematic 新建
- Verilog-A 新建/修改
- config、symbol、DSPF
- destructive delete with backup and explicit confirmation
- GUI/CellView screenshot 和波形图片延后
