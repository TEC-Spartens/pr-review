import { Octokit } from '@octokit/rest';
import type { Review } from './schema.ts';

const MARKERS = ['<!-- spartans-pr-review -->', '<!-- spartans-opencode-review -->'];
const MARKER = MARKERS[0];
const PR_START = '<!-- Spartans PR review starts here -->';
const PR_END = '<!-- Spartans PR review ends here -->';
const BOT = /spartans-bot|github-actions\[bot\]/i;
const MAX_COMMENTS = 8;

export type ThreadComment = {
	databaseId: number;
	body: string;
	path: string | null;
	line: number | null;
	originalLine: number | null;
	url: string;
	author: string;
};

export type Thread = {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	comments: ThreadComment[];
};

type GraphqlThreads = {
	repository: {
		pullRequest: {
			reviewThreads: {
				nodes: {
					id: string;
					isResolved: boolean;
					isOutdated: boolean;
					comments: {
						nodes: {
							databaseId: number;
							body: string;
							path: string | null;
							line: number | null;
							originalLine: number | null;
							url: string;
							author: { login: string } | null;
						}[];
					};
				}[];
			};
		};
	};
};

const warn = (error: unknown) => console.warn(error instanceof Error ? error.message : String(error));

export const loadThreads = async (octokit: Octokit, owner: string, repo: string, number: number): Promise<Thread[]> => {
	try {
		const data = await octokit.graphql<GraphqlThreads>(
			`query($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					pullRequest(number: $number) {
						reviewThreads(first: 100) {
							nodes {
								id
								isResolved
								isOutdated
								comments(first: 20) {
									nodes {
										databaseId
										body
										path
										line
										originalLine
										url
										author { login }
									}
								}
							}
						}
					}
				}
			}`,
			{ owner, name: repo, number },
		);
		return data.repository.pullRequest.reviewThreads.nodes
			.map((node) => ({
				id: node.id,
				isResolved: node.isResolved,
				isOutdated: node.isOutdated,
				comments: node.comments.nodes
					.filter((comment) => BOT.test(comment.author?.login ?? ''))
					.map((comment) => ({
						databaseId: comment.databaseId,
						body: comment.body,
						path: comment.path,
						line: comment.line,
						originalLine: comment.originalLine,
						url: comment.url,
						author: comment.author?.login ?? '',
					})),
			}))
			.filter((thread) => thread.comments.length > 0);
	} catch (error) {
		warn(error);
		return [];
	}
};

export const applyReview = async (opts: {
	reviewToken: string;
	resolveToken: string;
	owner: string;
	repo: string;
	number: number;
	headSha: string;
	threads: Thread[];
	review: Review;
}) => {
	const reviewApi = new Octokit({ auth: opts.reviewToken });
	const resolveApi = new Octokit({ auth: opts.resolveToken });
	const allowedThreads = new Set(opts.threads.map((thread) => thread.id));
	const allowedComments = new Set(
		opts.threads.flatMap((thread) => thread.comments.map((comment) => comment.databaseId)),
	);

	const comments = opts.review.comments
		.filter((item) => item.path && item.body)
		.map((item) => ({ path: item.path, line: Number(item.line), body: item.body }))
		.filter((item) => Number.isInteger(item.line) && item.line > 0)
		.slice(0, MAX_COMMENTS)
		.map((item) => ({ ...item, side: 'RIGHT' as const }));

	if (comments.length > 0) {
		try {
			await reviewApi.pulls.createReview({
				owner: opts.owner,
				repo: opts.repo,
				pull_number: opts.number,
				commit_id: opts.headSha,
				event: 'COMMENT',
				comments,
			});
		} catch (error) {
			warn(error);
		}
	}

	for (const patch of opts.review.patches) {
		if (!allowedComments.has(patch.databaseId) || !patch.body) continue;
		try {
			await reviewApi.pulls.updateReviewComment({
				owner: opts.owner,
				repo: opts.repo,
				comment_id: patch.databaseId,
				body: patch.body,
			});
		} catch (error) {
			warn(error);
		}
	}

	for (const item of opts.review.resolve) {
		if (!item.id || !allowedThreads.has(item.id)) continue;
		console.log(`resolve ${item.id} ${item.reason}`);
		try {
			await resolveThread(reviewApi, item.id);
		} catch (error) {
			warn(error);
			if (opts.resolveToken === opts.reviewToken) continue;
			try {
				await resolveThread(resolveApi, item.id);
			} catch (fallback) {
				warn(fallback);
			}
		}
	}

	if (opts.review.summary.trim()) {
		try {
			await upsertSticky(reviewApi, opts.owner, opts.repo, opts.number, opts.review.summary.trim());
		} catch (error) {
			warn(error);
		}
	}

	if (opts.review.prBody.trim()) {
		try {
			const { data: pr } = await reviewApi.pulls.get({
				owner: opts.owner,
				repo: opts.repo,
				pull_number: opts.number,
			});
			await reviewApi.pulls.update({
				owner: opts.owner,
				repo: opts.repo,
				pull_number: opts.number,
				body: mergePrBody(pr.body, opts.review.prBody.trim()),
			});
		} catch (error) {
			warn(error);
		}
	}
};

const resolveThread = (octokit: Octokit, id: string) =>
	octokit.graphql(`mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}) { thread { isResolved } } }`, { id });

export const mergePrBody = (existing: string | null | undefined, section: string) => {
	const block = `${PR_START}\n${section}\n${PR_END}`;
	const current = existing ?? '';
	const start = current.indexOf(PR_START);
	const end = current.indexOf(PR_END);
	if (start !== -1 && end !== -1 && end > start) {
		return `${current.slice(0, start)}${block}${current.slice(end + PR_END.length)}`;
	}
	if (!current.trim()) return block;
	return `${current.trimEnd()}\n\n${block}`;
};

const upsertSticky = async (octokit: Octokit, owner: string, repo: string, number: number, summary: string) => {
	const comments = await octokit.paginate(octokit.issues.listComments, {
		owner,
		repo,
		issue_number: number,
	});
	const ours = comments.filter((comment) => MARKERS.some((marker) => comment.body?.includes(marker)));
	const body = `${MARKER}\n${summary}`;
	if (ours.length === 0) {
		await octokit.issues.createComment({ owner, repo, issue_number: number, body });
		return;
	}
	const keep = ours[0];
	await octokit.issues.updateComment({ owner, repo, comment_id: keep.id, body });
	for (const comment of ours) {
		if (comment.id === keep.id) continue;
		try {
			await octokit.issues.deleteComment({ owner, repo, comment_id: comment.id });
		} catch (error) {
			warn(error);
		}
	}
};
