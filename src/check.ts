import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

console.log('ok');
