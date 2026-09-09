import { relative, resolve, sep } from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { ReviewSchema, type Review } from './schema.ts';

const READ_CAP = 40_000;
const READ_LINES = 200;
const GREP_HITS = 80;
const GREP_BYTES = 20_000;
const DIFF_CAP = 120_000;
const GLOB_CAP = 50;
const IGNORED = new Set(['.git', 'node_modules', '.pr-review']);

export type Workspace = {
	root: string;
	baseSha: string;
	harnessDir: string;
};

export class PathEscapeError extends Error {
	constructor(input: string) {
		super(`path escapes workspace: ${input}`);
		this.name = 'PathEscapeError';
	}
}

const isIgnored = (rel: string) => rel.split(sep).some((part) => IGNORED.has(part));

export const resolveInWorkspace = (root: string, input: string) => {
	const abs = resolve(root, input);
	const rel = relative(root, abs);
	if (rel.startsWith('..') || abs !== resolve(root, rel)) throw new PathEscapeError(input);
	if (isIgnored(rel)) throw new PathEscapeError(input);
	return abs;
};

const truncate = (text: string, cap: number) =>
	text.length <= cap ? text : `${text.slice(0, cap)}\n… truncated ${text.length - cap} bytes`;

const numbered = (text: string, startLine: number) =>
	text
		.split('\n')
		.map((line, i) => `${String(startLine + i).padStart(6)}|${line}`)
		.join('\n');

const run = async (cmd: string[], cwd: string, cap: number) => {
	const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && !stdout) return stderr.trim() || `exit ${exitCode}`;
	return truncate(stdout || stderr, cap);
};

export const gitDiff = async (ws: Workspace) => {
	const out = await run(
		['git', 'diff', '-U20', ws.baseSha, 'HEAD', '--', '.', `:(exclude)${ws.harnessDir}`],
		ws.root,
		DIFF_CAP,
	);
	return out || '(empty diff)';
};

export const changedFiles = async (ws: Workspace) => {
	const out = await run(
		['git', 'diff', '--name-only', ws.baseSha, 'HEAD', '--', '.', `:(exclude)${ws.harnessDir}`],
		ws.root,
		20_000,
	);
	return out || '(no files)';
};

export const readFile = async (ws: Workspace, inputPath: string, offset?: number, limit?: number) => {
	const abs = resolveInWorkspace(ws.root, inputPath);
	const file = Bun.file(abs);
	if (!(await file.exists())) return `not found: ${inputPath}`;
	if (file.size > READ_CAP * 4) return `file too large (${file.size} bytes)`;
	const raw = await file.text();
	const lines = raw.split('\n');
	const start = Math.max((offset ?? 1) - 1, 0);
	const take = limit ?? READ_LINES;
	const slice = lines.slice(start, start + take);
	const body = truncate(numbered(slice.join('\n'), start + 1), READ_CAP);
	if (start + take < lines.length) return `${body}\n… ${lines.length - start - take} more lines; pass offset/limit`;
	return body;
};

export const grep = async (ws: Workspace, pattern: string, path?: string) => {
	if (path) resolveInWorkspace(ws.root, path);
	const target = path ?? '.';
	const rg = Bun.which('rg');
	const out = rg
		? await run(
				[
					rg,
					'-n',
					'-I',
					'--hidden',
					'--no-heading',
					'--max-count',
					String(GREP_HITS),
					'--max-filesize',
					'1M',
					'--glob',
					'!.git',
					'--glob',
					'!node_modules',
					'--glob',
					`!${ws.harnessDir}`,
					'-e',
					pattern,
					target,
				],
				ws.root,
				GREP_BYTES,
			)
		: await run(
				['git', 'grep', '-n', '-I', '-E', '-e', pattern, '--', target, `:(exclude)${ws.harnessDir}`],
				ws.root,
				GREP_BYTES,
			);
	return out || '(no matches)';
};

export const globFiles = async (ws: Workspace, pattern: string) => {
	const glob = new Bun.Glob(pattern);
	const hits: string[] = [];
	for await (const file of glob.scan({ cwd: ws.root, dot: false, onlyFiles: true })) {
		if (isIgnored(file)) continue;
		hits.push(file);
		if (hits.length >= GLOB_CAP) {
			hits.push('… truncated');
			break;
		}
	}
	return hits.join('\n') || '(no matches)';
};

export const createTools = (ws: Workspace, onSubmit: (review: Review) => void) => ({
	git_diff: tool({
		description:
			'Unified diff of this PR vs the target branch (−U20). Start here. Findings come from this diff.',
		inputSchema: z.object({}),
		execute: async () => gitDiff(ws),
	}),
	changed_files: tool({
		description: 'Paths changed in this PR. Use before globbing the rest of the repo.',
		inputSchema: z.object({}),
		execute: async () => changedFiles(ws),
	}),
	read_file: tool({
		description: 'Read a workspace file with line numbers. Defaults to 200 lines. Pass 1-based offset and limit to page.',
		inputSchema: z.object({
			path: z.string(),
			offset: z.number().int().positive().optional(),
			limit: z.number().int().positive().optional(),
		}),
		execute: async ({ path, offset, limit }) => {
			try {
				return await readFile(ws, path, offset, limit);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	}),
	grep: tool({
		description:
			'Search file contents. Returns path:line hits only. Exact regex, no fuzzy fallback. Optional path prefix. Use to check callers of symbols in the diff.',
		inputSchema: z.object({
			pattern: z.string(),
			path: z.string().optional(),
		}),
		execute: async ({ pattern, path }) => {
			try {
				return await grep(ws, pattern, path);
			} catch (error) {
				return error instanceof Error ? error.message : String(error);
			}
		},
	}),
	glob: tool({
		description: 'List files matching a glob. Prefer changed_files for this PR. Does not search harness or node_modules.',
		inputSchema: z.object({ pattern: z.string() }),
		execute: async ({ pattern }) => globFiles(ws, pattern),
	}),
	submit_review: tool({
		description:
			'Finish. Call once. comments = new findings only (HEAD line numbers). resolve = our open thread ids that are Fixed or Outdated. patches = REST databaseId + new body for stale-but-valid comments. summary ≤120 words. prBody = bullets for every real change (not line-by-line nits), then Risk: Low|Medium|High — short clause only if there\'s a risk.',
		inputSchema: ReviewSchema,
		execute: async (input) => {
			if (!input.summary.trim() || !input.prBody.trim()) {
				return { ok: false, error: 'Need non-empty summary and prBody. Call submit_review again with both filled.' };
			}
			onSubmit(input);
			return { ok: true };
		},
	}),
});
