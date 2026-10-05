/// <reference types="node" />
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { isGitCommit, appendTrailers } from "./commit.ts";

const trailerFlags = ` -m "" -m $'Co-Authored-By: Model <noreply@pi.dev>\\nGenerated-By: pi 1.0.0'`;

describe("compound shell commands", () => {
	it.each([" && ", " || ", "; ", "\n", " | ", " & "])(
		"keeps trailers on the commit before %j",
		(separator) => {
			const commit = 'git commit -m "fix"';
			const tail = `${separator}git push`;
			expect(appendTrailers(commit + tail, "Model", "1.0.0")).toBe(
				commit + trailerFlags + tail,
			);
		},
	);

	it("does not pass trailers to gh pr create", () => {
		const commit = 'git commit -m "fix"';
		const tail = ' && gh pr create --title "fix" --body "details"';
		expect(appendTrailers(commit + tail, "Model", "1.0.0")).toBe(
			commit + trailerFlags + tail,
		);
	});

	it("rewrites each commit in a chain", () => {
		expect(appendTrailers('git add . && git commit -m "one"; git commit -am "two" && git push', "Model", "1.0.0")).toBe(
			`git add . && git commit -m "one"${trailerFlags}; git commit -am "two"${trailerFlags} && git push`,
		);
	});

	it.each([
		'git commit -m "fix && push; | stuff"',
		"git commit -m 'fix || push; stuff'",
		'git commit -m fix\\;stuff',
		'git commit -m fix\\ ',
		'git commit -m "fix\nbody"',
		'git commit -m "fix \\"quoted\\" && stuff"',
		"git commit -m $'fix \\'quoted\\' && stuff'",
	])("preserves quoted and escaped shell operators: %s", (commit) => {
		expect(appendTrailers(`${commit} && git push`, "Model", "1.0.0")).toBe(
			`${commit}${trailerFlags} && git push`,
		);
	});

	it("inserts trailers before comments", () => {
		expect(appendTrailers('git commit -m "fix" # comment\ngit push', "Model", "1.0.0")).toBe(
			`git commit -m "fix"${trailerFlags} # comment\ngit push`,
		);
	});

	it.each([
		'git commit && gh pr create -m milestone',
		'echo "git commit -m fake"',
		'# git commit -m fake\ngit push',
		'git commit --no-edit; echo -m',
		'git commit -- path-m',
		'git commit > output-m',
		'git commit > -m',
		'git commit -- -m',
		'git commit --author -m',
		'git commit -Skeym',
		'git commit -m',
	])("does not misidentify unrelated text: %s", (command) => {
		expect(isGitCommit(command)).toBe(false);
		expect(appendTrailers(command, "Model", "1.0.0")).toBe(command);
	});

	it.each([
		'git commit -m "$(echo fix)" && git push',
		'git commit -m `echo fix` && git push',
		'cat <<EOF\ngit commit -m fake\nEOF',
		'git commit -m "unterminated',
		'git commit -m "fix" && cat <<EOF\ngit commit -m fake\nEOF',
		'for item in\ngit commit -m fake; do echo "$item"; done',
		'[[ false && git commit -m fake ]]',
		'git commit -m "fix" >',
	])("leaves unsupported or malformed syntax unchanged: %s", (command) => {
		expect(appendTrailers(command, "Model", "1.0.0")).toBe(command);
	});
});

describe("shell argument handling", () => {
	it.each([
		['git commit -m "fix" >output && git push', `git commit -m "fix"${trailerFlags} >output && git push`],
		['git commit -m "fix" 2>&1 && git push', `git commit -m "fix"${trailerFlags} 2>&1 && git push`],
		['git commit -m "fix" -- file && git push', `git commit -m "fix"${trailerFlags} -- file && git push`],
		['git commit >output -m "fix" && git push', `git commit >output -m "fix"${trailerFlags} && git push`],
		['git commit -m "fix"&&git push', `git commit -m "fix"${trailerFlags}&&git push`],
		['git commit \\\n-m "fix" && git push', `git commit \\\n-m "fix"${trailerFlags} && git push`],
		['git commit --message="fix" && git push', `git commit --message="fix"${trailerFlags} && git push`],
		['git commit --message "fix" && git push', `git commit --message "fix"${trailerFlags} && git push`],
		['git commit -m "fix\\nbody" && git push', `git commit -m "fix\\nbody"${trailerFlags} && git push`],
	])("rewrites %s", (command, expected) => {
		expect(appendTrailers(command, "Model", "1.0.0")).toBe(expected);
	});
});

describe("commit command prefixes", () => {
	it.each([
		'git -c core.hooksPath=/dev/null commit -m "example"',
		'SKIP=tf-fmt git commit -m "example"',
		'SKIP=tf-fmt NOTE="two words" git -c core.hooksPath=/dev/null -C "repo path" commit -m "example"',
		'git -C "repo path" commit -m "example"',
		"git -C 'repo path' commit -m example",
		'git -C repo\\ path commit -m "example"',
		'git -C"repo path" -ccore.hooksPath=/dev/null commit -m "example"',
		'git -C commit -c alias.example=commit commit -m "example"',
		'EMPTY= _NOTE=ok git -C . -C . -c "core.hooksPath=/dev/null" commit -m "example"',
	])("recognizes and rewrites %s", (command) => {
		expect(isGitCommit(command)).toBe(true);
		expect(appendTrailers(command, "Model", "1.0.0")).toBe(command + trailerFlags);
	});

	it("keeps prefixed commits separate from surrounding commands", () => {
		const prefix = 'git add file && ';
		const commit = 'SKIP=tf-fmt git -c core.hooksPath=/dev/null commit -m "example"';
		const tail = ' && git push && gh pr create --title "example"';
		expect(appendTrailers(prefix + commit + tail, "Model", "1.0.0")).toBe(
			prefix + commit + trailerFlags + tail,
		);
	});

	it.each([
		'git -c',
		'git -C',
		'git -c commit -m "example"',
		'git -C commit -m "example"',
		'git -c alias.example=commit status -m "example"',
		'git --unknown commit -m "example"',
		'git --unknown commit commit -m "example"',
		'git --version commit -m "example"',
		'env SKIP=tf-fmt git commit -m "example"',
		'echo SKIP=tf-fmt git commit -m "example"',
		'"SKIP=tf-fmt" git commit -m "example"',
		'SKIP\\=tf-fmt git commit -m "example"',
		'1SKIP=tf-fmt git commit -m "example"',
		'SKIP=$(echo tf-fmt) git commit -m "example"',
		'git -C "$(pwd)" commit -m "example"',
		'git -C "unterminated commit -m example',
		'(SKIP=tf-fmt git commit -m "example")',
		'if true; then SKIP=tf-fmt git commit -m "example"; fi',
		'cat <<EOF\nSKIP=tf-fmt git commit -m "example"\nEOF',
	])("leaves unsupported or unrelated commands unchanged: %s", (command) => {
		expect(isGitCommit(command)).toBe(false);
		expect(appendTrailers(command, "Model", "1.0.0")).toBe(command);
	});
});

describe.each([
	'git',
	'SKIP=tf-fmt NOTE="two words" git -C "." -c core.hooksPath=/dev/null',
])("shell execution: %s", (prefix) => {
	it.each(["Model", "Model's \\n $(printf injected)"])("attributes the commit without changing push or PR arguments (%s)", (model) => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-co-authored-by-"));
		const options = {
			cwd,
			encoding: "utf8" as const,
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_AUTHOR_NAME: "Test",
				GIT_AUTHOR_EMAIL: "test@example.com",
				GIT_COMMITTER_NAME: "Test",
				GIT_COMMITTER_EMAIL: "test@example.com",
			},
		};
		try {
			execFileSync("git", ["init", "--quiet"], options);
			const command = appendTrailers(
				`${prefix} commit --allow-empty -qm "fix" && git push origin main && gh pr create --title "fix" --body "details"`,
				model,
				"1.0.0",
			);
			const output = execFileSync("bash", ["-c", `
				git() {
					if [[ "$1" == push ]]; then printf 'git'; printf ' [%s]' "$@"; printf '\\n';
					else command git "$@"; fi
				}
				gh() { printf 'gh'; printf ' [%s]' "$@"; printf '\\n'; }
				${command}
			`], options);
			expect(output).toBe("git [push] [origin] [main]\ngh [pr] [create] [--title] [fix] [--body] [details]\n");
			expect(execFileSync("git", ["log", "-1", "--format=%B"], options).trimEnd()).toBe(
				`fix\n\nCo-Authored-By: ${model} <noreply@pi.dev>\nGenerated-By: pi 1.0.0`,
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe("isGitCommit", () => {
	it("detects git commit -m", () => {
		expect(isGitCommit('git commit -m "fix bug"')).toBe(true);
	});

	it("detects git commit -am", () => {
		expect(isGitCommit('git commit -am "fix bug"')).toBe(true);
	});

	it("detects git commit with flags before -m", () => {
		expect(isGitCommit('git commit --allow-empty -m "init"')).toBe(true);
	});

	it("detects git commit with flags after -m", () => {
		expect(isGitCommit('git commit -m "msg" --no-verify')).toBe(true);
	});

	it("detects git commit -m without space before value", () => {
		expect(isGitCommit('git commit -m"no space"')).toBe(true);
	});

	it("detects git commit with line continuation", () => {
		expect(isGitCommit('git commit \\\n-m "msg"')).toBe(true);
	});

	it("rejects interactive git commit (no -m)", () => {
		expect(isGitCommit("git commit")).toBe(false);
	});

	it("rejects git commit --amend without -m", () => {
		expect(isGitCommit("git commit --amend")).toBe(false);
	});

	it("rejects non-commit git commands", () => {
		expect(isGitCommit("git log --oneline")).toBe(false);
	});

	it("rejects git status", () => {
		expect(isGitCommit("git status")).toBe(false);
	});

	it("rejects git push", () => {
		expect(isGitCommit("git push origin main")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isGitCommit("")).toBe(false);
	});

	it("detects git commit --amend -m (amend with new message)", () => {
		expect(isGitCommit('git commit --amend -m "new msg"')).toBe(true);
	});

	it("detects git commit with -S (signed) and -m", () => {
		expect(isGitCommit('git commit -S -m "signed commit"')).toBe(true);
	});
});

describe("appendTrailers", () => {
	it("appends trailers to a simple commit command", () => {
		const result = appendTrailers(
			'git commit -m "fix bug"',
			"Claude Sonnet 4",
			"0.52.12",
		);
		expect(result).toBe(
			`git commit -m "fix bug" -m "" -m $'Co-Authored-By: Claude Sonnet 4 <noreply@pi.dev>\\nGenerated-By: pi 0.52.12'`,
		);
	});

	it("inserts trailers before trailing whitespace", () => {
		const result = appendTrailers(
			'git commit -m "fix"   ',
			"Claude Sonnet 4",
			"0.52.12",
		);
		expect(result).toMatch(/^git commit -m "fix" -m/);
		expect(result).not.toMatch(/\s{2,}-m ""/);
	});

	it("includes model name in Co-Authored-By", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"Gemini 2.5 Pro",
			"1.0.0",
		);
		expect(result).toContain("Co-Authored-By: Gemini 2.5 Pro <noreply@pi.dev>");
	});

	it("includes pi version in Generated-By", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"Some Model",
			"1.2.3",
		);
		expect(result).toContain("Generated-By: pi 1.2.3");
	});

	it("uses $'' quoting for the trailer block", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"Model",
			"1.0.0",
		);
		// The trailers should be in a single $'...' string with \\n separator
		expect(result).toMatch(/-m \$'Co-Authored-By:.*\\nGenerated-By:.*'/);
	});

	it("handles model name with special characters", () => {
		const result = appendTrailers(
			'git commit -m "msg"',
			"openai/gpt-4o",
			"0.50.0",
		);
		expect(result).toContain("Co-Authored-By: openai/gpt-4o <noreply@pi.dev>");
	});
});
