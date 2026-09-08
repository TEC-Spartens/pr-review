import { isStepCount, ToolLoopAgent, wrapLanguageModel, extractReasoningMiddleware, type StepResult, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { Octokit } from '@octokit/rest';
import type { Review } from './schema.ts';
import { applyReview, loadThreads } from './github.ts';
import { createTools, type Workspace } from './tools.ts';

const required = (key: string) => {
	const value = process.env[key];
	if (!value) throw new Error(`${key} is required`);
	return value;
};

const v1Url = (raw: string) => {
	const trimmed = raw.replace(/\/+$/, '');
	return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
};

const callSignature = (name: string, input: unknown) =>
	`${name}:${JSON.stringify(input, (_key, value: unknown) =>
		value && typeof value === 'object' && !Array.isArray(value)
			? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
			: value,
	)}`;

const isDoomLoop = (steps: StepResult<ToolSet>[]) => {
	const counts = new Map<string, number>();
	for (const call of steps.flatMap((step) => step.toolCalls)) {
		const sig = callSignature(call.toolName, call.input);
		const n = (counts.get(sig) ?? 0) + 1;
		if (n >= 3) return true;
		counts.set(sig, n);
	}
	return false;
};

const SYSTEM = `You review a GitHub pull request. You have no shell, no GitHub token, and you must not edit the repo.

Tools: git_diff, read_file, grep, glob, submit_review.
Start with git_diff. Findings come from the diff. Use read/grep/glob only to check callers and existing logic. grep is exact — empty means not found.

Skip linter nits (formatting, import order, class-name order). Report real bugs, regressions, missing tests, or security. Cap 8 new comments.

Our threads are in the user message (id = GraphQL thread id, databaseId = REST comment id). Ignore other reviewers.
Never delete a review comment. Never edit a comment just to mark it done. Never re-post a finding that already has an open thread.
- Fixed: put {id, reason: Fixed} in resolve.
- Line gone or no longer applies: {id, reason: Outdated}.
- Still right: leave it.
- Still right, stale text: patches[{databaseId, body}].

New comments (HEAD line, side RIGHT):
**Medium** \`path:line\`
One short paragraph.
\`\`\`suggestion
exact replacement lines
\`\`\`
Severity High, Medium, or Low.

summary: under 120 words — what you reviewed, open count, resolved count.
prBody: our section only. Do not repeat the author's description. No test plan. List every real change as bullets — grouped points, not file-by-file nits. Skip noise. End with:
Risk: Low|Medium|High — one short clause only if there's a risk.

Call submit_review exactly once when done.`;

const env = {
	baseUrl: v1Url(required('OPENAI_BASE_URL')),
	apiKey: required('OPENAI_API_KEY'),
	model: process.env.OPENAI_MODEL || 'ai-model',
	reviewToken: required('REVIEW_TOKEN'),
	resolveToken: process.env.RESOLVE_TOKEN || required('REVIEW_TOKEN'),
	repository: required('GITHUB_REPOSITORY'),
	prNumber: Number(required('PR_NUMBER')),
	baseSha: required('BASE_SHA'),
	headSha: required('HEAD_SHA'),
	extraPrompt: process.env.EXTRA_PROMPT ?? '',
	maxSteps: Number(process.env.MAX_STEPS ?? 16),
	workspace: process.env.WORKSPACE || process.cwd(),
	harnessDir: process.env.HARNESS_DIR || '.pr-review',
};

const [owner, repo] = env.repository.split('/');
if (!owner || !repo) throw new Error(`bad GITHUB_REPOSITORY: ${env.repository}`);
if (!Number.isInteger(env.prNumber) || env.prNumber <= 0) throw new Error('bad PR_NUMBER');

const reviewApi = new Octokit({ auth: env.reviewToken });
const threads = await loadThreads(reviewApi, owner, repo, env.prNumber);

const ws: Workspace = { root: env.workspace, baseSha: env.baseSha, harnessDir: env.harnessDir };
let submitted: Review | undefined;
const tools = createTools(ws, (review) => {
	submitted = review;
});

const provider = createOpenAICompatible({
	name: 'openai',
	baseURL: env.baseUrl,
	apiKey: env.apiKey,
	includeUsage: true,
	supportsStructuredOutputs: true,
});

const model = wrapLanguageModel({
	model: provider.chatModel(env.model),
	middleware: extractReasoningMiddleware({ tagName: 'think' }),
});

const maxSteps = Number.isFinite(env.maxSteps) && env.maxSteps > 0 ? env.maxSteps : 16;

const agent = new ToolLoopAgent({
	model,
	instructions: SYSTEM,
	tools,
	temperature: 0.2,
	stopWhen: [isStepCount(maxSteps), () => submitted !== undefined, ({ steps }) => isDoomLoop(steps)],
	prepareStep: ({ stepNumber, steps, messages }) => {
		const forced =
			stepNumber >= maxSteps - 1
				? 'Step budget reached'
				: isDoomLoop(steps)
					? 'Repeated identical tool calls'
					: undefined;
		if (!forced) return undefined;
		return {
			activeTools: ['submit_review'] as ['submit_review'],
			messages: [
				...messages,
				{ role: 'user' as const, content: `${forced}. Call submit_review now with what you have.` },
			],
		};
	},
	onStepEnd: (step) => {
		console.log(
			`step=${step.stepNumber} in=${step.usage.inputTokens ?? 0} out=${step.usage.outputTokens ?? 0} tools=${step.toolCalls.map((call) => call.toolName).join(',') || 'none'}`,
		);
	},
});

const prompt = [
	env.extraPrompt,
	`PR ${owner}/${repo}#${env.prNumber}`,
	`base ${env.baseSha}  head ${env.headSha}`,
	'Existing review threads (ours only):',
	JSON.stringify(threads),
]
	.filter(Boolean)
	.join('\n\n');

try {
	await agent.generate({ prompt });
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}

if (!submitted) {
	console.log('no submit_review; posting nothing');
	process.exit(0);
}

await applyReview({
	reviewToken: env.reviewToken,
	resolveToken: env.resolveToken,
	owner,
	repo,
	number: env.prNumber,
	headSha: env.headSha,
	threads,
	review: submitted,
});
