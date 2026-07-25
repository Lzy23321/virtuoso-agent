import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectManagedVirtuosoMaestro, registerManagedVirtuosoInstance } from "../../../src/index.ts";

describe("managed Virtuoso workflows", () => {
	it("returns Maestro data through the shared inspection result", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-agent-managed-inspect-"));
		const registryDir = join(workDir, "registry");
		const sessionDir = join(workDir, "session");
		const commandDir = join(sessionDir, "commands");
		const resultDir = join(sessionDir, "results");
		const processedDir = join(sessionDir, "processed");
		const readyPath = join(sessionDir, "ready.json");
		const heartbeatPath = join(sessionDir, "heartbeat.json");
		await mkdir(commandDir, { recursive: true });
		await mkdir(resultDir, { recursive: true });
		await mkdir(processedDir, { recursive: true });
		await writeFile(readyPath, "{}\n", "utf8");
		await writeFile(heartbeatPath, "{}\n", "utf8");
		const registered = await registerManagedVirtuosoInstance(
			{
				protocolVersion: 1,
				instanceId: "managed-maestro",
				pid: process.pid,
				processStartedAt: new Date().toISOString(),
				mode: "headless",
				state: "ready",
				cwd: workDir,
				cdsLib: join(workDir, "cds.lib"),
				sessionDir,
				commandDir,
				resultDir,
				processedDir,
				readyPath,
				heartbeatPath,
				bridgePath: join(workDir, "skill-runtime", "bridge.il"),
			},
			registryDir,
		);
		expect(registered.ok).toBe(true);

		const inspection = inspectManagedVirtuosoMaestro({
			instanceId: "managed-maestro",
			registryDir,
			library: "ota_lib",
			cell: "ota_tb",
			view: "maestro",
			timeoutMs: 2_000,
		});

		for (let attempt = 0; attempt < 100; attempt++) {
			const commands = await readdir(commandDir);
			const commandName = commands.find((name) => name.endsWith(".il"));
			if (commandName) {
				const command = await readFile(join(commandDir, commandName), "utf8");
				expect(command).toContain('vaSessionInspectMaestro("ota_lib" "ota_tb" "maestro"');
				const resultName = commandName.replace(/\.il$/, ".json");
				await writeFile(
					join(resultDir, resultName),
					`${JSON.stringify({
						ok: true,
						value: {
							schemaVersion: "0.1-prototype",
							kind: "maestro-inspect",
							generatedAt: "Cadence time",
							target: { library: "ota_lib", cell: "ota_tb", view: "maestro" },
							source: { openMode: "r", virtuosoVersion: "IC25.1" },
							session: {
								name: "session1",
								valid: true,
								singleTest: true,
								modified: false,
								runMode: "nominal",
								setupLibrary: null,
								closedAfterInspect: true,
							},
							storage: { path: null },
							summary: {
								tests: 1,
								enabledTests: 1,
								globalVariables: 0,
								testVariableEntries: 0,
								uniqueTestVariables: 0,
								parameters: { total: 0, enabled: 0, disabled: 0, withValue: 0 },
								corners: 1,
								analysisEntries: 1,
								outputs: 1,
							},
							maestro: { globalVariables: [], parameters: [] },
							tests: [],
							warnings: ["model path unresolved"],
						},
					})}\n`,
					"utf8",
				);
				break;
			}
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		}

		const result = await inspection;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.target).toEqual({ library: "ota_lib", cell: "ota_tb", view: "maestro" });
			expect(result.value.summary.counts.tests).toBe(1);
			expect(result.value.warnings).toEqual(["model path unresolved"]);
			expect(result.value.artifacts).toHaveLength(1);
			expect(JSON.parse(await readFile(result.value.artifacts[0].path, "utf8"))).toMatchObject({
				kind: "maestro-inspect",
				target: { library: "ota_lib", cell: "ota_tb", view: "maestro" },
			});
		}
	});
});
