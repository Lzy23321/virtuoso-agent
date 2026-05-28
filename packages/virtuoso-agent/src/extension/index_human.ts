/**
 * Human exercise file for the pi extension entry point.
 *
 * You will create `src/extension/index.ts` next to this file and copy the structure by hand.
 * This file shows how pi calls our package: pi owns the agent loop, and this extension
 * only registers Virtuoso tools that delegate into `src/runtime`.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getVirtuosoStatus, runTask, validateTaskFile } from "../index.ts";

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

export default function (pi: ExtensionAPI) {
	// Registering a tool makes it visible to the LLM. The model can then call it
	// just like built-in tools such as read/bash/edit/write.
	pi.registerTool(statusTool);
	pi.registerTool(taskValidateTool);
	pi.registerTool(runTaskTool);

	// This is where Virtuoso-specific permission rules will live.
	// The scaffold only shows the hook shape. Later, write operations and raw SKILL
	// eval should require confirmation here before the tool executes.
	pi.on("tool_call", async (event, _ctx) => {
		if (!event.toolName.startsWith("virtuoso_")) {
			return undefined;
		}
		return undefined;
	});
}
