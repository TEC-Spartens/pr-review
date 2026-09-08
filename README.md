# pr-review

Locked PR review loop for TEC repos. The model gets `git_diff`, `read_file`, `grep`, `glob`, and `submit_review`. It never gets a shell or a GitHub token. The host posts the review as Spartans-Bot and resolves threads with `GITHUB_TOKEN`.

Any OpenAI-compatible `/v1` endpoint works. Point `OPENAI_BASE_URL` / `OPENAI_API_KEY` at whatever you have — LLM gateway, vLLM, OpenAI, Azure.

```yaml
jobs:
  review:
    uses: TEC-Spartens/pr-review/.github/workflows/review.yml@main
    secrets:
      OPENAI_BASE_URL: ${{ secrets.LLM_GATEWAY_URL }}
      OPENAI_API_KEY: ${{ secrets.LLM_GATEWAY_API_KEY }}
      SPARTANS_BOT_PRIVATE_KEY: ${{ secrets.SPARTANS_BOT_PRIVATE_KEY }}
    permissions:
      contents: write
      pull-requests: write
      issues: write
    with:
      runner: ubuntu-latest
      model: ai-model
      extra_prompt: ''
```

Map the caller’s own secret names into `OPENAI_BASE_URL` and `OPENAI_API_KEY`. The URL can be an origin or already end in `/v1`. Install the Spartans-Bot GitHub App on the repo.

For a private harness, allow org Actions access on this repo (Settings → Actions → Accessible from repositories in the organization). Pin both the workflow ref and `harness_ref` to the same SHA or tag.

The job skips drafts, forks, and `skip-ci` in the PR title or commit message. It does not run the target repo's tests or change its files.
