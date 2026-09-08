import { z } from 'zod';

export const ReviewSchema = z.object({
	comments: z
		.array(
			z.object({
				path: z.string(),
				line: z.number().int(),
				body: z.string(),
			}),
		)
		.default([]),
	resolve: z
		.array(
			z.object({
				id: z.string(),
				reason: z.enum(['Fixed', 'Outdated']),
			}),
		)
		.default([]),
	patches: z
		.array(
			z.object({
				databaseId: z.number().int(),
				body: z.string(),
			}),
		)
		.default([]),
	summary: z.string().default(''),
	prBody: z.string().default(''),
});

export type Review = z.infer<typeof ReviewSchema>;
