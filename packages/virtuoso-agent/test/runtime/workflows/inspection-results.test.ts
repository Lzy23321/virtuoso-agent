import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { finalizeSchematicInspection } from "../../../src/index.ts";

function createSchematicManifest(): Record<string, unknown> {
	return {
		schemaVersion: "0.1",
		kind: "schematic-inspect",
		generatedAt: "Cadence time",
		target: { library: "ota_lib", cell: "ota_core", view: "schematic" },
		source: { openMode: "r", virtuosoVersion: "IC25.1" },
		connectivity: { status: "clean" },
		summary: {},
		instances: [
			{
				name: "M0",
				master: { library: "gpdk", cell: "nmos", view: "symbol" },
				placement: { x: 0, y: 0, orientation: "R0" },
				parameters: { w: "2u" },
			},
		],
		terminals: [],
		nets: [],
		connections: [],
		references: [],
		warnings: [],
	};
}

describe("shared Virtuoso inspection results", () => {
	it("finalizes identical transport manifests with the same business result", async () => {
		const managedDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-managed-result-"));
		const oneShotDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-oneshot-result-"));
		const target = { library: "ota_lib", cell: "ota_core", view: "schematic" };

		const managed = await finalizeSchematicInspection({
			raw: createSchematicManifest(),
			target,
			artifactContext: { cwd: managedDir },
		});
		const oneShot = await finalizeSchematicInspection({
			raw: createSchematicManifest(),
			target,
			artifactContext: { cwd: oneShotDir },
		});

		expect(managed.ok).toBe(true);
		expect(oneShot.ok).toBe(true);
		if (managed.ok && oneShot.ok) {
			expect({
				target: managed.value.target,
				summary: managed.value.summary,
				warnings: managed.value.warnings,
				artifactKinds: managed.value.artifacts.map((artifact) => artifact.kind),
			}).toEqual({
				target: oneShot.value.target,
				summary: oneShot.value.summary,
				warnings: oneShot.value.warnings,
				artifactKinds: oneShot.value.artifacts.map((artifact) => artifact.kind),
			});
			expect(managed.value.artifacts).toHaveLength(2);
			expect(await readFile(managed.value.artifacts[1].path, "utf8")).toContain(
				"* virtuoso-agent schematic topology v1",
			);
		}
	});

	it("rejects an invalid manifest before creating artifacts", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-invalid-result-"));

		const result = await finalizeSchematicInspection({
			raw: { kind: "schematic-inspect", instances: "invalid" },
			target: { library: "ota_lib", cell: "ota_core", view: "schematic" },
			artifactContext: { cwd: workDir },
		});

		expect(result.ok).toBe(false);
		await expect(readdir(join(workDir, ".virtuoso-agent", "inspect"))).rejects.toThrow();
	});
});
