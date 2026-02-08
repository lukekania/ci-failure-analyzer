# CI Failure Analyzer

CI Failure Analyzer is a GitHub Action that explains CI failures and optionally tracks recurring failure patterns — all in a single action.

Instead of running `explain-ci-failure` and `detect-failure-pattern` as separate steps with piped context, you get one action that does both.

---

## What It Does

For failed workflow runs, the action:

1. Detects failed jobs
2. Downloads job logs (ZIP or plain text)
3. Identifies the first meaningful error
4. Classifies the failure type (ESLint, TypeScript, Jest, Docker, etc.)
5. Writes a concise explanation to GitHub Actions Step Summary
6. Optionally posts a PR comment
7. Optionally tracks the failure as a pattern issue (with severity, auto-close, and JSON export)

---

## Example Output

### CI Failure Analyzer

#### Failed job: test-and-build

- Failing step: **Run npm run lint**
- Detected type: **ESLint**
- First error:
  `src/foo.ts:<line>:<col> error Unexpected any`
- Likely fix: Run the linter locally and apply the suggested fix.
- Tracking issue: https://github.com/org/repo/issues/123

---

## Usage

### Basic (explain only)

```yaml
jobs:
  test-and-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test

  explain:
    needs: [test-and-build]
    if: ${{ always() && needs.test-and-build.result == 'failure' }}
    runs-on: ubuntu-latest
    steps:
      - name: Explain CI failure
        uses: lukekania/explain-ci-failure@v1.0.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

### With pattern tracking

```yaml
      - name: Analyze CI failure
        uses: lukekania/explain-ci-failure@v1.0.0
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          comment_on_pr: true
          track_patterns: true
          quiet_days: 30
```

---

## Supported Error Types

- ESLint
- TypeScript (tsc)
- npm / pnpm / yarn
- Jest / Vitest
- Vite / Webpack builds
- Docker build failures
- Generic Node.js runtime errors
- pytest / mypy / ruff / flake8 / pip (Python)
- go test / golangci-lint / go build (Go)
- javac / Maven / Gradle / JUnit (Java)

If no rule matches, the action falls back to a generic error detector.

---

## Configuration

### Detection

| Input | Default | Description |
|-------|---------|-------------|
| comment_on_pr | false | Post failure summary as a PR comment |
| json_output | false | Export failures as JSON via `failures_json` output |
| runbook_url | | Base URL for runbook links |
| custom_rules | | JSON array of custom detection rules |
| flaky_detection | false | Detect likely flaky tests |
| flaky_lookback | 10 | Recent workflow runs to check for flaky detection |
| suggest_reviewers | false | Suggest reviewers based on failing files |
| deploy_risk | false | Show deploy-risk level |
| max_failed_jobs | 5 | Maximum failed jobs to analyze |

### Pattern Tracking

| Input | Default | Description |
|-------|---------|-------------|
| track_patterns | false | Track recurring failures as GitHub Issues |
| issue_repo | current repo | Repo to store pattern issues (`owner/repo`) |
| issue_label | ci-failure-pattern | Label for pattern-tracking issues |
| quiet_days | 0 | Auto-close issues with no occurrences for N days |
| export_json | false | Export all patterns as JSON via `patterns_json` output |
| notify_threshold | 0 | Label issue when occurrence count reaches this value |
| explainer_context | | Additional context to include in pattern issues |

### Deprecated Aliases

| Input | Replacement |
|-------|-------------|
| check_patterns | track_patterns |
| pattern_label | issue_label |

---

## Outputs

| Output | Description |
|--------|-------------|
| failures_json | JSON array of failure details (when `json_output` is enabled) |
| patterns_json | JSON array of tracked patterns (when `export_json` is enabled) |

---

## Migration from Individual Actions

CI Failure Analyzer replaces two separate actions:

- `explain-ci-failure` — all detection features carry over as-is
- `detect-failure-pattern` — now activated via `track_patterns: true`

The `explainer_context` input is no longer needed for piping between actions (explanation and tracking happen in the same pass), but it is kept for external use.

On first run, old comments from the individual actions are automatically cleaned up.

---

## Design Principles

- Zero configuration for basic use
- Heuristics over ML
- Explain the first error, not every error
- One action replaces two workflow steps
- Pattern issues use GitHub as a lightweight database

---

## Known Limitations

- Step detection is log-based and best effort
- Normalization is heuristic and imperfect
- Large logs may hide the true first error
- No deep root-cause analysis

---

## License

MIT
