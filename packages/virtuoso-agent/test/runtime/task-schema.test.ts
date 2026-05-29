import { describe, expect, it } from "vitest";
import { validateTaskObject } from "../../src/index.ts";

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

	it("reports invalid parameter definitions", () => {
		const result = validateTaskObject({
			name: "frontend-demo",
			parameters: {
				wn: { min: "1u", max: false },
				wp: "4u",
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toEqual([
				{ path: "parameters.wn.value", message: "parameter value must be a string, number, or boolean." },
				{ path: "parameters.wn.max", message: "parameter max must be a string or number." },
				{ path: "parameters.wp", message: "parameter must be an object." },
			]);
		}
	});

	it("reports invalid simulation, output, and safety fields", () => {
		const result = validateTaskObject({
			name: "frontend-demo",
			simulation: { backend: "maestro", script: 42 },
			outputs: [{ target: 0.9 }, "gain"],
			safety: { allowWrite: "yes", dryRun: 1 },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toEqual([
				{ path: "simulation.backend", message: "backend must be fake, spectre, ocean, or ocean-xl." },
				{ path: "simulation.script", message: "simulation script must be a non-empty string." },
				{ path: "outputs.0.name", message: "output name is required." },
				{ path: "outputs.0.target", message: "output target must be a string." },
				{ path: "outputs.1", message: "output must be an object." },
				{ path: "safety.allowWrite", message: "allowWrite must be a boolean." },
				{ path: "safety.dryRun", message: "dryRun must be a boolean." },
			]);
		}
	});

	it("validates backend-specific simulation inputs", () => {
		const spectre = validateTaskObject({
			name: "spectre-demo",
			simulation: { backend: "spectre" },
		});
		const ocean = validateTaskObject({
			name: "ocean-demo",
			simulation: { backend: "ocean" },
		});
		const oceanXl = validateTaskObject({
			name: "ocean-xl-demo",
			simulation: { backend: "ocean-xl", script: "run.ocn" },
		});

		expect(spectre.ok).toBe(true);
		if (spectre.ok) {
			expect(spectre.value.issues).toEqual([
				{ path: "simulation.netlist", message: "spectre backend requires a netlist path." },
			]);
		}

		expect(ocean.ok).toBe(true);
		if (ocean.ok) {
			expect(ocean.value.issues).toEqual([
				{ path: "simulation.script", message: "ocean backend requires a script path." },
			]);
		}

		expect(oceanXl.ok).toBe(true);
		if (oceanXl.ok) {
			expect(oceanXl.value.issues).toEqual([]);
		}
	});

	it("validates spectre option fields", () => {
		const result = validateTaskObject({
			name: "spectre-demo",
			simulation: {
				backend: "spectre",
				netlist: "input.scs",
				spectre: {
					format: "unknown",
					mode64: "yes",
					lqtimeout: "900",
					additionalArgs: ["+mt", 1],
				},
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.issues).toEqual([
				{ path: "simulation.spectre.format", message: "spectre format must be psfbin or psfxl." },
				{ path: "simulation.spectre.mode64", message: "value must be a boolean." },
				{ path: "simulation.spectre.lqtimeout", message: "value must be a number." },
				{ path: "simulation.spectre.additionalArgs", message: "spectre additionalArgs must be strings." },
			]);
		}
	});
});
