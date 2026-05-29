import { describe, expect, it } from "vitest";
import { type ProcessExecutor, runSpectreNetlist } from "../../../../src/index.ts";

describe("spectre runner", () => {
	it("builds a dry-run spectre command without executing a process", async () => {
		let executorCalled = false;
		const executor: ProcessExecutor = {
			async run() {
				executorCalled = true;
				throw new Error("executor should not run");
			},
		};

		const result = await runSpectreNetlist({
			netlistPath: "input.scs",
			workDir: "/tmp/job",
			dryRun: true,
			executor,
		});

		expect(result.ok).toBe(true);
		expect(executorCalled).toBe(false);
		if (result.ok) {
			expect(result.value.backend).toBe("spectre");
			expect(result.value.process.command).toEqual([
				"spectre",
				"-64",
				"input.scs",
				"+escchars",
				"+mt",
				"+logstatus",
			]);
			expect(result.value.process.cwd).toBe("/tmp/job");
			expect(result.value.process.dryRun).toBe(true);
		}
	});

	it("passes spectre command details to the executor", async () => {
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: "spectre done",
					stderr: "",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runSpectreNetlist({
			spectreBin: "/cad/bin/spectre",
			netlistPath: "input.scs",
			workDir: "/tmp/job",
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.process.command).toEqual([
				"/cad/bin/spectre",
				"-64",
				"input.scs",
				"+escchars",
				"+mt",
				"+logstatus",
			]);
			expect(result.value.process.stdout).toBe("spectre done");
			expect(result.value.process.dryRun).toBe(false);
		}
	});

	it("returns a runtime failure when spectre exits with a non-zero code", async () => {
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 1,
					stdout: "",
					stderr: "syntax error",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runSpectreNetlist({
			netlistPath: "input.scs",
			workDir: "/tmp/job",
			executor,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("spectre_process_error");
			expect(result.error.stage).toBe("spectre_run");
			expect(result.error.details?.process).toMatchObject({
				command: ["spectre", "-64", "input.scs", "+escchars", "+mt", "+logstatus"],
				exitCode: 1,
				stderr: "syntax error",
			});
		}
	});
});
