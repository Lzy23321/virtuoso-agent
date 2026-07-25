import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	compactAgentOutput,
	executeVirtuosoBridgeSessionCommand,
	getCurrentVirtuosoCellView,
	getVirtuosoInstanceParameters,
	inspectVirtuosoMaestro,
	inspectVirtuosoSchematic,
	listVirtuosoInstances,
	listVirtuosoLibraries,
	listVirtuosoLibraryCellViews,
	openVirtuosoCellView,
	type ProcessExecutor,
	showVirtuosoCellView,
	showVirtuosoCellViewInSession,
	startVirtuosoBridgeUi,
	startVirtuosoUiSession,
} from "../../../../src/index.ts";

describe("Virtuoso SKILL bridge", () => {
	it("generates a controlled open cellView expression", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain('vaOpenCellView("ota_lib" "ota_core" "schematic" "r")');
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

		const result = await openVirtuosoCellView({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			workDir,
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value).toEqual({
				library: "ota_lib",
				cell: "ota_core",
				view: "schematic",
				mode: "r",
			});
		}
	});

	it("generates a controlled current cellView expression", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain("vaGetCurrentCellView()");
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

		const result = await getCurrentVirtuosoCellView({ workDir, executor });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value.cell).toBe("ota_core");
		}
	});

	it("generates a controlled list instances expression", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain('vaListInstances("ota_lib" "ota_core" "schematic" "r")');
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout:
						'{"ok":true,"value":{"cellView":{"library":"ota_lib","cell":"ota_core","view":"schematic","mode":"r"},"instances":[{"name":"M0","library":"gpdk","cell":"nmos","view":"symbol"}]}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await listVirtuosoInstances({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			workDir,
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value.instances).toEqual([{ name: "M0", library: "gpdk", cell: "nmos", view: "symbol" }]);
		}
	});

	it("saves library inventory artifacts and returns a compact summary", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain("vaListLibraries()");
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout:
						'{"ok":true,"value":{"counts":{"libraries":1,"cells":1,"views":2},"libraries":[{"name":"ota_lib","path":"/work/ota_lib","counts":{"cells":1,"views":2},"cells":[]}]}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await listVirtuosoLibraries({ workDir, executor });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.summary?.counts).toEqual({ libraries: 1, cells: 1, views: 2 });
			expect(result.value.artifact?.path).toMatch(
				/\.virtuoso-agent\/inventory\/libraries-\d+T\d+\.\d+Z-[0-9a-f-]+\.json$/,
			);
			expect(JSON.parse(await readFile(result.value.artifact?.path ?? "", "utf8"))).toEqual({
				counts: { libraries: 1, cells: 1, views: 2 },
				libraries: [{ name: "ota_lib", path: "/work/ota_lib", counts: { cells: 1, views: 2 }, cells: [] }],
			});
		}
	});

	it("saves one-library cellView inventory artifacts and returns only library summary", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain('vaListCellViews("ota_lib")');
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout:
						'{"ok":true,"value":{"name":"ota_lib","path":"/work/ota_lib","counts":{"cells":1,"views":2},"cells":[{"name":"ota_core","counts":{"views":2},"views":[{"name":"schematic"},{"name":"symbol"}]}]}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await listVirtuosoLibraryCellViews({ library: "ota_lib", workDir, executor });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.summary).toEqual({
				library: { name: "ota_lib", path: "/work/ota_lib", counts: { cells: 1, views: 2 } },
			});
			expect(result.value.summary).not.toHaveProperty("cells");
			expect(JSON.parse(await readFile(result.value.artifact?.path ?? "", "utf8")).cells[0].views).toEqual([
				{ name: "schematic" },
				{ name: "symbol" },
			]);
		}
	});

	it("saves maestro inspect artifacts and returns a compact summary", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain('load("/repo/maestro-inspect.il")');
				expect(script).toContain('vaInspectMaestro("ota_lib" "ota_tb" "maestro")');
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: null,
					stdout:
						'{"ok":true,"value":{"schemaVersion":"0.1-prototype","kind":"maestro-inspect","generatedAt":"Cadence time","target":{"library":"ota_lib","cell":"ota_tb","view":"maestro"},"source":{"openMode":"r","virtuosoVersion":"IC25.1"},"session":{"name":"fnxSession1","valid":true,"singleTest":true,"modified":false,"runMode":"nominal","setupLibrary":null,"closedAfterInspect":true},"storage":{"path":"/work/ota_lib/ota_tb/maestro"},"summary":{"tests":1,"enabledTests":1,"globalVariables":1,"testVariableEntries":2,"uniqueTestVariables":2,"parameters":{"total":1,"enabled":1,"disabled":0,"withValue":1},"corners":1,"analysisEntries":2,"outputs":1},"maestro":{"globalVariables":[{"name":"vdd","enabled":true,"value":"1.8","resolvedValue":"1.8"}],"parameters":[{"path":"test1/M0/w","enabled":true,"value":"2u"}]},"tests":[{"name":"test1","enabled":true,"design":{"library":"ota_lib","cell":"ota_core","view":"schematic"},"simulator":"spectre","analyses":[{"type":"ac","enabled":true,"effectiveSettings":{"start":"1"}},{"type":"tran","enabled":false,"effectiveSettings":{"stop":"1000u"}}],"designVariables":[{"name":"vdd","value":"1.8"}],"corners":[{"name":"Nominal","temperature":"27","processCorner":["tt"],"modelFiles":[{"configuredPath":"/pdk/models.scs","path":"/pdk/models.scs","available":true,"section":"tt"}],"variables":{}}],"outputsSetup":[{"name":"gain","type":"expr","details":"db(vf(\\"/out\\"))","plot":true,"plotTarget":null,"save":false,"spec":null}],"netlist":{"directory":"/sim/netlist","discovery":"filesystem","available":true}}],"warnings":[]}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await inspectVirtuosoMaestro({
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			bridgePath: "/repo/bridge.il",
			workDir,
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok && result.value.inspection === "completed") {
			expect(result.value.target).toEqual({ library: "ota_lib", cell: "ota_tb", view: "maestro" });
			expect(result.value.summary).toEqual({
				kind: "maestro-inspect",
				session: { name: "fnxSession1", valid: true, singleTest: true, closedAfterInspect: true },
				counts: {
					tests: 1,
					enabledTests: 1,
					globalVariables: 1,
					testVariableEntries: 2,
					uniqueTestVariables: 2,
					parameters: { total: 1, enabled: 1, disabled: 0, withValue: 1 },
					corners: 1,
					analysisEntries: 2,
					outputs: 1,
				},
			});
			expect(result.value.artifacts).toHaveLength(1);
			expect(result.value.artifacts[0].path).toContain("/.virtuoso-agent/inspect/");
			expect(result.value.warnings).toContain(
				"Virtuoso returned a complete manifest but did not exit cleanly (exitCode: null).",
			);
			const artifact = JSON.parse(await readFile(result.value.artifacts[0].path, "utf8"));
			expect(artifact.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
			expect(artifact.tests[0].analyses).toEqual([
				{ type: "ac", enabled: true, effectiveSettings: { start: "1" } },
				{ type: "tran", enabled: false, effectiveSettings: { stop: "1000u" } },
			]);
			expect(artifact.tests[0].corners[0].modelFiles[0]).toMatchObject({ section: "tt", available: true });
			expect(artifact.maestro.parameters[0]).toEqual({ path: "test1/M0/w", enabled: true, value: "2u" });
			expect(artifact.warnings).toContain(
				"Virtuoso returned a complete manifest but did not exit cleanly (exitCode: null).",
			);
		}
	});

	it("saves schematic inspect artifacts with normalized connections and references", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-schematic-inspect-"));
		const cdsLib = join(workDir, "project.cds.lib");
		await writeFile(cdsLib, "", "utf8");
		const executor: ProcessExecutor = {
			async run(request) {
				const script = await readFile(request.args[2], "utf8");
				expect(script).toContain(`ddSetForcedLib("${cdsLib}")`);
				expect(script).toContain("ddUpdateLibList()");
				expect(script).toContain('load("/repo/schematic-inspect.il")');
				expect(script).toContain('vaInspectSchematic("ota_lib" "ota_core" "schematic")');
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: `${JSON.stringify({
						ok: true,
						value: {
							schemaVersion: "0.1",
							kind: "schematic-inspect",
							generatedAt: "Cadence time",
							target: { library: "ota_lib", cell: "ota_core", view: "schematic" },
							source: { openMode: "r", virtuosoVersion: "IC25.1" },
							connectivity: { status: "clean" },
							summary: {
								instances: 1,
								topTerminals: 1,
								instanceTerminals: 2,
								nets: 1,
								connectedEndpoints: 2,
								unconnectedEndpoints: 1,
								referencedMasters: 1,
							},
							instances: [
								{
									name: "M0",
									master: { library: "gpdk", cell: "nmos", view: "symbol" },
									placement: { x: 1, y: 2, orientation: "R0" },
									parameters: { w: "2u" },
								},
							],
							terminals: [{ name: "out", direction: "output", width: 1 }],
							nets: [{ name: "out", signalType: "signal", isGlobal: false, width: 1 }],
							connections: [
								{
									net: "out",
									endpoint: {
										kind: "instance-terminal",
										instance: "M0",
										terminal: "D",
										direction: "inputOutput",
										width: 1,
									},
								},
								{
									net: null,
									endpoint: {
										kind: "instance-terminal",
										instance: "M0",
										terminal: "B",
										direction: "inputOutput",
										width: 1,
									},
								},
								{
									net: "out",
									endpoint: { kind: "top-terminal", terminal: "out", direction: "output", width: 1 },
								},
							],
							references: [],
							warnings: [],
						},
					})}\n`,
					stderr: "",
					startedAt: "2026-07-22T00:00:00.000Z",
					endedAt: "2026-07-22T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await inspectVirtuosoSchematic({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			bridgePath: "/repo/bridge.il",
			cdsLib,
			workDir,
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok && result.value.inspection === "completed") {
			expect(JSON.stringify(compactAgentOutput(result))).not.toContain("[Circular]");
			expect(result.value.artifacts).toHaveLength(2);
			expect(result.value.artifacts[1]).toMatchObject({
				kind: "schematic-topology",
				format: "text",
			});
			expect(result.value.summary).toEqual({
				kind: "schematic-inspect",
				connectivityStatus: "clean",
				counts: {
					instances: 1,
					topTerminals: 1,
					instanceTerminals: 2,
					nets: 1,
					connectedEndpoints: 2,
					unconnectedEndpoints: 1,
					referencedMasters: 1,
				},
				devices: [
					{
						master: { library: "gpdk", cell: "nmos", view: "symbol" },
						count: 1,
						instances: ["M0"],
					},
				],
				instances: [
					{
						name: "M0",
						master: { library: "gpdk", cell: "nmos", view: "symbol" },
						parameters: { w: "2u" },
					},
				],
			});
			expect(result.value.warnings).toEqual(["Schematic has 1 unconnected endpoint(s)."]);
			const artifact = JSON.parse(await readFile(result.value.artifacts[0].path, "utf8"));
			expect(artifact.references).toEqual([
				{
					master: { library: "gpdk", cell: "nmos", view: "symbol" },
					instanceCount: 1,
					instances: ["M0"],
				},
			]);
			const topology = await readFile(result.value.artifacts[1].path, "utf8");
			expect(topology).toContain("* virtuoso-agent schematic topology v1");
			expect(topology).toContain(".cell ota_lib/ota_core/schematic");
			expect(topology).toContain("out direction=output width=1 net=out");
			expect(topology).toContain("M0 master=gpdk/nmos/symbol");
			expect(topology).toContain("pins B=<unconnected> D=out");
			expect(topology).toContain("params w=2u");
		}
	});

	it("generates a controlled instance parameter expression", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));
		const executor: ProcessExecutor = {
			async run(request) {
				const scriptPath = request.args[2];
				const script = await readFile(scriptPath, "utf8");
				expect(script).toContain('vaGetInstanceParameters("ota_lib" "ota_core" "schematic" "M0" "r")');
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout:
						'{"ok":true,"value":{"cellView":{"library":"ota_lib","cell":"ota_core","view":"schematic","mode":"r"},"instance":{"name":"M0","library":"gpdk","cell":"nmos","view":"symbol"},"parameters":[{"name":"w","value":"2u"}]}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await getVirtuosoInstanceParameters({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			instanceName: "M0",
			workDir,
			executor,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value.parameters).toEqual([{ name: "w", value: "2u" }]);
		}
	});

	it("creates a visible UI launch script without an exit command", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-bridge-test-"));

		const result = await showVirtuosoCellView({
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			workDir,
			dryRun: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.command).toEqual(["virtuoso", "-restore", result.value.scriptPath]);
			expect(result.value.scriptPath).toMatch(/bridge-call-[0-9a-f-]+\.il$/);
			expect(result.value.detached).toBe(true);
			expect(result.value.dryRun).toBe(true);
			const script = await readFile(result.value.scriptPath, "utf8");
			expect(script).toContain('vaShowCellView("ota_lib" "ota_core" "schematic" "r")');
			expect(script).not.toContain("exit()");
		}
	});

	it("creates a reusable visible UI session dry-run launch", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));
		const sessionDir = join(workDir, ".session");

		const result = await startVirtuosoUiSession({
			workDir,
			sessionDir,
			dryRun: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.command).toEqual(["virtuoso", "-restore", result.value.scriptPath]);
			expect(result.value.scriptPath).toMatch(/bridge-call-[0-9a-f-]+\.il$/);
			expect(result.value.sessionDir).toBe(sessionDir);
			expect(result.value.commandDir).toBe(join(sessionDir, "commands"));
			const script = await readFile(result.value.scriptPath, "utf8");
			expect(script).toContain(
				`vaStartSessionBridge("${sessionDir}" "${join(sessionDir, "ready.json")}" "${join(sessionDir, "heartbeat.json")}")`,
			);
			expect(script).not.toContain("exit()");
		}
	});

	it("verifies and forwards the complete inherited desktop environment", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-display-test-"));
		let launcherCalled = false;
		const result = await startVirtuosoBridgeUi({
			expression: "vaShowCellView()",
			workDir,
			display: ":7",
			xAuthority: "/run/user/1000/xauth",
			waylandDisplay: "wayland-1",
			xdgRuntimeDir: "/run/user/1000",
			displayProbe: {
				async check(environment) {
					expect(environment).toEqual({
						display: ":7",
						xAuthority: "/run/user/1000/xauth",
						waylandDisplay: "wayland-1",
						xdgRuntimeDir: "/run/user/1000",
					});
					return { ok: true };
				},
			},
			launcher: {
				async start(request) {
					launcherCalled = true;
					expect(request.desktopEnvironment).toEqual({
						display: ":7",
						xAuthority: "/run/user/1000/xauth",
						waylandDisplay: "wayland-1",
						xdgRuntimeDir: "/run/user/1000",
					});
					return {
						command: [request.command, ...request.args],
						cwd: request.cwd,
						pid: 123,
						startedAt: "2026-07-21T00:00:00.000Z",
						detached: true,
						dryRun: false,
					};
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(launcherCalled).toBe(true);
	});

	it("does not launch Virtuoso when the X11 handshake fails", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-display-test-"));
		let launcherCalled = false;
		const result = await startVirtuosoBridgeUi({
			expression: "vaShowCellView()",
			workDir,
			display: ":7",
			displayProbe: {
				async check() {
					return { ok: false, message: "unable to open display" };
				},
			},
			launcher: {
				async start(request) {
					launcherCalled = true;
					return {
						command: [request.command, ...request.args],
						cwd: request.cwd,
						startedAt: "2026-07-21T00:00:00.000Z",
						detached: true,
						dryRun: false,
					};
				},
			},
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("virtuoso_display_unreachable");
			expect(result.error.message).toContain("unable to open display");
		}
		expect(launcherCalled).toBe(false);
	});

	it("uses an explicit cds.lib as the default Virtuoso session work directory", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-cdslib-test-"));
		const cdsLib = join(workDir, "cds.lib");
		const sessionDir = join(workDir, ".session");
		await writeFile(cdsLib, "DEFINE worklib ./worklib\n", "utf8");

		const result = await startVirtuosoUiSession({
			cdsLib,
			sessionDir,
			dryRun: true,
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.cwd).toBe(workDir);
			expect(result.value.cdsLib).toBe(cdsLib);
			expect(result.value.metadataPath).toBe(join(sessionDir, "metadata.json"));
			expect(JSON.parse(await readFile(result.value.metadataPath, "utf8"))).toMatchObject({
				workDir,
				cdsLib,
			});
		}
	});

	it("queues a controlled session cellView show command", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));

		const result = await showVirtuosoCellViewInSession({
			sessionDir,
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			resultFileName: "show.json",
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.commandPath).toBe(join(sessionDir, "commands", "show.il"));
			expect(result.value.resultPath).toBe(join(sessionDir, "results", "show.json"));
			const command = await readFile(result.value.commandPath, "utf8");
			expect(command).toContain(
				`vaSessionShowCellView("ota_lib" "ota_core" "schematic" "r" "${join(sessionDir, "results", "show.json")}")`,
			);
		}
	});

	it("rejects unsafe session result file names", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));

		const result = await showVirtuosoCellViewInSession({
			sessionDir,
			library: "ota_lib",
			cell: "ota_core",
			view: "schematic",
			resultFileName: "../../outside.json",
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("virtuoso_session_result_name_invalid");
		}
	});

	it("does not queue a command over an existing session result", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));
		await mkdir(join(sessionDir, "results"), { recursive: true });
		await writeFile(join(sessionDir, "results", "operation.json"), '{"ok":true,"value":{"stale":true}}\n', "utf8");

		const result = await executeVirtuosoBridgeSessionCommand({
			sessionDir,
			heartbeatPath: join(sessionDir, "heartbeat.json"),
			resultFileName: "operation.json",
			expression: (resultPath) => `vaControlledOperation("${resultPath}")`,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("virtuoso_session_result_conflict");
		}
	});

	it("waits for a real managed session result", async () => {
		const sessionDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-session-test-"));
		const heartbeatPath = join(sessionDir, "heartbeat.json");
		await writeFile(heartbeatPath, '{"heartbeatAt":"now"}\n', "utf8");

		const operation = executeVirtuosoBridgeSessionCommand<{ displayed: boolean }>({
			sessionDir,
			heartbeatPath,
			resultFileName: "operation.json",
			expression: (resultPath) => `vaControlledOperation("${resultPath}")`,
			timeoutMs: 2_000,
			pollIntervalMs: 10,
		});

		for (let attempt = 0; attempt < 100; attempt++) {
			const commands = await readdir(join(sessionDir, "commands"));
			if (commands.includes("operation.il")) {
				await writeFile(
					join(sessionDir, "results", "operation.json"),
					'{"ok":true,"value":{"displayed":true}}\n',
					"utf8",
				);
				break;
			}
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		}

		const result = await operation;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.value).toEqual({ displayed: true });
			expect(result.value.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it("returns bridge errors as runtime failures", async () => {
		const executor: ProcessExecutor = {
			async run(request) {
				return {
					command: [request.command, ...request.args],
					cwd: request.cwd,
					exitCode: 0,
					stdout: '{"ok":false,"error":{"type":"CELLVIEW_OPEN_FAILED","message":"Could not open cellView."}}\n',
					stderr: "",
					startedAt: "2026-07-14T00:00:00.000Z",
					endedAt: "2026-07-14T00:00:01.000Z",
					dryRun: request.dryRun,
				};
			},
		};

		const result = await openVirtuosoCellView({
			library: "missing",
			cell: "missing",
			view: "schematic",
			executor,
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.type).toBe("CELLVIEW_OPEN_FAILED");
			expect(result.error.message).toBe("Could not open cellView.");
		}
	});
});
