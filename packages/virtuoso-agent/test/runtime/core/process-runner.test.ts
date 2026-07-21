import { describe, expect, it } from "vitest";
import { type ProcessExecutor, runProcess } from "../../../src/index.ts";

describe("process runner", () => {
	it("returns a dry-run result without calling the executor", async () => {
		let executorCalled = false;
		const executor: ProcessExecutor = {
			async run() {
				executorCalled = true;
				throw new Error("executor should not run");
			},
		};

		const result = await runProcess(
			{
				command: "spectre",
				args: ["input.scs"],
				cwd: "/tmp/job",
				dryRun: true,
			},
			{ executor },
		);

		expect(result.ok).toBe(true);
		expect(executorCalled).toBe(false);
		if (result.ok) {
			expect(result.value.command).toEqual(["spectre", "input.scs"]);
			expect(result.value.cwd).toBe("/tmp/job");
			expect(result.value.exitCode).toBe(0);
			expect(result.value.dryRun).toBe(true);
		}
	});

	it("delegates real runs to the provided executor", async () => {
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: "ok",
					stderr: "",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runProcess(
			{
				command: "spectre",
				args: ["input.scs"],
				cwd: "/tmp/job",
			},
			{ executor },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.command).toEqual(["spectre", "input.scs"]);
			expect(result.value.stdout).toBe("ok");
			expect(result.value.dryRun).toBe(false);
		}
	});

	it("runs a real child process with the default executor", async () => {
		const result = await runProcess({
			command: "/bin/echo",
			args: ["-n", "ok"],
			cwd: "/tmp",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.exitCode).toBe(0);
			expect(result.value.stdout).toBe("ok");
		}
	});

	it("preserves non-zero exit codes as structured process results", async () => {
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 1,
					stdout: "",
					stderr: "spectre error",
					startedAt: "2026-05-29T00:00:00.000Z",
					endedAt: "2026-05-29T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await runProcess(
			{
				command: "spectre",
				args: ["input.scs"],
				cwd: "/tmp/job",
			},
			{ executor },
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.exitCode).toBe(1);
			expect(result.value.stderr).toBe("spectre error");
		}
	});

	it("converts executor exceptions to runtime failures", async () => {
		const executor: ProcessExecutor = {
			async run() {
				throw new Error("spawn failed");
			},
		};

		const result = await runProcess(
			{
				command: "spectre",
				args: ["input.scs"],
				cwd: "/tmp/job",
			},
			{ executor },
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("process_run_error");
			expect(result.error.stage).toBe("process_run");
			expect(result.error.message).toBe("spawn failed");
			expect(result.error.details).toEqual({
				command: ["spectre", "input.scs"],
				cwd: "/tmp/job",
			});
		}
	});
});
