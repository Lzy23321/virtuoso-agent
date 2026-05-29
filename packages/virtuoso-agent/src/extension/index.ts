#!/usr/bin/env node
/**
 * main.ts 文件是给终端用的，而这个文件是给 pi agent 用的，
 * 目的是将 Virtuoso 工具注册到 pi agent 中，使得 LLM
 * 可以调用这些工具来检查状态、验证任务文件和运行任务。
 * 终端cli使用命令行调用，是main.ts的职责范围，而pi agent 调用工具是这个文件的职责范围。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getVirtuosoStatus, runTask, validateTaskFile } from "../index.ts";

/**
 * 这个文件只注册委托到 `src/runtime` 的 Virtuoso 工具。
 * 任何直接连接到 Virtuoso、解析 Spectre 日志或实现优化逻辑的工具都不应该在这里注册。
 * 这些都属于 `src/runtime` 的职责范围。
 * 通过保持工具层的薄弱，我们可以更容易地测试和维护代码，并且在未来如果需要更改底层实现时不会影响到工具接口。
 */

// 定义一个工具来检查 Virtuoso 的状态是否正常。
const statusTool = defineTool({
	name: "virtuoso_status",
	label: "Virtuoso Status",
	description: "Check whether the Virtuoso automation runtime is available.",
	parameters: Type.Object({}),
	async execute() {
		const status = await getVirtuosoStatus();
		return {
			content: [{ type: "text", text: status.message }],
			details: status,
		};
	},
});

// 定义一个工具来验证 Virtuoso 任务文件的正确性。
const taskValidateTool = defineTool({
	name: "virtuoso_task_validate",
	label: "Validate Virtuoso Task",
	description: "Validate a Virtuoso task file without running simulation.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to a task JSON file." }),
	}),
	async execute(_toolCallId, params) {
		const result = await validateTaskFile(params.path);
		return {
			content: [{ type: "text", text: result.ok ? "Task validation finished." : result.error.message }],
			details: result,
		};
	},
});

// 运行一个 Virtuoso task 工作流，并返回指标、优化建议和产物路径。
const runTaskTool = defineTool({
	name: "virtuoso_run_task",
	label: "Run Virtuoso Task",
	description: "Run a Virtuoso task workflow and return metrics, proposal, and artifact paths.",
	parameters: Type.Object({
		path: Type.String({ description: "Path to a task JSON file." }),
	}),
	async execute(_toolCallId, params) {
		const result = await runTask(params.path);
		return {
			content: [{ type: "text", text: result.ok ? `Task finished: ${result.value.jobId}` : result.error.message }],
			details: result,
		};
	},
});

// 导出一个函数来注册工具到 pi agent 中。
export default function (pi: ExtensionAPI) {
	// 前文只是定义了工具，还没有注册到 pi agent。
	// 注册工具使其对 LLM 可见，
	// 模型就可以像调用内置工具（如 read/bash/edit/write）一样调用它。
	pi.registerTool(statusTool);
	pi.registerTool(taskValidateTool);
	pi.registerTool(runTaskTool);
	// 未来如果需要添加更多工具，只需在这里定义并注册即可。

	// 这一段是在在监听工具调用事件，每次 agent 准备调用工具时，这里都有机会拦截或加权限控制。
	pi.on("tool_call", async (event, _ctx) => {
		if (!event.toolName.startsWith("virtuoso_")) {
			return undefined; // 只处理以 "virtuoso_" 开头的工具调用，其他工具调用不受影响。
		}
		return undefined; // 目前没有特殊权限控制，直接允许调用。未来可以在这里添加权限检查逻辑。
	});
}
