# virtuoso-agent 功能与架构规划

## 1. 项目定位

`virtuoso-agent` 最终希望成为一个能够接收电路设计目标，并借助 Cadence Virtuoso 自主完成多步设计工作的系统。

当前阶段不实现 Goal/Plan 模式，也不重新实现 agent runtime。pi agent 继续负责对话、LLM 推理、tool calling 和 session 管理；`virtuoso-agent` 先把可独立调用、可组合的 Virtuoso 基础能力做完整。

当前功能分为四类：

1. **读**：读取设计、Maestro 配置、仿真日志、指标和波形数值。
2. **运行**：准备、启动、查询、停止仿真并获取结果。
3. **检查与比较**：仿真前检查、修改前预览、修改后验证和结果比较。
4. **变更**：修改、新建和删除 Virtuoso 对象。

“看”和“画”暂不进入近期范围：

- 不实现 Virtuoso GUI 或 CellView 自动截图。
- 不实现波形图片生成。
- 仿真波形仍可以作为数值点、指标和原始 artifact 读取。

## 2. 架构边界

项目保持三层分离：

```text
src/runtime
  可迁移的 Virtuoso 核心逻辑、workflow、数据格式和 backend

src/extension
  pi 专用 tool adapter，只负责参数转换和输出展示

src/cli
  CLI adapter，与 pi 调用同一套 runtime
```

架构原则：

- 基础功能必须首先实现在 runtime，不得只存在于 pi tool 或 CLI。
- SKILL、Maestro/OCEAN、Spectre 和文件解析属于 backend，上层 workflow 不依赖具体命令细节。
- 简单请求直接调用单个 runtime 能力，不经过 Goal/Plan。
- 只在读、运行、检查和变更能力稳定后，才从真实多步流程中归纳 Goal 模式。
- 不建立一个包含所有功能的巨型 request schema；公共外层统一，具体功能保留自己的 input/output schema。

## 3. P0：最小公共格式

P0 的目标不是建立通用 Operation 引擎，而是解决当前 runtime 中目标、结果和 artifact 各自定义的问题。

### 3.1 统一 CellView 目标

```ts
interface CellViewRef {
	library: string;
	cell: string;
	view: string;
}
```

约束：

- `library/cell/view` 是 CellView 的稳定身份。
- `mode` 是打开选项，不是 CellView 身份的一部分。
- `instanceId`、`cdsLib`、`sessionDir` 是执行上下文，不放入 CellViewRef。
- Schematic 和 Maestro 首先共用 CellViewRef；真的出现新的目标类型后再增加，不提前设计通用 Target 树。

### 3.2 复用现有 RuntimeResult

```ts
type RuntimeResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: RuntimeError };
```

保留现有的 `type`、`stage`、`message` 和 `details`。P0 不再引入另一套成功/失败包装。

### 3.3 统一 ArtifactRef

```ts
interface ArtifactRef {
	kind: string;
	format: "json" | "text" | "log" | "csv" | "binary";
	path: string;
	createdAt: string;
}
```

第一阶段使用本地文件路径。如果以后出现 MCP、远程存储或 URI，再扩展引用方式。

### 3.4 统一 Inspect 结果外层

```ts
interface InspectResult<TSummary> {
	target: CellViewRef;
	summary: TSummary;
	artifacts: ArtifactRef[];
	warnings: string[];
}
```

规则：

- `summary` 必须足够小，可以直接返回给 agent。
- 完整 manifest 写入 artifact，不默认内联到 tool result。
- `warnings` 用于表示检查成功但信息不完整的情况。
- instance 信息和 bridge 命令路径可作为诊断上下文保留，但不应成为业务 summary 的一部分。

### 3.5 P0 的实施方式

1. 在 `src/runtime/core` 中定义 `CellViewRef`、`ArtifactRef` 和 `InspectResult`。
2. 保留并复用现有 `RuntimeResult` 和 `RuntimeError`。
3. 现有 Maestro inspect 先迁移到公共外层；Schematic inspect 在 P1 实现时直接使用该格式。Inventory 复用 ArtifactRef，但不强行伪装成 CellView inspect。
4. 每迁移一项能力，补充该能力的精确测试。
5. pi extension 只读取 summary 用于文本输出，完整数据通过 artifact 路径按需获取。

P0 完成标准：

- Schematic 和 Maestro 使用同一个 CellViewRef。
- inspect 功能都返回 summary + artifacts + warnings。
- 不再为每个 inspect 功能重复定义 artifact 结构。
- CLI 和 pi adapter 不直接解析 SKILL 输出。

## 4. 功能优先级

| 优先级 | 功能 | 近期内容 | 价值 | 成本 | 当前状态 |
|---:|---|---|---:|---:|---|
| P0 | 统一读取接口格式 | 统一 CellViewRef、InspectResult、ArtifactRef，复用 RuntimeResult | 很高 | 中 | 已完成；Maestro 已迁移，Schematic 将在 P1 直接使用 |
| P1 | 读取 Schematic | instances、master、parameters、terminals、nets、connections、hierarchy | 很高 | 中—高 | 部分实现，缺少连接关系等核心信息 |
| P2 | 完善 Maestro 读取 | tests、variables、analyses、corners、outputs、models、design target、netlist 状态 | 很高 | 中 | 主体已实现，需统一结果并补缺口测试 |
| P3 | 仿真前检查 | CellView、setup、enabled tests、models、simulator、outputs、netlist 可用性 | 很高 | 中 | 已有较多检查数据，尚未形成独立 preflight 结果 |
| P4 | 仿真生命周期 | prepare、start、status、logs、stop、result，使用异步 runId | 很高 | 高 | 未完成 |
| P5 | 读取仿真结果 | 日志、warning/error、标量指标、waveform 数值点和原始结果引用 | 很高 | 高 | 未完成 |
| P6 | 检查与比较 | schematic diff、Maestro diff、metrics diff、waveform 数值比较 | 很高 | 中 | 未完成 |
| P7 | 安全修改 | instance 参数、Maestro design variable、test enable/disable；preview、approve、apply、verify | 很高 | 中—高 | 未完成 |
| P8 | Schematic 新建 | 创建 instance、terminal、net 和 connection | 高 | 高 | 未完成 |
| P9 | 文本 CellView 新建/修改 | Verilog-A 优先；读取、创建、更新和检查 | 高 | 中 | 未完成 |
| P10 | 扩展其他对象 | config、symbol、DSPF 等按真实需求逐项增加 | 中—高 | 高 | 未完成 |
| P11 | 删除 | instance、net、CellView、library；destructive 权限、强确认、备份和验证 | 中 | 高风险 | 未完成 |
| 延后 | 看与画 | GUI/CellView 截图、波形图片生成 | 中—高 | 高 | 待其他基础能力稳定后评估 |

## 5. 当前里程碑：第一阶段 A

第一阶段 A 只实现 Schematic 和 Maestro 的读取能力，不实现 Goal、修改、新建、仿真运行或可视化。

执行顺序：

```text
P0 最小公共格式
  → P1 Schematic 完整读取
  → P2 Maestro 读取收口
```

### 5.1 Schematic 读取范围

必须包含：

- CellView 基本信息。
- 顶层 terminals。
- instances 的名称、master library/cell/view 和可用参数。
- nets 的名称和类型。
- instance terminal 与 net 的连接关系。
- 未连接端口和其他可识别的结构警告。
- 直接子实例引用；第一版不递归展开全部 hierarchy。

输出：

- 给 agent 的紧凑 summary。
- 包含完整结构数据的 `schematic-inspect` JSON artifact。
- warnings，用于记录无法解析或信息不完整的对象。

### 5.2 Maestro 读取范围

必须包含：

- setup 有效性和基本 session 信息。
- tests 及 enabled 状态。
- 每个 test 的 design target 和 simulator。
- global/test design variables。
- analyses 和 effective settings。
- corners、temperature、model files 及可用性。
- outputs 的 signal/expression/script 信息、plot/save 和 spec。
- 已有 netlist 的位置和可用性。

收口工作：

- 迁移到 P0 的 InspectResult 和 ArtifactRef。
- 区分“信息不完整的读取成功”与“无法打开 setup”。
- 将缺失 model file、无 enabled test、缺失 simulator 等转成明确 warnings。
- 为 managed session 路径补齐直接测试。

### 5.3 第一阶段 A 验收场景

给定一个已有 opamp 工程，agent 可以：

1. 发现指定 schematic 和 Maestro CellView。
2. 生成完整 schematic manifest。
3. 说明 schematic 中有哪些器件、参数、端口、net 和连接关系。
4. 生成完整 Maestro manifest。
5. 说明 Maestro 中有哪些 tests、analyses、corners、variables、outputs 和 models。
6. 所有完整数据都保存为 artifact，tool result 只返回摘要和路径。
7. 整个过程只读，不修改设计，不启动仿真。

## 6. P3 当前状态

P3 不算完成，但 Maestro inspect 已经为它提供了较多基础数据。

已有：

- Maestro session 能否打开以及是否有效。
- tests 和 enabled tests。
- 每个 test 的 design target 和 simulator 名称。
- analyses、corners、outputs 和 variables。
- model file 解析路径及 `available` 状态。
- 已有 netlist 目录及 `available` 状态。

未完成：

- 没有独立、统一的 preflight result。
- 没有为每个 enabled test 给出 `ready/blocking/warning` 结论。
- 没有验证 simulator 可执行性和 license 条件。
- 没有验证 output expression/script 是否能够求值。
- netlist `available: false` 只表示当前没有可用目录，没有证明配置无法生成 netlist。
- 没有将缺失 model、无 enabled tests、缺失 analysis 等统一映射为 blocking issues。

P3 依赖第一阶段 A 产生的稳定 Maestro manifest。因此当前先完成 P0–P2，然后将 P3 实现为对 manifest 的检查层，而不是在 SKILL inspect 中继续堆叠业务判断。

## 7. 后续里程碑

### 第一阶段 B：仿真闭环

```text
P3 仿真前检查
  → P4 仿真启动/状态/日志/停止
  → P5 指标和波形数值读取
  → P6 结果比较
```

### 第一阶段 C：最小修改闭环

```text
P7 修改一个 instance 参数或 Maestro design variable
  → 重新读取验证
  → 重新仿真
  → 比较修改前后结果
```

### 第二阶段：新建与扩展

```text
P8 Schematic 新建
  → P9 Verilog-A 新建/修改
  → P10 config/symbol/DSPF
  → P11 删除
```

Goal 模式只在读、仿真、修改和新建各有真实闭环，并且已经人工验证过多步设计流程后再规划。
