const github = require("@actions/github");

const RUNBOOK_SLUGS = {
  ESLint: "eslint",
  TypeScript: "typescript",
  npm: "npm",
  "Jest/Vitest": "jest",
  Build: "build",
  Docker: "docker",
  Node: "node",
  pytest: "pytest",
  mypy: "mypy",
  "ruff/flake8": "ruff",
  pip: "pip",
  Go: "go",
  Java: "java",
  Maven: "maven",
  Gradle: "gradle",
  JUnit: "junit",
  Generic: "generic"
};

// -------------------- Step detection --------------------

function buildStepIndex(lines) {
  const stepStarts = [];
  let current = "Unknown step";

  const groupRun = /^.*##\[group\]Run\s+(.+)\s*$/;
  const groupStep = /^.*##\[group\]Step:\s+(.+)\s*$/;
  const groupName = /^.*##\[group\](.+)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    let m = l.match(groupStep);
    if (m) {
      current = m[1].trim();
      stepStarts.push({ idx: i, name: current });
      continue;
    }

    m = l.match(groupRun);
    if (m) {
      current = `Run ${m[1].trim()}`;
      stepStarts.push({ idx: i, name: current });
      continue;
    }

    m = l.match(groupName);
    if (m) {
      const n = m[1].trim();
      if (n && !/^Post\b/i.test(n) && !/^Cleaning up\b/i.test(n)) {
        current = n;
        stepStarts.push({ idx: i, name: current });
      }
    }
  }

  return stepStarts;
}

function findStepForLineIndex(stepStarts, lineIndex) {
  if (!stepStarts || stepStarts.length === 0) return "Unknown step";
  let lo = 0, hi = stepStarts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (stepStarts[mid].idx <= lineIndex) lo = mid + 1;
    else hi = mid - 1;
  }
  return stepStarts[Math.max(0, hi)].name;
}

// -------------------- Custom rules --------------------

function parseCustomRules(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r.name && r.pattern)
      .map((r) => ({ name: r.name, re: new RegExp(r.pattern, "i"), hint: r.hint || "" }));
  } catch {
    return [];
  }
}

// -------------------- Error detection --------------------

function pickFirstMeaningfulError(lines, customRules = []) {
  const rules = [
    ...customRules.map((r) => ({ name: r.name, re: r.re })),
    // ESLint
    { name: "ESLint", re: /^\s*\d+:\d+\s+(error|warning)\s+.+\s+.+$/i },
    { name: "ESLint", re: /\bESLint\b.*(found|problems?)/i },
    { name: "ESLint", re: /eslint(?:\.js)?:\s+.*(error|failed)/i },
    // TypeScript
    { name: "TypeScript", re: /error TS\d+:/i },
    { name: "TypeScript", re: /Type error:|TS\d{3,5}\b/i },
    // npm/yarn/pnpm
    { name: "npm", re: /\bnpm ERR!\b/i },
    { name: "npm", re: /\bERR_PNPM_\w+\b/i },
    { name: "npm", re: /\byarn (run|install)\b.*(error|failed)/i },
    // Jest/Vitest
    { name: "Jest/Vitest", re: /^(FAIL|●)\b/ },
    { name: "Jest/Vitest", re: /(Test Suites: \d+ failed|AssertionError)/ },
    // Build tools
    { name: "Build", re: /\b(vite|webpack)\b.*(error|failed)/i },
    { name: "Build", re: /\bBuild failed\b/i },
    // Docker
    { name: "Docker", re: /(failed to solve|executor failed|ERROR: failed|docker buildx|#\d+ ERROR)/i },
    // Python: pytest
    { name: "pytest", re: /FAILED\s+\S+\.py/i },
    { name: "pytest", re: /ERROR\s+\S+\.py/i },
    // Python: mypy
    { name: "mypy", re: /\.py:\d+: error:/i },
    // Python: ruff/flake8
    { name: "ruff/flake8", re: /\.py:\d+:\d+:\s+[A-Z]\d+/i },
    // Python: pip
    { name: "pip", re: /ERROR:.*pip/i },
    // Go
    { name: "Go", re: /--- FAIL:/i },
    { name: "Go", re: /\.go:\d+:\d+:/i },
    { name: "Go", re: /cannot find package/i },
    { name: "Go", re: /\bundefined:/i },
    // Java
    { name: "Java", re: /error:\s+.*java/i },
    { name: "Java", re: /\bjavac\b.*error/i },
    { name: "Java", re: /COMPILATION ERROR/i },
    // Maven
    { name: "Maven", re: /\[ERROR\].*BUILD FAILURE/i },
    { name: "Maven", re: /\[ERROR\].*Failed to execute goal/i },
    // Gradle
    { name: "Gradle", re: /FAILURE: Build failed/i },
    { name: "Gradle", re: /Execution failed for task/i },
    // JUnit
    { name: "JUnit", re: /Tests run:.*Failures: [1-9]/i },
    { name: "JUnit", re: /\bFAILURE!\b.*Tests run/i },
    // Generic JS runtime errors
    { name: "Node", re: /\b(TypeError|ReferenceError|SyntaxError)\b/ },
    { name: "Node", re: /\bUnhandledPromiseRejection\b|\bUnhandled rejection\b/i }
  ];

  for (const rule of rules) {
    const idx = lines.findIndex((l) => rule.re.test(l));
    if (idx !== -1) {
      const excerpt = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 12));
      return { rule: rule.name, line: lines[idx], excerpt, lineIndex: idx };
    }
  }

  const idx = lines.findIndex((l) => {
    if (!l) return false;
    if (/##\[(group|endgroup|debug|notice)\]/i.test(l)) return false;
    return /\berror\b|exception|failed/i.test(l);
  });

  if (idx !== -1) {
    const excerpt = lines.slice(Math.max(0, idx - 2), Math.min(lines.length, idx + 12));
    return { rule: "Generic", line: lines[idx], excerpt, lineIndex: idx };
  }

  return null;
}

function hintFor(ruleName, customRules = []) {
  const custom = customRules.find((r) => r.name === ruleName);
  if (custom && custom.hint) return [custom.hint, ""];

  const hints = {
    ESLint: [
      "Run the linter locally and apply the suggested fix (often `npm run lint -- --fix` depending on your script).",
      "If it's intentional, adjust the specific rule or add a targeted disable (avoid global ignores)."
    ],
    TypeScript: [
      "Open the referenced file/line and fix the type mismatch; TS errors often cascade, so start with the first one.",
      "If it's dependency types, check lockfile drift and TypeScript version compatibility."
    ],
    npm: [
      "Scroll up to the first `npm ERR!` / pnpm error line; the last lines are usually summaries.",
      "If it's install-related, verify Node version, lockfile, and registry/auth."
    ],
    "Jest/Vitest": [
      "Run the failing test locally; focus on the first failing assertion and any snapshot mismatch.",
      "If flaky, check timers, async cleanup, and shared state."
    ],
    Build: [
      "Look for the first bundler error (missing import, invalid config, env mismatch).",
      "If it's environment-only, compare Node version and build-time env vars."
    ],
    Docker: [
      "The first failing build step is the real cause; missing files and auth issues are common.",
      "Verify build context paths and base image tag availability."
    ],
    pytest: [
      "Run the failing test locally with `pytest -x` to stop at the first failure.",
      "Check for fixture issues, missing mocks, or environment-dependent tests."
    ],
    mypy: [
      "Fix the type annotation at the referenced file/line; mypy errors often cascade from a single root cause.",
      "If it's a third-party library, check for missing type stubs (`types-*` packages)."
    ],
    "ruff/flake8": [
      "Run `ruff check --fix` or `flake8` locally to see and auto-fix lint issues.",
      "If the rule is intentionally violated, add a `# noqa: <code>` comment on the specific line."
    ],
    pip: [
      "Check Python version compatibility and that all dependencies are available.",
      "If it's a build dependency, ensure system packages (e.g., `libffi-dev`) are installed."
    ],
    Go: [
      "Run `go test ./...` locally to reproduce the failure.",
      "For build errors, check `go.mod` / `go.sum` and run `go mod tidy`."
    ],
    Java: [
      "Check the referenced file/line for the compilation error; fix type mismatches or missing imports.",
      "Verify Java version compatibility between source and CI environment."
    ],
    Maven: [
      "Run `mvn clean install` locally to reproduce; check dependency resolution and plugin versions.",
      "If it's a dependency issue, run `mvn dependency:tree` to identify conflicts."
    ],
    Gradle: [
      "Run the failing task locally with `--stacktrace` for details.",
      "Check Gradle wrapper version and dependency resolution in `build.gradle`."
    ],
    JUnit: [
      "Run the failing test class locally; focus on the first assertion failure.",
      "Check for test order dependencies and shared state between tests."
    ],
    Node: [
      "Find the first stack trace frame pointing to your code; earlier frames are often library internals.",
      "If it's an unhandled promise, ensure awaits/returns are correct and add proper error handling."
    ],
    Generic: [
      "Start from the first error-looking line; later failures are often symptoms.",
      "If logs are huge, split steps or fail fast to reduce noise."
    ]
  };
  return hints[ruleName] || hints.Generic;
}

// -------------------- Deploy risk --------------------

const DEPLOY_RISK = {
  Docker: "high",
  Build: "high",
  npm: "high",
  Maven: "high",
  Gradle: "high",
  TypeScript: "medium",
  "Jest/Vitest": "medium",
  JUnit: "medium",
  pytest: "medium",
  Go: "medium",
  Java: "medium",
  Node: "medium",
  ESLint: "low",
  "ruff/flake8": "low",
  mypy: "low",
  pip: "medium",
  Generic: "medium"
};

function getDeployRisk(ruleName) {
  return DEPLOY_RISK[ruleName] || "medium";
}

// -------------------- Flaky detection --------------------

async function detectFlaky(octokit, { owner, repo, workflowId, jobName, lookback }) {
  const params = { owner, repo, per_page: lookback, status: "completed" };
  if (workflowId) params.workflow_id = workflowId;

  const runs = await octokit.rest.actions.listWorkflowRunsForRepo(params);

  let passes = 0;
  let failures = 0;

  for (const run of runs.data.workflow_runs.slice(0, lookback)) {
    const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: run.id, per_page: 100
    });

    const matchingJob = jobsResp.data.jobs.find((j) => j.name === jobName);
    if (!matchingJob) continue;

    if (matchingJob.conclusion === "success") passes++;
    else if (matchingJob.conclusion === "failure") failures++;
  }

  const isFlaky = passes >= 2 && failures >= 2;
  return { isFlaky, passes, failures, total: passes + failures };
}

// -------------------- Reviewer suggestions --------------------

function extractFilePaths(errorLine, excerpt) {
  const pathRe = /(?:^|\s|['"`])((?:\.\/)?(?:[\w.-]+\/)*[\w.-]+\.[a-zA-Z]{1,5})(?::\d+)?/g;
  const paths = new Set();
  const sources = [errorLine, ...(excerpt || [])];

  for (const line of sources) {
    let m;
    while ((m = pathRe.exec(line || "")) !== null) {
      const p = m[1].replace(/^\.\//, "");
      if (!/\.(js|ts|jsx|tsx|py|go|java|rb|rs|css|scss|vue|svelte)$/i.test(p)) continue;
      paths.add(p);
    }
  }

  return [...paths].slice(0, 5);
}

async function suggestReviewersForFiles(octokit, { owner, repo, filePaths, prAuthor }) {
  const authorCounts = new Map();

  for (const filePath of filePaths) {
    try {
      const commits = await octokit.rest.repos.listCommits({
        owner, repo, path: filePath, per_page: 10
      });

      for (const c of commits.data) {
        const login = c.author?.login;
        if (!login || login === prAuthor || login.includes("[bot]")) continue;
        authorCounts.set(login, (authorCounts.get(login) || 0) + 1);
      }
    } catch {
      // file may not exist in default branch
    }
  }

  return [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([login, commits]) => ({ login, commits }));
}

// -------------------- Time-to-fix --------------------

async function computeTimeToFix(octokit, { owner, repo, label }) {
  const q = `repo:${owner}/${repo} is:issue is:closed label:${label}`;
  const result = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50 });

  const fixTimes = {};

  for (const item of result.data.items) {
    const closedAt = new Date(item.closed_at);
    const typeMatch = item.title.match(/\]\s*(\w[\w/]*?):/);
    const errorType = typeMatch ? typeMatch[1] : "Generic";
    const createdAt = new Date(item.created_at);
    const hours = Math.round((closedAt - createdAt) / 3600000);
    if (!fixTimes[errorType]) fixTimes[errorType] = [];
    fixTimes[errorType].push(hours);
  }

  const medians = {};
  for (const [type, times] of Object.entries(fixTimes)) {
    times.sort((a, b) => a - b);
    const mid = Math.floor(times.length / 2);
    medians[type] = times.length % 2 === 0
      ? Math.round((times[mid - 1] + times[mid]) / 2)
      : times[mid];
  }

  return medians;
}

function formatFixTime(hours) {
  if (hours < 1) return "<1h";
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days}d`;
}

// -------------------- Error finding in text --------------------

function findFirstErrorInText({ text, fileName, customRules }) {
  const lines = text.split(/\r?\n/);
  const stepStarts = buildStepIndex(lines);
  const hit = pickFirstMeaningfulError(lines, customRules);
  if (!hit) return null;

  const stepName = findStepForLineIndex(stepStarts, hit.lineIndex);
  return { ...hit, stepName, fileName };
}

function findFirstErrorAcrossTexts(textFiles, customRules) {
  for (const f of textFiles) {
    const hit = findFirstErrorInText({ text: f.text, fileName: f.name, customRules });
    if (hit) return hit;
  }
  return null;
}

module.exports = {
  RUNBOOK_SLUGS,
  parseCustomRules,
  pickFirstMeaningfulError,
  hintFor,
  getDeployRisk,
  detectFlaky,
  extractFilePaths,
  suggestReviewersForFiles,
  computeTimeToFix,
  formatFixTime,
  findFirstErrorInText,
  findFirstErrorAcrossTexts
};
