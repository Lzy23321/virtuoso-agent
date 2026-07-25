import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import virtuosoExtension from "../../src/extension/index.ts";

const runtimeMocks = vi.hoisted(() => ({
	getManagedCurrentCellView: vi.fn(),
	getManagedVirtuosoInstances: vi.fn(),
	inspectManagedVirtuosoMaestro: vi.fn(),
	inspectManagedVirtuosoSchematic: vi.fn(),
	listManagedVirtuosoLibraries: vi.fn(),
	listManagedVirtuosoLibraryCellViews: vi.fn(),
	runTask: vi.fn(),
	showManagedVirtuosoCellView: vi.fn(),
	startVirtuosoUiSession: vi.fn(),
	validateTaskFile: vi.fn(),
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
			"virtuoso_inspect",
			"virtuoso_task",
		]);
		expect(tools.every((tool) => (tool.parameters as { type?: string }).type === "object")).toBe(true);
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_use_instance");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_get_current_cellview");
		expect(tools.map((tool) => tool.name)).not.toContain("virtuoso_show_cellview");
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
		const taskParameters = tools.find((tool) => tool.name === "virtuoso_task")?.parameters as { type?: string };
		const inspectParameters = tools.find((tool) => tool.name === "virtuoso_inspect")?.parameters as {
			type?: string;
		};
		expect(inventoryParameters.type).toBe("object");
		expect(cellViewParameters.type).toBe("object");
		expect(taskParameters.type).toBe("object");
		expect(inspectParameters.type).toBe("object");
		const inventorySchema = JSON.stringify(inventoryParameters);
		const cellViewSchema = JSON.stringify(cellViewParameters);
		const taskSchema = JSON.stringify(taskParameters);
		const inspectSchema = JSON.stringify(inspectParameters);
		expect(inventorySchema).toContain('"const":"libraries"');
		expect(inventorySchema).toContain('"const":"cellviews"');
		expect(cellViewSchema).toContain('"const":"current"');
		expect(cellViewSchema).toContain('"const":"show"');
		expect(taskSchema).toContain('"const":"validate"');
		expect(taskSchema).toContain('"const":"run"');
		expect(inspectSchema).toContain('"const":"schematic"');
		expect(inspectSchema).toContain('"const":"maestro"');
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

	it("renders a Maestro inspection from the shared inspection result", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.inspectManagedVirtuosoMaestro.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-maestro" },
				target: { library: "ota_lib", cell: "ota_tb", view: "maestro" },
				summary: { counts: { tests: 2, analysisEntries: 3, outputs: 4 } },
				artifacts: [{ path: "/tmp/maestro.json" }],
				warnings: [],
			},
		});

		const output = (await tools
			.find((tool) => tool.name === "virtuoso_inspect")
			?.execute("maestro-call", {
				action: "maestro",
				library: "ota_lib",
				cell: "ota_tb",
				view: "maestro",
			})) as { content: Array<{ text: string }> };

		expect(output.content[0].text).toBe(
			"Maestro inspect saved: ota_lib/ota_tb/maestro, 2 tests, 3 analyses, 4 outputs. Artifact: /tmp/maestro.json",
		);
	});

	it("renders a schematic inspection from the shared inspection result", async () => {
		const tools: CapturedTool[] = [];
		const pi = {
			registerTool(tool: unknown) {
				tools.push(tool as CapturedTool);
			},
		} as unknown as ExtensionAPI;
		virtuosoExtension(pi);
		runtimeMocks.inspectManagedVirtuosoSchematic.mockResolvedValue({
			ok: true,
			value: {
				instance: { instanceId: "vui-schematic" },
				target: { library: "ota_lib", cell: "ota_core", view: "schematic" },
				summary: { counts: { instances: 8, nets: 6, unconnectedEndpoints: 1 } },
				artifacts: [{ path: "/tmp/schematic.json" }, { path: "/tmp/schematic-topology.net" }],
				warnings: [],
			},
		});

		const output = (await tools
			.find((tool) => tool.name === "virtuoso_inspect")
			?.execute("schematic-call", {
				action: "schematic",
				library: "ota_lib",
				cell: "ota_core",
				view: "schematic",
			})) as { content: Array<{ text: string }> };

		expect(output.content[0].text).toBe(
			"Schematic inspect saved: ota_lib/ota_core/schematic, 8 instances, 6 nets, 1 unconnected endpoints. Manifest: /tmp/schematic.json. Topology: /tmp/schematic-topology.net",
		);
	});
});
