/**
 * Pure logic for detecting and rewriting git commit commands with trailers.
 * Separated from the pi extension API for testability.
 */

type Token = { text: string; start: number; end: number; operator: boolean };

function tokenize(cmd: string): Token[] | undefined {
	const tokens: Token[] = [];
	let start = -1;
	let quote = "";
	let ansiQuote = false;
	const finishWord = (end: number) => {
		if (start < 0) return;
		tokens.push({ text: cmd.slice(start, end).replace(/\\\n/g, ""), start, end, operator: false });
		start = -1;
	};

	for (let i = 0; i < cmd.length; i++) {
		const char = cmd[i];
		if (char === "\\" && (quote !== "'" || ansiQuote)) {
			if (i + 1 === cmd.length) return;
			if (start < 0 && cmd[i + 1] !== "\n") start = i;
			i++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else if (quote === '"' && (char === "`" || (char === "$" && /[({]/.test(cmd[i + 1] ?? "")))) return;
			continue;
		}
		if (char === "#" && start < 0) {
			while (i + 1 < cmd.length && cmd[i + 1] !== "\n") i++;
			continue;
		}
		// Do not interpret nested shell syntax or heredoc contents as commands.
		if (/[`(){}]/.test(char) || cmd.startsWith("<<", i)) return;
		if (char === "'" || char === '"' || cmd.startsWith("$'", i)) {
			ansiQuote = char === "$";
			quote = ansiQuote ? "'" : char;
			if (start < 0) start = i;
			if (ansiQuote) i++;
			continue;
		}
		const operator = cmd.slice(i).match(/^(?:&&|\|\||\|&|&>>|&>|>>|>&|<&|<>|>\||[;&|\n<>])/);
		if (operator) {
			finishWord(i);
			const text = operator[0];
			tokens.push({ text, start: i, end: i + text.length, operator: true });
			i += text.length - 1;
		} else if (char === " " || char === "\t" || char === "\r") {
			finishWord(i);
		} else if (start < 0) {
			start = i;
		}
	}
	if (quote) return;
	finishWord(cmd.length);
	return tokens;
}

const valueOptions = new Set([
	"-F", "--file", "-C", "--reuse-message", "-c", "--reedit-message",
	"-t", "--template", "--author", "--date", "--cleanup", "--fixup",
	"--squash", "--trailer", "--pathspec-from-file", "-U", "--unified",
	"--inter-hunk-context",
]);

function commitIndex(words: Token[]): number {
	let i = 0;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]?.text ?? "")) i++;
	if (words[i++]?.text !== "git") return -1;
	while (i < words.length) {
		const text = words[i].text;
		if (text === "commit") return i;
		if (text === "-c" || text === "-C") {
			if (!words[i + 1]) return -1;
			i += 2;
		} else if (/^-[cC].+/.test(text)) {
			i++;
		} else {
			return -1;
		}
	}
	return -1;
}

function commitInsertions(cmd: string): number[] {
	const tokens = tokenize(cmd);
	if (!tokens) return [];
	const insertions: number[] = [];
	let words: Token[] = [];
	let unsupported = false;
	const finishCommand = () => {
		if (/^(?:for|select|case|if|then|elif|else|fi|while|until|do|done|in|esac|function|\[\[|\]\])$/.test(words[0]?.text ?? "")) unsupported = true;
		const index = commitIndex(words);
		if (index >= 0) {
			let hasMessage = false;
			let end = words[index].end;
			for (let i = index + 1; i < words.length; i++) {
				const word = words[i];
				if (word.text === "--") break;
				end = word.end;
				if (word.text.startsWith("--message=") || /^-[apqsvenio]*m.+/.test(word.text)) {
					hasMessage = true;
				} else if (word.text === "--message" || /^-[apqsvenio]*m$/.test(word.text)) {
					if (words[i + 1]) {
						hasMessage = true;
						end = words[++i].end;
					}
				} else if (valueOptions.has(word.text) && words[i + 1]) {
					end = words[++i].end;
				}
			}
			if (hasMessage) insertions.push(end);
		}
		words = [];
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!token.operator) {
			words.push(token);
		} else if (/[<>]/.test(token.text)) {
			const previous = words[words.length - 1];
			if (previous?.end === token.start && /^\d+$/.test(previous.text)) words.pop();
			if (!tokens[i + 1] || tokens[i + 1].operator) return [];
			i++;
		} else {
			finishCommand();
		}
	}
	finishCommand();
	return unsupported ? [] : insertions;
}

/** Check if a command is a `git commit` with a -m message flag. */
export function isGitCommit(cmd: string): boolean {
	return commitInsertions(cmd).length > 0;
}

/** Build the rewritten command with Co-Authored-By and Generated-By trailers. */
export function appendTrailers(cmd: string, modelName: string, piVersion: string): string {
	const insertions = commitInsertions(cmd);
	if (!insertions.length) return cmd;
	const escape = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
	const trailers = `Co-Authored-By: ${escape(modelName)} <noreply@pi.dev>\\nGenerated-By: pi ${escape(piVersion)}`;
	let result = cmd;
	for (const position of insertions.reverse()) {
		result = `${result.slice(0, position)} -m "" -m $'${trailers}'${result.slice(position)}`;
	}
	return result;
}
