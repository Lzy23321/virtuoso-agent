import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("simulation V1 SKILL contracts", () => {
	it("runs an exact test, publishes history before waiting, and always restores enabled tests", async () => {
		const path = fileURLToPath(new URL("../../skill-runtime/simulation-run.il", import.meta.url));
		const source = await readFile(path, "utf8");

		expect(source).toContain('member(selectionLevel list("test" "maestro"))');
		expect(source).toContain("maeEnableTests(?all t ?enable nil ?session session)");
		expect(source).toContain("maeEnableTests(?testNames selectedTests ?enable t ?session session)");
		expect(source).toContain("historyName = maeRunSimulation(?session session)");
		expect(source).toContain("axlGetHistoryEntry(setupDatabase historyName)");
		expect(source).toContain("axlGetHistoryResultsDir(historyEntry)");
		expect(source).toContain("vaSessionWriteResult(progressPath vaOkEnvelope(progressData))");
		expect(source).toContain("waitCaptured = errset(maeWaitUntilDone(list(historyName)) t)");
		expect(source).toContain("maeWaitUntilDone(list(historyName))");
		expect(source).toContain("procedure(vaSimulationRunStatusV1");
		expect(source).toContain("axlGetRunStatus(session ?historyName historyName)");
		expect(source).toContain("unwindProtect(");
		expect(source).toContain("vaSimulationRunRestoreTests(session enabledTests)");
		expect(source).not.toContain("evalstring");
	});

	it("exports only the exact recorded history to a Detail CSV", async () => {
		const path = fileURLToPath(new URL("../../skill-runtime/metric-extract.il", import.meta.url));
		const source = await readFile(path, "utf8");

		expect(source).toContain("axlGetHistoryEntry(setupDatabase historyName)");
		expect(source).toContain("maeExportOutputView(");
		expect(source).toContain('?view "Detail"');
		expect(source).toContain("?historyName historyName");
		expect(source).not.toContain("evalstring");
	});
});
