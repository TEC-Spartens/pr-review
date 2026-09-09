import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelMessage } from 'ai';
import { compactMessages } from './compact.ts';
import { mergePrBody } from './github.ts';
import { PathEscapeError, readFile, resolveInWorkspace } from './tools.ts';

const root = await mkdtemp(join(tmpdir(), 'pr-review-'));
await mkdir(join(root, 'src'), { recursive: true });
await writeFile(join(root, 'src', 'ok.ts'), 'export const n = 1;\n');

const abs = resolveInWorkspace(root, 'src/ok.ts');
if (!abs.endsWith('src/ok.ts')) throw new Error(`expected jailed path, got ${abs}`);

const text = await readFile({ root, baseSha: 'HEAD', harnessDir: '.pr-review' }, 'src/ok.ts');
if (!text.includes('export const n = 1')) throw new Error(`read_file missed contents: ${text}`);
if (!text.includes('1|')) throw new Error(`read_file missed line numbers: ${text}`);

for (const input of ['../etc/passwd', '..', '/etc/passwd', 'src/../../etc/passwd', '.git/config', 'node_modules/x']) {
	let threw = false;
	try {
		resolveInWorkspace(root, input);
	} catch (error) {
		threw = error instanceof PathEscapeError;
	}
	if (!threw) throw new Error(`expected PathEscapeError for ${input}`);
}

const user = '## Summary\n\n- author note';
const first = mergePrBody(user, '### Bot\n- finding');
if (!first.startsWith('## Summary') || !first.includes('<!-- Spartans PR review starts here -->')) {
	throw new Error(`merge should append: ${first}`);
}
const second = mergePrBody(first, '### Bot\n- updated');
if (second.split('## Summary').length !== 2 || second.includes('- finding') || !second.includes('- updated')) {
	throw new Error(`merge should replace our block only: ${second}`);
}

const blob = 'x'.repeat(900);
const toolMsg = (id: string, body: string): ModelMessage => ({
	role: 'tool',
	content: [
		{
			type: 'tool-result',
			toolCallId: id,
			toolName: 'read_file',
			output: { type: 'text', value: body },
		},
	],
});
const packed = compactMessages([toolMsg('a', blob), toolMsg('b', blob), toolMsg('c', blob)]);
const texts = packed.map((msg) =>
	msg.role === 'tool' && Array.isArray(msg.content) && msg.content[0]?.type === 'tool-result'
		? outputPreview(msg.content[0].output)
		: '',
);
if (texts[0].includes('compacted') || texts[1] !== blob || texts[2] !== blob) {
	throw new Error(`compact should keep last 4 reads: ${texts.map((t) => t.slice(0, 40)).join(' | ')}`);
}
const extra = compactMessages([
	{
		role: 'tool',
		content: [
			{
				type: 'tool-result',
				toolCallId: 'd',
				toolName: 'git_diff',
				output: { type: 'text', value: blob },
			},
		],
	},
	toolMsg('e', blob),
	toolMsg('f', blob),
	toolMsg('g', blob),
	toolMsg('h', blob),
	toolMsg('i', blob),
]);
const diffKept =
	extra[0]?.role === 'tool' &&
	Array.isArray(extra[0].content) &&
	extra[0].content[0]?.type === 'tool-result' &&
	outputPreview(extra[0].content[0].output) === blob;
if (!diffKept) throw new Error('git_diff must not be compacted');
const firstRead = extra[1];
const firstReadText =
	firstRead?.role === 'tool' && Array.isArray(firstRead.content) && firstRead.content[0]?.type === 'tool-result'
		? outputPreview(firstRead.content[0].output)
		: '';
if (!firstReadText.includes('compacted')) throw new Error('oldest extra read should compact');

console.log('ok');

function outputPreview(output: unknown) {
	if (output && typeof output === 'object' && 'value' in output) return String((output as { value: unknown }).value);
	return String(output);
}
