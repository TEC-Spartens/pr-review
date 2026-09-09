import type { ModelMessage } from 'ai';

const KEEP_FULL = 4;
const COMPACT_AFTER = 800;
const KEEP_ALWAYS = new Set(['git_diff', 'changed_files', 'submit_review']);

const outputText = (output: unknown) => {
	if (typeof output === 'string') return output;
	if (output && typeof output === 'object' && 'value' in output) {
		const value = (output as { value: unknown }).value;
		return typeof value === 'string' ? value : JSON.stringify(value);
	}
	return JSON.stringify(output);
};

export const compactMessages = (messages: ModelMessage[]) => {
	const bulky: number[] = [];
	for (const [i, msg] of messages.entries()) {
		if (msg.role !== 'tool' || !Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (part.type !== 'tool-result' || KEEP_ALWAYS.has(part.toolName)) continue;
			if (outputText(part.output).length > COMPACT_AFTER) bulky.push(i);
			break;
		}
	}
	const keep = new Set(bulky.slice(-KEEP_FULL));
	return messages.map((msg, i) => {
		if (msg.role !== 'tool' || keep.has(i) || !Array.isArray(msg.content)) return msg;
		return {
			...msg,
			content: msg.content.map((part) => {
				if (part.type !== 'tool-result' || KEEP_ALWAYS.has(part.toolName)) return part;
				const text = outputText(part.output);
				if (text.length <= COMPACT_AFTER) return part;
				return {
					...part,
					output: {
						type: 'text' as const,
						value: `${part.toolName}: ${text.split('\n').length} lines compacted. Re-read if needed.`,
					},
				};
			}),
		};
	});
};
