import { describe, expect, it } from "vitest";
import { validateVirtuosoMaestroInspect, validateVirtuosoSchematicInspect } from "../../../src/index.ts";

function createSchematicManifest(): Record<string, unknown> {
	return {
		schemaVersion: "0.1",
		kind: "schematic-inspect",
		generatedAt: "Cadence time",
		target: { library: "ota_lib", cell: "ota_core", view: "schematic" },
		source: { openMode: "r", virtuosoVersion: "IC25.1" },
		connectivity: { status: "clean" },
		summary: {},
		instances: [],
		terminals: [],
		nets: [],
		connections: [],
		references: [],
		warnings: [],
	};
}

function createMaestroManifest(): Record<string, unknown> {
	return {
		schemaVersion: "0.1-prototype",
		kind: "maestro-inspect",
		generatedAt: "Cadence time",
		target: { library: "ota_lib", cell: "ota_tb", view: "maestro" },
		source: { openMode: "r", virtuosoVersion: "IC25.1" },
		session: {
			name: "session1",
			valid: true,
			singleTest: true,
			modified: false,
			closedAfterInspect: true,
		},
		storage: { path: null },
		summary: {
			tests: 0,
			enabledTests: 0,
			globalVariables: 0,
			testVariableEntries: 0,
			uniqueTestVariables: 0,
			parameters: { total: 0, enabled: 0, disabled: 0, withValue: 0 },
			corners: 0,
			analysisEntries: 0,
			outputs: 0,
		},
		maestro: { globalVariables: [], parameters: [] },
		tests: [],
		warnings: [],
	};
}

describe("Virtuoso inspection manifest validation", () => {
	it("accepts a minimal stable schematic manifest", () => {
		const result = validateVirtuosoSchematicInspect(createSchematicManifest(), {
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
		});

		expect(result.ok).toBe(true);
	});

	it("rejects malformed schematic arrays without returning the raw manifest", () => {
		const manifest = createSchematicManifest();
		manifest.instances = "invalid";

		const result = validateVirtuosoSchematicInspect(manifest);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("schematic_manifest_invalid");
			expect(result.error.stage).toBe("manifest_validation");
			expect(result.error.details?.issues).toContainEqual({
				path: "instances",
				message: "Expected an array.",
			});
			expect(result.error.details).not.toHaveProperty("rawManifest");
		}
	});

	it("rejects a manifest returned for a different target", () => {
		const result = validateVirtuosoSchematicInspect(createSchematicManifest(), {
			library: "ota_lib",
			cell: "different",
			view: "schematic",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.details?.issues).toContainEqual({
				path: "target",
				message: "Returned target does not match ota_lib/different/schematic.",
			});
		}
	});

	it("validates the Maestro summary shape used by agent output", () => {
		const manifest = createMaestroManifest();
		(manifest.summary as Record<string, unknown>).outputs = "one";

		const result = validateVirtuosoMaestroInspect(manifest);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("maestro_manifest_invalid");
			expect(result.error.details?.issues).toContainEqual({
				path: "summary.outputs",
				message: "Expected a finite number.",
			});
		}
	});
});
