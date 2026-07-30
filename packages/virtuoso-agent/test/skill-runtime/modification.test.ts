import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("modification SKILL contract", () => {
	it("uses CDF-aware schematic updates and public Maestro APIs", async () => {
		const path = fileURLToPath(new URL("../../skill-runtime/modification.il", import.meta.url));
		const source = await readFile(path, "utf8");

		expect(source).toContain("cdfGetInstCDF(instance)");
		expect(source).toContain("parameterData~>value = cadr(parameter)");
		expect(source).toContain("callbackResult = errsetstring(callback t)");
		expect(source).toContain("schematicCheck = schCheck(cellView)");
		expect(source).toContain("schematicSaved = dbSave(cellView)");
		expect(source).toContain("maeSetAnalysis(");
		expect(source).toContain('?enable action == "add"');
		expect(source).toContain("maeAddOutput(");
		expect(source).toContain("maeDeleteOutput(outputName testName ?session session)");
		expect(source).toContain("maestroSaved = maeSaveSetup(?session session)");
		expect(source).toContain("geRefreshWindow(schematicWindow)");
		expect(source).not.toContain("evalstring");
		expect(source).not.toContain("dbCreateInst");
		expect(source).not.toContain("schCreateWire");
	});
});
