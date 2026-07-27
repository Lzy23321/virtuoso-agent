import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	executeVirtuosoBridgeSessionCommand,
	getCurrentVirtuosoCellView,
	listVirtuosoLibraries,
	listVirtuosoLibraryCellViews,
	openVirtuosoCellView,
	type ProcessExecutor,
	showVirtuosoCellView,
	startVirtuosoUiSession,
} from "../../../../src/index.ts";

describe("Virtuoso SKILL bridge", () => {
	it("generates controlled cellView expressions", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const expressions: string[] = [];
		const executor: ProcessExecutor = {
			async run(request) {
				expressions.push(await readFile(request.args[2], "utf8"));
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: '{"ok":true,"value":{"library":"ota_lib","cell":"ota_core","view":"schematic","mode":"r"}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const opened = await openVirtuosoCellView({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			workDir,
			executor,
		});
		const current = await getCurrentVirtuosoCellView({ workDir, executor });

		expect(opened.ok).toBe(true);
		expect(current.ok).toBe(true);
		expect(expressions[0]).toContain('vaOpenCellView("ota_lib" "ota_core" "schematic" "r")');
		expect(expressions[1]).toContain("vaGetCurrentCellView()");
	});

	it("saves Cadence library and cellView inventory as JSON artifacts", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-inventory-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const script = await readFile(request.args[2], "utf8");
				const value = script.includes("vaListLibraries()")
					? {
							counts: { libraries: 1, cells: 1, views: 2 },
							libraries: [{ name: "ota_lib", path: "/work/ota_lib", counts: { cells: 1, views: 2 }, cells: [] }],
						}
					: {
							name: "ota_lib",
							path: "/work/ota_lib",
							counts: { cells: 1, views: 2 },
							cells: [
								{
									name: "ota_core",
									counts: { views: 2 },
									views: [{ name: "schematic" }, { name: "symbol" }],
								},
							],
						};
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: `${JSON.stringify({ ok: true, value })}\n`,
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const libraries = await listVirtuosoLibraries({ workDir, executor });
		const cellViews = await listVirtuosoLibraryCellViews({ library: "ota_lib", workDir, executor });

		expect(libraries.ok).toBe(true);
		expect(cellViews.ok).toBe(true);
		if (libraries.ok && cellViews.ok) {
			expect(libraries.value.summary?.counts).toEqual({ libraries: 1, cells: 1, views: 2 });
			expect(JSON.parse(await readFile(cellViews.value.artifact?.path ?? "", "utf8")).cells[0].views).toEqual([
				{ name: "schematic" },
				{ name: "symbol" },
			]);
		}
	});

	it("creates reusable visible UI launch scripts without exit", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));
		const sessionDir = join(workDir, ".session");

		const shown = await showVirtuosoCellView({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			workDir,
			dryRun: true,
		});
		const session = await startVirtuosoUiSession({ workDir, sessionDir, dryRun: true });

		expect(shown.ok).toBe(true);
		expect(session.ok).toBe(true);
		if (shown.ok && session.ok) {
			expect(await readFile(shown.value.scriptPath, "utf8")).not.toContain("exit()");
			expect(await readFile(session.value.scriptPath, "utf8")).toContain(
				`vaStartSessionBridge("${sessionDir}" "${join(sessionDir, "ready.json")}" "${join(
					sessionDir,
					"heartbeat.json",
				)}")`,
			);
		}
	});

	it("executes a command through the managed session result protocol", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-command-"));
		const heartbeatPath = join(sessionDir, "heartbeat.json");
		await mkdir(join(sessionDir, "commands"), { recursive: true });
		await mkdir(join(sessionDir, "results"), { recursive: true });
		await mkdir(join(sessionDir, "processed"), { recursive: true });
		await writeFile(heartbeatPath, "{}\n", "utf8");

		const execution = executeVirtuosoBridgeSessionCommand<{ status: string }>({
			sessionDir,
			heartbeatPath,
			resultFileName: "operation.json",
			expression: (resultPath) => `vaSessionWriteResult("${resultPath}" "{}")`,
			timeoutMs: 2_000,
		});
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await readdir(join(sessionDir, "commands"))).includes("operation.il")) {
				break;
			}
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		await writeFile(join(sessionDir, "results", "operation.json"), '{"ok":true,"value":{"status":"done"}}\n', "utf8");

		const result = await execution;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value).toEqual({ status: "done" });
		}
	});
});
