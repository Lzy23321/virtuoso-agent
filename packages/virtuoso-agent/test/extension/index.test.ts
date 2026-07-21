import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import virtuosoExtension from "../../src/extension/index.ts";

const runtimeMocks = vi.hoisted(() => ({
	getManagedCurrentCellView: vi.fn(),
	getManagedVirtuosoInstances: vi.fn(),
	inspectManagedVirtuosoMaestro: vi.fn(),
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
			"virtuoso_inspect_maestro",
			"virtuoso_task",
		]);
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

		const inventorySchema = JSON.stringify(tools.find((tool) => tool.name === "virtuoso_inventory")?.parameters);
		const cellViewSchema = JSON.stringify(tools.find((tool) => tool.name === "virtuoso_cellview")?.parameters);
		const taskSchema = JSON.stringify(tools.find((tool) => tool.name === "virtuoso_task")?.parameters);
		expect(inventorySchema).toContain('"const":"libraries"');
		expect(inventorySchema).toContain('"const":"cellviews"');
		expect(cellViewSchema).toContain('"const":"current"');
		expect(cellViewSchema).toContain('"const":"show"');
		expect(taskSchema).toContain('"const":"validate"');
		expect(taskSchema).toContain('"const":"run"');
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
});
