import { describe, expect, it } from "vitest";
import { compactAgentOutput, type ProcessRunResult } from "../../../src/index.ts";

function createProcessResult(stdout: string, stderr: string): ProcessRunResult {
	return {
		command: ["virtuoso", "-nograph"],
		cwd: "/tmp/job",
		exitCode: 0,
		stdout,
		stderr,
		startedAt: "2026-07-18T00:00:00.000Z",
		endedAt: "2026-07-18T00:00:01.000Z",
		dryRun: false,
	};
}

describe("compact agent output", () => {
	it("omits process stdout and stderr by default", () => {
		const result = {
			ok: true,
			value: {
				process: createProcessResult("long stdout\n".repeat(100), "stderr text"),
			},
		};

		const compact = compactAgentOutput(result);

		expect(compact).toEqual({
			ok: true,
			value: {
				process: {
					command: ["virtuoso", "-nograph"],
					cwd: "/tmp/job",
					exitCode: 0,
					startedAt: "2026-07-18T00:00:00.000Z",
					endedAt: "2026-07-18T00:00:01.000Z",
					dryRun: false,
					processOutput: {
						omitted: true,
						stdoutBytes: Buffer.byteLength("long stdout\n".repeat(100), "utf8"),
						stderrBytes: Buffer.byteLength("stderr text", "utf8"),
					},
				},
			},
		});
	});

	it("preserves process stdout and stderr when explicitly requested", () => {
		const result = {
			ok: true,
			value: {
				process: createProcessResult("stdout text", "stderr text"),
			},
		};

		const compact = compactAgentOutput(result, { includeProcessOutput: true });

		expect(compact.value.process.stdout).toBe("stdout text");
		expect(compact.value.process.stderr).toBe("stderr text");
		expect(compact.value.process).not.toHaveProperty("processOutput");
	});

	it("keeps short artifact paths intact", () => {
		const result = {
			ok: true,
			value: {
				artifacts: {
					stdout: "/tmp/job/stdout.log",
					stderr: "/tmp/job/stderr.log",
				},
			},
		};

		expect(compactAgentOutput(result)).toEqual(result);
	});
});
