import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerManagedVirtuosoInstance } from "../../../src/runtime/backends/virtuoso/instance-registry.ts";
import {
	modifyManagedVirtuoso,
	renderVirtuosoModificationSkill,
	type VirtuosoModificationPlan,
	validateVirtuosoModificationPlan,
} from "../../../src/runtime/workflows/modification.ts";

function createPlan(): VirtuosoModificationPlan {
	return {
		schemaVersion: 1,
		kind: "virtuoso-modification-plan",
		workflow: { id: "amp-optimization", sequence: 1 },
		beforeApply: {
			baselineExport: {
				policy: "if-missing",
				profile: "full",
				onUnavailableResults: "record-and-continue",
			},
		},
		targets: {
			schematic: { library: "test_tb", cell: "two_stage_amp_tb", view: "schematic" },
			maestro: { library: "test_tb", cell: "two_stage_amp_tb", view: "maestro" },
		},
		changes: {
			deviceParameters: [
				{
					id: "set-c0",
					operation: "set",
					instance: "C0",
					expect: {
						master: { library: "analogLib", cell: "cap", view: "symbol" },
						parameters: { c: "1p" },
					},
					parameters: { c: { value: "2p", valueType: "expression" } },
				},
			],
			tests: [
				{
					testName: "test_tb_two_stage_amp_tb_1",
					analyses: [
						{
							id: "delete-tran",
							operation: "delete",
							selector: { name: "tran", type: "tran" },
						},
					],
					outputs: [
						{
							id: "add-vout",
							operation: "add",
							output: {
								name: "Vout",
								type: "expression",
								expression: 'VT("/Vout")',
								save: true,
							},
						},
					],
				},
			],
		},
	};
}

describe("Virtuoso modification workflow", () => {
	it("validates an incremental plan with a first-step full baseline", () => {
		const result = validateVirtuosoModificationPlan(createPlan());

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.workflow).toEqual({ id: "amp-optimization", sequence: 1 });
			expect(result.value.beforeApply?.baselineExport?.policy).toBe("if-missing");
		}
	});

	it("requires the target implied by each operation category", () => {
		const plan = createPlan();
		delete plan.targets.maestro;

		const result = validateVirtuosoModificationPlan(plan);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("targets.maestro is required");
		}
	});

	it("rejects duplicate operation IDs and malformed output expressions", () => {
		const plan = createPlan();
		plan.changes.tests?.[0].outputs?.push({
			id: "set-c0",
			operation: "add",
			output: { name: "broken", type: "expression" },
		});

		const result = validateVirtuosoModificationPlan(plan);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("duplicates operation id set-c0");
			expect(result.error.message).toContain("output.expression is required");
		}
	});

	it("renders only controlled SKILL data lists for the modification runtime", () => {
		const source = renderVirtuosoModificationSkill(
			createPlan(),
			true,
			"/tmp/result.json",
			"/opt/virtuoso-agent/modification.il",
		);

		expect(source).toContain("vaModificationExecute(");
		expect(source).toContain('list("set-c0" "C0" list(list("c" "2p"))');
		expect(source).toContain('list("delete-tran" "test_tb_two_stage_amp_tb_1" "delete" "tran" nil nil)');
		expect(source).toContain('"VT(\\"/Vout\\")"');
		expect(source).toContain("\n  t\n");
		expect(source).not.toContain("evalstring");
	});

	it("writes a dry-run step from a live managed-session preflight", async () => {
		const workDir = await mkdtemp(join(tmpdir(), "virtuoso-modification-workflow-"));
		const registryDir = join(workDir, "registry");
		const sessionDir = join(workDir, "session");
		const commandDir = join(sessionDir, "commands");
		const resultDir = join(sessionDir, "results");
		const processedDir = join(sessionDir, "processed");
		const readyPath = join(sessionDir, "ready.json");
		const heartbeatPath = join(sessionDir, "heartbeat.json");
		const planPath = join(workDir, "plan.json");
		await Promise.all([
			mkdir(commandDir, { recursive: true }),
			mkdir(resultDir, { recursive: true }),
			mkdir(processedDir, { recursive: true }),
		]);
		await Promise.all([
			writeFile(readyPath, '{"state":"ready"}\n', "utf8"),
			writeFile(heartbeatPath, '{"heartbeatAt":"now"}\n', "utf8"),
			writeFile(planPath, `${JSON.stringify(createPlan())}\n`, "utf8"),
		]);
		const registered = await registerManagedVirtuosoInstance(
			{
				protocolVersion: 1,
				instanceId: "vui-modification-test",
				pid: process.pid,
				processStartedAt: new Date().toISOString(),
				mode: "ui",
				state: "ready",
				cwd: workDir,
				display: ":1",
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

		const execution = modifyManagedVirtuoso({
			planPath,
			mode: "dry-run",
			instanceId: "vui-modification-test",
			registryDir,
			outputDirectory: join(workDir, "modifications"),
			timeoutMs: 2000,
		});
		let responded = false;
		for (let attempt = 0; attempt < 100; attempt++) {
			const commandName = (await readdir(commandDir)).find((name) => name.endsWith(".il"));
			if (commandName) {
				const source = await readFile(join(commandDir, commandName), "utf8");
				expect(source).toContain("vaModificationExecute(");
				expect(source).toContain("\n  nil\n");
				await writeFile(
					join(resultDir, commandName.replace(/\.il$/, ".json")),
					`${JSON.stringify({
						ok: true,
						value: {
							apply: false,
							deviceParameters: [],
							analyses: [],
							outputs: [],
							schematic: { saved: false, check: "", uiStatus: "not-applicable" },
							maestro: { saved: false, uiStatus: "not-applicable" },
							verification: null,
						},
					})}\n`,
					"utf8",
				);
				responded = true;
				break;
			}
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
		}
		expect(responded).toBe(true);
		const result = await execution;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.stepDirectory).toBe(join(workDir, "modifications", "amp-optimization", "steps", "001"));
			expect(JSON.parse(await readFile(result.value.reportPath ?? "", "utf8"))).toMatchObject({
				mode: "dry-run",
				status: "planned",
			});
			expect(await readFile(result.value.generatedSkillPath ?? "", "utf8")).toContain("steps/001/skill-result.json");
			await expect(
				readFile(join(workDir, "modifications", "amp-optimization", ".workflow.lock"), "utf8"),
			).rejects.toMatchObject({ code: "ENOENT" });
		}
	});
});
