import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJsonArtifact } from "../../../src/index.ts";

describe("JSON artifact writer", () => {
	it("writes safe, unique JSON artifacts", async () => {
		const directory = await mkdtemp(join(tmpdir(), "virtuoso-agent-artifact-"));
		const value = { target: "ota", instances: ["M0"] };

		const first = await writeJsonArtifact({
			directory,
			kind: "test-json",
			name: "../unsafe schematic",
			value,
		});
		const second = await writeJsonArtifact({
			directory,
			kind: "test-json",
			name: "../unsafe schematic",
			value,
		});

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(first.value.path).not.toBe(second.value.path);
			expect(first.value.path).toMatch(/\/unsafe_schematic-\d+T\d+\.\d+Z-[0-9a-f-]+\.json$/);
			expect(first.value).toMatchObject({ kind: "test-json", format: "json" });
			expect(JSON.parse(await readFile(first.value.path, "utf8"))).toEqual(value);
		}
	});

	it("returns a bounded error without embedding artifact contents", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-artifact-error-"));
		const blockingFile = join(workDir, "not-a-directory");
		await writeFile(blockingFile, "blocking file", "utf8");
		const secret = "raw-manifest-must-not-appear";

		const result = await writeJsonArtifact({
			directory: join(blockingFile, "inspect"),
			kind: "test-json",
			name: "maestro",
			value: { secret },
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("artifact_write_error");
			expect(result.error.stage).toBe("artifact_write");
			expect(JSON.stringify(result.error)).not.toContain(secret);
		}
	});
});
