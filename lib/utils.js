const core = require("@actions/core");
const crypto = require("crypto");
const github = require("@actions/github");

function toBool(s, def = false) {
  if (s == null) return def;
  const v = String(s).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return def;
}

function clampInt(val, def, min, max) {
  const n = parseInt(String(val ?? def), 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function sha1(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}

function normalize(line) {
  return (line ?? "")
    .toString()
    .replace(/^\uFEFF?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s+/g, "")
    .replace(/\b0x[0-9a-fA-F]+\b/g, "0x…")
    .replace(/\b[0-9a-f]{7,40}\b/g, "…sha…")
    .replace(/:\d+:\d+/g, ":<line>:<col>")
    .replace(/:\d+/g, ":<line>")
    .trim();
}

function codeBlock(text, lang = "") {
  const safe = (text ?? "").toString().replace(/```/g, "``\\`");
  return `\n\`\`\`${lang}\n${safe}\n\`\`\`\n`;
}

async function upsertComment(octokit, { owner, repo, issue_number, body, marker }) {
  const comments = await octokit.rest.issues.listComments({
    owner, repo, issue_number, per_page: 100
  });

  const existing = comments.data.find((c) => (c.body || "").includes(marker));
  if (existing) {
    await octokit.rest.issues.updateComment({
      owner, repo, comment_id: existing.id, body
    });
    return { updated: true, url: existing.html_url };
  }

  const created = await octokit.rest.issues.createComment({
    owner, repo, issue_number, body
  });
  return { updated: false, url: created.data.html_url };
}

async function getRunContext(octokit) {
  const ctx = github.context;

  if (ctx.payload?.workflow_run?.id) {
    const runId = ctx.payload.workflow_run.id;
    const { owner, repo } = ctx.repo;
    let prs = [];
    try {
      const prResp = await octokit.rest.actions.listPullRequestsAssociatedWithWorkflowRun({
        owner, repo, run_id: runId
      });
      prs = (prResp.data || []).map((p) => p.number);
    } catch {
      prs = [];
    }
    return { owner, repo, runId, prNumbers: prs };
  }

  return {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    runId: ctx.runId,
    prNumbers: ctx.payload?.pull_request ? [ctx.payload.pull_request.number] : []
  };
}

module.exports = {
  toBool,
  clampInt,
  sha1,
  normalize,
  codeBlock,
  upsertComment,
  getRunContext
};
