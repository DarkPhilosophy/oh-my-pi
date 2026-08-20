/**
 * Bash intent interceptor - redirects common shell patterns to proper tools.
 *
 * When an LLM calls bash with patterns like `grep`, `cat`, `find`, etc.,
 * this interceptor provides helpful error messages directing them to use
 * the specialized tools instead.
 */
import { type BashInterceptorRule, DEFAULT_BASH_INTERCEPTOR_RULES } from "../config/settings-schema";
import { extractFlatShellCommandSegments } from "./shell-tokenize";

export interface BuiltinForward {
	/** Hardcoded built-in name; never taken from a user-configured rule. */
	tool: "read" | "grep" | "glob";
	/** Validated input for the built-in tool. */
	input: Record<string, unknown>;
	/** Read selector produced by the planner, kept separate from the path. */
	selector?: string;
}

export interface InterceptionResult {
	/** If true, the bash command should be blocked */
	block: boolean;
	/** Error message to return instead of executing */
	message?: string;
	/** Suggested tool to use instead */
	suggestedTool?: string;
	/** Safe, simple-command forwarding plan when the built-in mode is enabled. */
	forward?: BuiltinForward;
}

/**
 * Compile bash interceptor rules into regexes, skipping invalid patterns.
 */
function compileRules(rules: BashInterceptorRule[]): Array<{ rule: BashInterceptorRule; regex: RegExp }> {
	const compiled: Array<{ rule: BashInterceptorRule; regex: RegExp }> = [];
	for (const rule of rules) {
		const flags = rule.flags ?? "";
		try {
			compiled.push({ rule, regex: new RegExp(rule.pattern, flags) });
		} catch {
			// Skip invalid regex patterns
		}
	}
	return compiled;
}

/** Finds the end of a shell word, respecting quotes and escapes; returns null for incomplete syntax. */
function skipShellWord(command: string, start: number): number | null {
	let inSingle = false;
	let inDouble = false;
	for (let i = start; i < command.length; i++) {
		const ch = command[i];
		if (inSingle) {
			if (ch === "'") inSingle = false;
			continue;
		}
		if (inDouble) {
			if (ch === "\\") {
				if (i + 1 >= command.length) return null;
				i++;
				continue;
			}
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length) return null;
			i++;
			continue;
		}
		if (ch === " " || ch === "\t") return i;
	}
	return inSingle || inDouble ? null : command.length;
}

/** Removes leading `NAME=value` assignments without interpreting shell syntax. */
function withoutLeadingEnvironmentAssignments(command: string): string | null {
	let index = 0;
	let foundAssignment = false;
	while (index < command.length) {
		while (command[index] === " " || command[index] === "\t") index++;
		const assignmentStart = index;
		if (!/[A-Za-z_]/.test(command[index] ?? "")) break;
		let nameEnd = index + 1;
		while (/[A-Za-z0-9_]/.test(command[nameEnd] ?? "")) nameEnd++;
		if (command[nameEnd] !== "=") {
			return foundAssignment ? command.slice(assignmentStart).trimStart() : null;
		}
		const wordEnd = skipShellWord(command, nameEnd + 1);
		if (wordEnd === null) return null;
		foundAssignment = true;
		index = wordEnd;
		if (index === command.length) return null;
	}
	if (!foundAssignment) return null;
	const commandWithoutAssignments = command.slice(index).trimStart();
	return commandWithoutAssignments.length > 0 ? commandWithoutAssignments : null;
}

function interceptionCandidates(command: string): string[] {
	const candidates = [command.trim()];
	for (const segment of extractFlatShellCommandSegments(command)) {
		// A segment that consumes the previous stage's stdout via `|` reads piped
		// stdin, which no path-based dedicated tool (read/grep/glob) — nor any
		// other dedicated tool — can replace, so it is not an interception
		// candidate. Standalone and first-stage commands still match.
		if (segment.pipedStdin) continue;
		candidates.push(segment.text);
		const withoutAssignments = withoutLeadingEnvironmentAssignments(segment.text);
		if (withoutAssignments) candidates.push(withoutAssignments);
	}
	return candidates;
}

type SimpleShellWord = { value: string; quoted: boolean };

/**
 * Conservative lexer for commands eligible for re-forwarding. Unlike the
 * interceptor matcher, this rejects shell operators and expansions rather than
 * trying to reproduce shell semantics.
 */
function tokenizeSimpleShell(command: string): SimpleShellWord[] | undefined {
	const words: SimpleShellWord[] = [];
	let value = "";
	let quoted = false;
	let quote: "'" | '"' | undefined;
	const push = (): void => {
		if (value.length > 0 || quoted) words.push({ value, quoted });
		value = "";
		quoted = false;
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (";&|<>();$`\n\r".includes(ch)) return [];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else value += ch;
			quoted = true;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') {
				quote = undefined;
				continue;
			}
			if (ch === "\\" && i + 1 < command.length) {
				if (";&|<>();$`\n\r".includes(command[i + 1] as string)) return [];
				value += command[++i] as string;
				quoted = true;
				continue;
			}
			value += ch;
			quoted = true;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			quoted = true;
			continue;
		}
		if (ch === "\\") {
			if (i + 1 >= command.length || ";&|<>();$`\n\r".includes(command[i + 1] as string)) return [];
			value += command[++i] as string;
			continue;
		}
		if (ch === " " || ch === "\t") {
			push();
			continue;
		}
		value += ch;
	}
	if (quote !== undefined) return [];
	push();
	return words;
}

function parseSimpleForward(command: string, tool: string): BuiltinForward | undefined {
	const words = tokenizeSimpleShell(command);
	if (!words || words.length < 2) return undefined;
	const executable = words[0]?.value.toLowerCase();
	if (!executable || words[0]?.quoted || words.some(word => word.value.length === 0 && !word.quoted)) return undefined;
	const args = words.slice(1).map(word => word.value);

	if (tool === "read" && executable === "cat") {
		if (args.length !== 1 || !args[0] || args[0].startsWith("-")) return undefined;
		return { tool: "read", input: { path: args[0] } };
	}

	if (tool === "read" && executable === "head") {
		let count: string | undefined;
		if (args[0] === "-n" && args[1]) {
			count = args[1];
			args.splice(0, 2);
		} else if (/^-[0-9]+$/.test(args[0] ?? "")) {
			count = args.shift()?.slice(1);
		}
		if (!count || !/^[0-9]+$/.test(count) || args.length !== 1 || !args[0] || args[0].startsWith("-"))
			return undefined;
		return { tool: "read", input: { path: args[0] }, selector: `1-${count}` };
	}

	if (tool === "grep" && executable === "grep") {
		let caseSensitive = true;
		if (args[0] === "-i") {
			caseSensitive = false;
			args.shift();
		}
		if (args[0] === "--") args.shift();
		if (
			args.length < 1 ||
			args.length > 2 ||
			!args[0] ||
			(args[0].startsWith("-") && args[0] !== "--") ||
			args[1]?.startsWith("-")
		)
			return undefined;
		const input: Record<string, unknown> = { pattern: args[0], case: caseSensitive, gitignore: true };
		if (args[1]) input.path = args[1];
		return { tool: "grep", input };
	}

	if (tool === "glob" && executable === "find") {
		if (
			args.length !== 3 ||
			!args[0] ||
			args[0].startsWith("-") ||
			args[1] !== "-name" ||
			!args[2] ||
			args[2].startsWith("-")
		)
			return undefined;
		return { tool: "glob", input: { path: `${args[0]}/**/${args[2]}`, hidden: true, gitignore: false } };
	}
	return undefined;
}

/**
 * Check if a bash command should be intercepted.
 *
 * @param command The bash command to check
 * @param availableTools Set of tool names that are available
 * @returns InterceptionResult indicating if the command should be blocked
 */
export function checkBashInterception(
	command: string,
	availableTools: string[],
	rules: BashInterceptorRule[] = DEFAULT_BASH_INTERCEPTOR_RULES,
	originalCommand = command,
): InterceptionResult {
	const compiled = compileRules(rules);
	const candidates = interceptionCandidates(command);

	for (const { rule, regex } of compiled) {
		// Only block if the suggested tool is actually available
		if (!availableTools.includes(rule.tool)) {
			continue;
		}

		for (const candidate of candidates) {
			// A configured global or sticky regex carries state across calls.
			regex.lastIndex = 0;
			if (regex.test(candidate)) {
				return {
					block: true,
					message: `Blocked: ${rule.message}\n\nOriginal command: ${originalCommand}`,
					suggestedTool: rule.tool,
					// Only the full command may re-forward. Segment candidates
					// (pipeline stages, `a && b`, stripped `VAR=1` prefixes) stay
					// block-only: their semantics cannot be reproduced by a
					// single built-in tool call.
					forward: candidate === command.trim() ? parseSimpleForward(candidate, rule.tool) : undefined,
				};
			}
		}
	}

	return { block: false };
}
