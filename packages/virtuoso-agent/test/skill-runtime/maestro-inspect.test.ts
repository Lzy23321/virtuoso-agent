import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDefaultVirtuosoBridgePath } from "../../src/index.ts";

describe("Maestro inspection SKILL", () => {
	it("enumerates configured analyses and preserves their enabled state", async () => {
		const source = await readFile(join(dirname(getDefaultVirtuosoBridgePath()), "maestro-inspect.il"), "utf8");

		expect(source).toContain("asiGetAnalysisNameList(testSession)");
		expect(source).toContain('?option "anaName"');
		expect(source).toContain("vaMaestroConfiguredAnalysisNames(session testName testSession)");
		expect(source).toContain("vaMaestroJsonBoolean(vaMaestroAnalysisNameMember(analysisName enabledAnalyses))");
		expect(source).not.toContain('"{\\"type\\":%s,\\"enabled\\":true,\\"effectiveSettings\\":%s}"');
	});
});
