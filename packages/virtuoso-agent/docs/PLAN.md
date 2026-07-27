# virtuoso-agent 功能与架构规划

## 1. 项目定位

`virtuoso-agent` 提供可复用的 Cadence Virtuoso 自动化 runtime，并优先通过 pi agent 暴露能力。它不实现新的 agent runtime。

职责边界：

- pi agent：对话、LLM、tool calling、session 和 UI。
- virtuoso-agent：managed Virtuoso bridge、SKILL/OCEAN/Spectre backend、bundle、权限、job 和结果解析。

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
  -> one single-point OCEAN script per test
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
    │   └── netlist/
    │       └── input.scs + dependencies
    └── 002/
        ├── test.json
        ├── single.ocn
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

## 5. 已完成功能

- managed Virtuoso instance 注册、发现、选择和 session binding
- command queue、heartbeat 和 result protocol
- library/cell/view inventory
- current/show CellView
- schematic native bundle export
- Maestro Assembler top-level OCEAN XL export
- Maestro test discovery
- per-test single-point OCEAN export
- per-test no-run netlist generation
- 每个 test 完成后立即快照完整 netlist 目录
- bundle manifest、hash 和文件级验证
- CLI：
  - `vab schematic export`
  - `vab maestro export`
- pi tool：
  - `virtuoso_export`
- Spectre task runner 和既有 job artifacts

真实验收目标：

```text
test_tb / two_stage_amp_tb / schematic
test_tb / two_stage_amp_tb / maestro
```

已在同一个长驻 `-nograph` managed Virtuoso instance 中完成两类 bundle 导出。Maestro 的两个 test 生成了不同的 `input.scs`，未执行仿真。

## 6. 已删除的旧方案

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

## 7. 下一阶段

### P1：Bundle 健壮性

- 部分 test 失败时保留成功 artifact，并在 manifest 标记 per-test failure。
- 捕获 Cadence warning 和 session close 状态。
- 校验 OCN/SCS 中引用的关键相对文件存在。
- 增加 bundle 大小和文件数量统计。
- 明确 bundle retention/cleanup 策略。

### P2：仿真前检查

Preflight 属于仿真阶段，不属于读取阶段。

- 从 OCN/SCS 检查 model/include 路径。
- 检查 enabled tests、analysis 和 simulator。
- 检查 Spectre executable 和必要运行条件。
- 输出 blocking issues 与 warnings。

### P3：异步仿真生命周期

```text
prepare -> start -> status -> logs -> stop -> result
```

- 使用 runId。
- Maestro test 和 standalone SCS 共用生命周期外层。
- 不把长时间仿真阻塞在一个 tool call 内。

### P4：结果读取和比较

- Spectre log error/warning
- scalar metrics
- waveform 数值点
- raw result artifact
- before/after metrics 和 waveform comparison

### P5：安全修改闭环

写回继续使用受控 SKILL API，与 OCN 读取方案分离：

```text
preview -> approve -> apply -> read/export verify -> simulate -> compare
```

第一批修改能力：

- instance 参数
- Maestro design variable
- test enable/disable

### 后续

- schematic 新建
- Verilog-A 新建/修改
- config、symbol、DSPF
- destructive delete with backup and explicit confirmation
- GUI/CellView screenshot 和波形图片延后
