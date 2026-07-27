import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("simulation export SKILL contract", () => {
	it("uses Cadence-native netlist and OCEAN export APIs without running simulation", async () => {
		const path = fileURLToPath(new URL("../../skill-runtime/simulation-export.il", import.meta.url));
		const source = await readFile(path, "utf8");

		expect(source).toContain("createNetlist(?recreateAll t ?display nil)");
		expect(source).toContain('?application "Assembler"');
		expect(source).toContain("axlWriteOceanScriptLCV");
		expect(source).toContain("existingSessions = maeGetSessions()");
		expect(source).toContain("maeGetTestSession");
		expect(source).toContain("asiGetDesignLibName(testSession)");
		expect(source).toContain("asiGetDesignCellName(testSession)");
		expect(source).toContain("asiGetDesignViewName(testSession)");
		expect(source).toContain("netlistResult = asiNetlist(testSession)");
		expect(source).toContain("netlistDir = asiGetNetlistDir(testSession)");
		expect(source).toContain("simInputFile = asiGetSimInputFileName(testSession)");
		expect(source).toContain("when(closeSession");
		expect(source).not.toContain("?noRun");
		expect(source).not.toContain("vaSessionCreateNetlistFromOcean");
		expect(source).not.toMatch(/^\s*run\(\)/m);
	});
});
