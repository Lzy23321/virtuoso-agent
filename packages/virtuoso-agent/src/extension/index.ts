#!/usr/bin/env node

import { resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	compactAgentOutput,
	getManagedCurrentCellView,
	getManagedVirtuosoInstances,
	inspectManagedVirtuosoMaestro,
	inspectManagedVirtuosoSchematic,
	listManagedVirtuosoLibraries,
	listManagedVirtuosoLibraryCellViews,
	runTask,
	showManagedVirtuosoCellView,
	startVirtuosoUiSession,
	validateTaskFile,
} from "../index.ts";

const managedInstanceParameters = {
	instanceId: Type.Optional(
		Type.String({
			description: "Managed instance ID. A successful explicit selection becomes this pi session's binding.",
		}),
	),
	cdsLib: Type.Optional(
		Type.String({ description: "Optional cds.lib path used to select one matching managed instance." }),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Operation timeout in milliseconds." })),
};

export default function (pi: ExtensionAPI) {
	let boundInstanceId: string | undefined;

	const instancesTool = defineTool({
		name: "virtuoso_instances",
		label: "Managed Virtuoso Instances",
		description: "List live bridge-managed Virtuoso instances and the instance bound to this pi session.",
		parameters: Type.Object({}),
		async execute() {
			const result = await getManagedVirtuosoInstances();
			if (
				result.ok &&
				boundInstanceId &&
				!result.value.some((instance) => instance.instanceId === boundInstanceId)
			) {
				boundInstanceId = undefined;
			}
			const text = result.ok
				? result.value.length === 0
					? "No live virtuoso-agent managed instances are registered."
					: `Found ${result.value.length} live managed Virtuoso instance(s): ${result.value
							.map((instance) => `${instance.instanceId} (${instance.cdsLib ?? instance.cwd})`)
							.join(", ")}. Bound instance: ${boundInstanceId ?? "none"}.`
				: result.error.message;
			const details = result.ok ? { ok: true, value: { boundInstanceId, instances: result.value } } : result;
			return { content: [{ type: "text", text }], details: compactAgentOutput(details) };
		},
	});

	const launchInstanceTool = defineTool({
		name: "virtuoso_instance_launch",
		label: "Launch Managed Virtuoso Instance",
		description:
			"Explicitly launch one visible Virtuoso instance with the bridge, wait for readiness, and bind this pi session to it. Do not call without user authorization when no instance exists.",
		parameters: Type.Object({
			cdsLib: Type.String({ description: "Absolute path to cds.lib." }),
			workDir: Type.Optional(Type.String({ description: "Optional project working directory." })),
			display: Type.Optional(Type.String({ description: "X11 display such as :1; inherited when omitted." })),
			xAuthority: Type.Optional(
				Type.String({
					description: "X11 authority file matching display; inherited from XAUTHORITY when omitted.",
				}),
			),
			waylandDisplay: Type.Optional(
				Type.String({ description: "Wayland display inherited by the launched process when applicable." }),
			),
			xdgRuntimeDir: Type.Optional(
				Type.String({ description: "Desktop runtime directory; inherited from XDG_RUNTIME_DIR when omitted." }),
			),
			virtuosoBin: Type.Optional(Type.String({ description: "Optional Virtuoso executable path." })),
			readyTimeoutMs: Type.Optional(Type.Number({ description: "Bridge readiness timeout in milliseconds." })),
		}),
		async execute(_toolCallId, params) {
			const existing = await getManagedVirtuosoInstances();
			if (!existing.ok) {
				return {
					content: [{ type: "text", text: existing.error.message }],
					details: compactAgentOutput(existing) as unknown,
				};
			}
			const matches = existing.value.filter(
				(instance) =>
					instance.mode === "ui" && instance.cdsLib && resolve(instance.cdsLib) === resolve(params.cdsLib),
			);
			if (matches.length > 1) {
				return {
					content: [
						{
							type: "text",
							text: `Multiple managed Virtuoso instances already use this cds.lib: ${matches.map((item) => item.instanceId).join(", ")}. Retry the intended operation with one instanceId.`,
						},
					],
					details: compactAgentOutput({
						ok: false,
						type: "virtuoso_instance_selection_required",
						candidates: matches,
					}) as unknown,
				};
			}
			if (matches.length === 1) {
				boundInstanceId = matches[0].instanceId;
				return {
					content: [
						{
							type: "text",
							text: `Reused and bound existing managed Virtuoso instance ${matches[0].instanceId}.`,
						},
					],
					details: compactAgentOutput({ ok: true, instance: matches[0], reused: true }) as unknown,
				};
			}
			const result = await startVirtuosoUiSession(params);
			if (result.ok) {
				boundInstanceId = result.value.instanceId;
			}
			return {
				content: [
					{
						type: "text",
						text: result.ok
							? `Managed Virtuoso instance ${result.value.instanceId} is ready and bound to this pi session.`
							: result.error.message,
					},
				],
				details: compactAgentOutput(result) as unknown,
			};
		},
	});

	const inventoryTool = defineTool({
		name: "virtuoso_inventory",
		label: "Inspect Virtuoso Inventory",
		description:
			"List library summaries or the cells and views in one library through a live managed instance. Use only when discovery is needed.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("libraries"), Type.Literal("cellviews")]),
			library: Type.Optional(Type.String({ description: "Required when action is cellviews." })),
			...managedInstanceParameters,
		}),
		async execute(_toolCallId, params) {
			if (params.action === "libraries") {
				const result = await listManagedVirtuosoLibraries({
					...params,
					instanceId: params.instanceId ?? boundInstanceId,
				});
				if (result.ok) {
					boundInstanceId = result.value.instance.instanceId;
				}
				const text = result.ok
					? `Inventory libraries saved: ${result.value.summary.counts.libraries} libraries, ${result.value.summary.counts.cells} cells, ${result.value.summary.counts.views} views. Artifact: ${result.value.artifact.path}`
					: result.error.message;
				return { content: [{ type: "text", text }], details: compactAgentOutput(result) as unknown };
			}

			if (!params.library) {
				return invalidToolInput("library is required when virtuoso_inventory action is cellviews");
			}
			const result = await listManagedVirtuosoLibraryCellViews({
				library: params.library,
				instanceId: params.instanceId ?? boundInstanceId,
				cdsLib: params.cdsLib,
				timeoutMs: params.timeoutMs,
			});
			if (result.ok) {
				boundInstanceId = result.value.instance.instanceId;
			}
			const text = result.ok
				? `Inventory cellviews saved: ${result.value.summary.library.name}, ${result.value.summary.library.counts.cells} cells, ${result.value.summary.library.counts.views} views. Artifact: ${result.value.artifact.path}`
				: result.error.message;
			return { content: [{ type: "text", text }], details: compactAgentOutput(result) as unknown };
		},
	});

	const cellViewTool = defineTool({
		name: "virtuoso_cellview",
		label: "Operate on Virtuoso CellView",
		description:
			"Read the active cellView or show a specified cellView in a live managed Virtuoso UI. Never starts a new process.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("current"), Type.Literal("show")]),
			library: Type.Optional(Type.String({ description: "Required when action is show." })),
			cell: Type.Optional(Type.String({ description: "Required when action is show." })),
			view: Type.Optional(Type.String({ description: "Required when action is show." })),
			mode: Type.Optional(Type.Union([Type.Literal("r"), Type.Literal("a"), Type.Literal("w")])),
			...managedInstanceParameters,
		}),
		async execute(_toolCallId, params) {
			if (params.action === "current") {
				const result = await getManagedCurrentCellView({
					...params,
					instanceId: params.instanceId ?? boundInstanceId,
				});
				if (result.ok) {
					boundInstanceId = result.value.instance.instanceId;
				}
				return {
					content: [
						{
							type: "text",
							text: result.ok
								? `Current cellView: ${result.value.value.library}/${result.value.value.cell}/${result.value.value.view}.`
								: result.error.message,
						},
					],
					details: compactAgentOutput(result) as unknown,
				};
			}

			if (!params.library || !params.cell || !params.view) {
				return invalidToolInput("library, cell, and view are required when virtuoso_cellview action is show");
			}
			const result = await showManagedVirtuosoCellView({
				library: params.library,
				cell: params.cell,
				view: params.view,
				mode: params.mode,
				instanceId: params.instanceId ?? boundInstanceId,
				cdsLib: params.cdsLib,
				timeoutMs: params.timeoutMs,
			});
			if (result.ok) {
				boundInstanceId = result.value.instance.instanceId;
			}
			return {
				content: [
					{
						type: "text",
						text: result.ok
							? `Displayed ${params.library}/${params.cell}/${params.view} in managed instance ${result.value.instance.instanceId}.`
							: result.error.message,
					},
				],
				details: compactAgentOutput(result) as unknown,
			};
		},
	});

	const inspectTool = defineTool({
		name: "virtuoso_inspect",
		label: "Inspect Virtuoso Design Data",
		description:
			"Inspect one schematic or Maestro setup through a live managed Virtuoso instance and save the manifest.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("schematic"), Type.Literal("maestro")]),
			library: Type.String(),
			cell: Type.String(),
			view: Type.String(),
			...managedInstanceParameters,
		}),
		async execute(_toolCallId, params) {
			const request = {
				...params,
				instanceId: params.instanceId ?? boundInstanceId,
			};
			if (params.action === "schematic") {
				const result = await inspectManagedVirtuosoSchematic(request);
				if (result.ok) {
					boundInstanceId = result.value.instance.instanceId;
				}
				const text = result.ok
					? `Schematic inspect saved: ${result.value.target.library}/${result.value.target.cell}/${result.value.target.view}, ${result.value.summary.counts.instances} instances, ${result.value.summary.counts.nets} nets, ${result.value.summary.counts.unconnectedEndpoints} unconnected endpoints. Manifest: ${result.value.artifacts[0].path}. Topology: ${result.value.artifacts[1].path}`
					: result.error.message;
				return { content: [{ type: "text", text }], details: compactAgentOutput(result) as unknown };
			}

			const result = await inspectManagedVirtuosoMaestro(request);
			if (result.ok) {
				boundInstanceId = result.value.instance.instanceId;
			}
			const text = result.ok
				? `Maestro inspect saved: ${result.value.target.library}/${result.value.target.cell}/${result.value.target.view}, ${result.value.summary.counts.tests} tests, ${result.value.summary.counts.analysisEntries} analyses, ${result.value.summary.counts.outputs} outputs. Artifact: ${result.value.artifacts[0].path}`
				: result.error.message;
			return { content: [{ type: "text", text }], details: compactAgentOutput(result) as unknown };
		},
	});

	const taskTool = defineTool({
		name: "virtuoso_task",
		label: "Validate or Run Virtuoso Task",
		description: "Validate a Virtuoso task file or run its workflow and return metrics, proposal, and artifacts.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("validate"), Type.Literal("run")]),
			path: Type.String(),
		}),
		async execute(_toolCallId, params) {
			if (params.action === "validate") {
				const result = await validateTaskFile(params.path);
				return {
					content: [{ type: "text", text: result.ok ? "Task validation finished." : result.error.message }],
					details: compactAgentOutput(result) as unknown,
				};
			}
			const result = await runTask(params.path);
			return {
				content: [
					{ type: "text", text: result.ok ? `Task finished: ${result.value.jobId}` : result.error.message },
				],
				details: compactAgentOutput(result) as unknown,
			};
		},
	});

	pi.registerTool(instancesTool);
	pi.registerTool(launchInstanceTool);
	pi.registerTool(inventoryTool);
	pi.registerTool(cellViewTool);
	pi.registerTool(inspectTool);
	pi.registerTool(taskTool);
}

function invalidToolInput(message: string) {
	return {
		content: [{ type: "text" as const, text: `Invalid tool input: ${message}.` }],
		details: { ok: false, type: "virtuoso_tool_input_error", message },
	};
}
