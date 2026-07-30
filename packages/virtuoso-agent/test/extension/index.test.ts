import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import virtuosoExtension from "../../src/extension/index.ts";

const runtimeMocks = vi.hoisted(() => ({
	exportManagedMaestroBundle: vi.fn(),
	exportManagedSchematicBundle: vi.fn(),
	getManagedCurrentCellView: vi.fn(),
	getManagedVirtuosoInstances: vi.fn(),
	listManagedVirtuosoLibraries: vi.fn(),
	listManagedVirtuosoLibraryCellViews: vi.fn(),
	modifyManagedVirtuoso: vi.fn(),
	showManagedVirtuosoCellView: vi.fn(),
	startVirtuosoUiSession: vi.fn(),
}));

vi.mock("../../src/index.ts", () => ({
	compactAgentOutput(value: unknown) {
		return value;
	},
	...runtimeMocks,
}));

interface CapturedTool {
	name: string;
	parameters: unknown;
	execute(toolCallId: string, params: Record<string, unknown>): Promise<unknown>;
}

describe("virtuoso-agent pi extension", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("registers the consolidated six-tool interface", () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;

		virtuosoExtension(pi);

		expect(tools.map((tool) => tool.name)).toEqual([
			"virtuoso_instances",
			"virtuoso_instance_launch",
			"virtuoso_inventory",
			"virtuoso_cellview",
			"virtuoso_export",
			"virtuoso_modify",
		]);
		expect(tools.every((tool) => (tool.parameters as { type?: string }).type === "object")).toBe(true);
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_use_instance");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_get_current_cellview");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_show_cellview");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_task");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_task_validate");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_run_task");
	});

	it("uses explicit action schemas for merged tools", () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;

		virtuosoExtension(pi);

		const inventoryParameters = tools.find((tool) => tool.name === "virtuoso_inventory")?.parameters as {
			type?: string;
		};
		const cellViewParameters = tools.find((tool) => tool.name === "virtuoso_cellview")?.parameters as {
			type?: string;
		};
		const exportParameters = tools.find((tool) => tool.name === "virtuoso_export")?.parameters as {
			type?: string;
		};
		const modifyParameters = tools.find((tool) => tool.name === "virtuoso_modify")?.parameters as {
			type?: string;
		};
		expect(inventoryParameters.type).toBe("object");
		expect(cellViewParameters.type).toBe("object");
		expect(exportParameters.type).toBe("object");
		expect(modifyParameters.type).toBe("object");
		const inventorySchema = JSON.stringify(inventoryParameters);
		const cellViewSchema = JSON.stringify(cellViewParameters);
		const exportSchema = JSON.stringify(exportParameters);
		const modifySchema = JSON.stringify(modifyParameters);
		expect(inventorySchema).toContain('"const":"libraries"');
		expect(inventorySchema).toContain('"const":"cellviews"');
		expect(cellViewSchema).toContain('"const":"current"');
		expect(cellViewSchema).toContain('"const":"show"');
		expect(exportSchema).toContain('"const":"schematic"');
		expect(exportSchema).toContain('"const":"maestro"');
		expect(exportSchema).toContain('"const":"all"');
		expect(exportSchema).toContain('"const":"top"');
		expect(exportSchema).toContain('"const":"tests"');
		expect(exportSchema).toContain('"const":"test"');
		expect(exportSchema).toContain('"const":"definitions"');
		expect(exportSchema).toContain('"const":"results"');
		expect(exportSchema).toContain('"const":"top-level"');
		expect(exportSchema).toContain('"const":"spectre"');
		expect(modifySchema).toContain('"const":"validate"');
		expect(modifySchema).toContain('"const":"dry-run"');
		expect(modifySchema).toContain('"const":"apply"');
	});

	it("automatically binds the instance used by a successful business operation", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.listManagedVirtuosoLibraries.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-selected" },
				summary: { counts: { libraries: 1, cells: 2, views: 3 }, libraries: [] },
				artifact: { path: "/tmp/libraries.json" },
			},
		});
		runtimeMocks.getManagedCurrentCellView.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-selected" },
				value: { library: "amp", cell: "tb", view: "schematic" },
			},
		});

		await tools
			.find((tool) => tool.name === "virtuoso_inventory")
			?.execute("inventory-call", { action: "libraries", instanceId: "vui-selected" });
		await tools.find((tool) => tool.name === "virtuoso_cellview")?.execute("cellview-call", { action: "current" });

		expect(runtimeMocks.getManagedCurrentCellView).toHaveBeenCalledWith(
			expect.objectContaining({ instanceId: "vui-selected" }),
		);
	});

	it("renders a Maestro bundle export result", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.exportManagedMaestroBundle.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-maestro" },
				bundleDirectory: "/tmp/maestro-bundle",
				manifest: { path: "/tmp/maestro-bundle/bundle.json" },
			},
		});

		const output = (await tools
			.find((tool) => tool.name === "virtuoso_export")
			?.execute("maestro-call", {
				action: "maestro",
				library: "ota_lib",
				cell: "ota_tb",
				view: "maestro",
				scope: "test",
				testName: "stb_test",
				outputs: "all",
				historyName: "Interactive.7",
				schematicInstances: "top-level",
				outputTestName: "stb_test",
			})) as { content: Array<{ text: string }> };

		expect(output.content[0].text).toBe(
			"Maestro simulation bundle exported without running simulation: /tmp/maestro-bundle. Manifest: /tmp/maestro-bundle/bundle.json",
		);
		expect(runtimeMocks.exportManagedMaestroBundle).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "test",
				testName: "stb_test",
				outputs: "all",
				historyName: "Interactive.7",
				schematicInstances: "top-level",
				outputTestName: "stb_test",
			}),
		);
	});

	it("renders a schematic bundle export result", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.exportManagedSchematicBundle.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-schematic" },
				bundleDirectory: "/tmp/schematic-bundle",
				manifest: { path: "/tmp/schematic-bundle/bundle.json" },
			},
		});

		const output = (await tools
			.find((tool) => tool.name === "virtuoso_export")
			?.execute("schematic-call", {
				action: "schematic",
				library: "ota_lib",
				cell: "ota_core",
				view: "schematic",
				netlist: "none",
				schematicInstances: "top-level",
			})) as { content: Array<{ text: string }> };

		expect(output.content[0].text).toBe(
			"Schematic simulation bundle exported without running simulation: /tmp/schematic-bundle. Manifest: /tmp/schematic-bundle/bundle.json",
		);
		expect(runtimeMocks.exportManagedSchematicBundle).toHaveBeenCalledWith(
			expect.objectContaining({ netlist: "none", schematicInstances: "top-level" }),
		);
	});

	it("applies a JSON modification plan and binds the managed instance", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.modifyManagedVirtuoso.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-modify" },
				validation: { operationCount: 3 },
				reportPath: "/tmp/modifications/workflow/steps/001/report.json",
			},
		});

		const output = (await tools
			.find((tool) => tool.name === "virtuoso_modify")
			?.execute("modify-call", {
				planPath: "/tmp/plan.json",
				mode: "apply",
				instanceId: "vui-modify",
			})) as { content: Array<{ text: string }> };

		expect(output.content[0].text).toContain("Applied 3 Virtuoso modification operation(s)");
		expect(runtimeMocks.modifyManagedVirtuoso).toHaveBeenCalledWith(
			expect.objectContaining({
				planPath: "/tmp/plan.json",
				mode: "apply",
				instanceId: "vui-modify",
			}),
		);
	});
});
