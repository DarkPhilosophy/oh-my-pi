import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { getActiveRules, type Rule, resetActiveRulesForTests, setActiveRules } from "../../capability/rule";
import { getActiveSkills, resetActiveSkillsForTests, type Skill, setActiveSkills } from "../../extensibility/skills";
import { AgentRegistry, createAgentRegistryScope } from "../../registry/agent-registry";
import { RuleProtocolHandler } from "../rule-protocol";
import { SkillProtocolHandler } from "../skill-protocol";

afterEach(() => {
	resetActiveSkillsForTests();
	resetActiveRulesForTests();
	AgentRegistry.resetGlobalForTests();
});

it("isolates active skill and rule snapshots between registry scopes", async () => {
	const tempDir = TempDir.createSync("omp-skill-rule-registry-isolation-");
	const root = path.resolve(tempDir.path());
	try {
		const scopeA = createAgentRegistryScope(new AgentRegistry());
		const scopeB = createAgentRegistryScope(new AgentRegistry());
		const skill = (name: string): Skill => {
			const baseDir = path.join(root, name);
			return {
				name,
				description: `${name} description`,
				filePath: path.join(baseDir, "SKILL.md"),
				baseDir,
				source: name,
			};
		};
		const rule = (name: string, content: string): Rule => ({
			name,
			path: path.join(root, `${name}.md`),
			content,
			_source: {
				provider: "test",
				providerName: "Test",
				path: path.join(root, `${name}.md`),
				level: "project",
			},
		});
		const skillA = skill("skill-a");
		const skillB = skill("skill-b");
		await Promise.all([fs.mkdir(skillA.baseDir, { recursive: true }), fs.mkdir(skillB.baseDir, { recursive: true })]);
		await Promise.all([
			fs.writeFile(skillA.filePath, "skill A content"),
			fs.writeFile(skillB.filePath, "skill B content"),
		]);
		const ruleA = rule("rule-a", "rule A content");
		const ruleB = rule("rule-b", "rule B content");
		const skills = new SkillProtocolHandler();
		const rules = new RuleProtocolHandler();

		await scopeA.run(async () => {
			setActiveSkills([skillA]);
			setActiveRules([ruleA]);
			expect(getActiveSkills()).toEqual([skillA]);
			expect(getActiveRules()).toEqual([ruleA]);
			expect((await skills.resolve(new URL("skill://skill-a") as never)).content).toBe("skill A content");
			expect((await rules.resolve(new URL("rule://rule-a") as never)).content).toBe("rule A content");
			expect((await skills.complete()).map(item => item.value)).toEqual(["skill-a"]);
			expect((await rules.complete()).map(item => item.value)).toEqual(["rule-a"]);
			await expect(skills.resolve(new URL("skill://skill-b") as never)).rejects.toThrow("Unknown skill: skill-b");
			await expect(rules.resolve(new URL("rule://rule-b") as never)).rejects.toThrow("Unknown rule: rule-b");
		});

		await scopeB.run(async () => {
			setActiveSkills([skillB]);
			setActiveRules([ruleB]);
			expect(getActiveSkills()).toEqual([skillB]);
			expect(getActiveRules()).toEqual([ruleB]);
			expect((await skills.resolve(new URL("skill://skill-b") as never)).content).toBe("skill B content");
			expect((await rules.resolve(new URL("rule://rule-b") as never)).content).toBe("rule B content");
			expect((await skills.complete()).map(item => item.value)).toEqual(["skill-b"]);
			expect((await rules.complete()).map(item => item.value)).toEqual(["rule-b"]);
			await expect(skills.resolve(new URL("skill://skill-a") as never)).rejects.toThrow("Unknown skill: skill-a");
			await expect(rules.resolve(new URL("rule://rule-a") as never)).rejects.toThrow("Unknown rule: rule-a");
		});
	} finally {
		tempDir.removeSync();
	}
});

it("keeps direct-mode active snapshots and reset behavior stable", async () => {
	const skill: Skill = {
		name: "direct-skill",
		description: "direct skill",
		filePath: "/tmp/direct-skill/SKILL.md",
		baseDir: "/tmp/direct-skill",
		source: "test",
	};
	const rule: Rule = {
		name: "direct-rule",
		path: "/tmp/direct-rule.md",
		content: "direct rule content",
		_source: {
			provider: "test",
			providerName: "Test",
			path: "/tmp/direct-rule.md",
			level: "project",
		},
	};
	setActiveSkills([skill]);
	setActiveRules([rule]);
	expect(getActiveSkills()).toEqual([skill]);
	expect(getActiveRules()).toEqual([rule]);
	resetActiveSkillsForTests();
	resetActiveRulesForTests();
	expect(getActiveSkills()).toEqual([]);
	expect(getActiveRules()).toEqual([]);
});
