import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { runTask, validateTaskFile, validateTaskObject } from "../../src/index.ts";

describe("task schema scaffold", () => {
	it("accepts a minimal fake task object", () => {
		const result = validateTaskObject({
			name: "frontend-demo",
			simulation: { backend: "fake" },
			outputs: [{ name: "gain", target: ">= 0.9" }],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toEqual([]);
			expect(result.value.task.name).toBe("frontend-demo");
		}
	});

	it("reports missing task names as validation issues", () => {
		const result = validateTaskObject({
			simulation: { backend: "fake" },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toEqual([{ path: "name", message: "Task name is required." }]);
		}
	});

	it("validates and runs a fake task file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "virtuoso-agent-"));
		const taskPath = join(dir, "task.json");
		await writeFile(
			taskPath,
			JSON.stringify({
				name: "frontend-demo",
				simulation: { backend: "fake" },
				outputs: [{ name: "gain" }],
			}),
			"utf8",
		);

		const validation = await validateTaskFile(taskPath);
		expect(validation.ok).toBe(true);

		const run = await runTask(taskPath);
		expect(run.ok).toBe(true);
		if (run.ok) {
			expect(run.value.metrics.gain).toBe(0.92);
		}
	});
});
