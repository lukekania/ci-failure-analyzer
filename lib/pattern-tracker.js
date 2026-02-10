import * as core from "@actions/core";

const ISSUE_MARKER = "<!-- pattern-signature:v0 -->";

// -------------------- Occurrence parsing --------------------

function parseOccurrenceTimestamps(body) {
  const re = /^- (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/gm;
  const timestamps = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    timestamps.push(new Date(m[1]));
  }
  return timestamps;
}

function computeWindowStats(timestamps, now) {
  const d7 = new Date(now.getTime() - 7 * 86400000);
  const d14 = new Date(now.getTime() - 14 * 86400000);
  let last7 = 0;
  let last14 = 0;
  for (const ts of timestamps) {
    if (ts >= d7) last7++;
    if (ts >= d14) last14++;
  }
  return { last7, last14 };
}

// -------------------- Severity --------------------

const BASE_SEVERITY = {
  Docker: "high",
  npm: "high",
  Build: "high",
  TypeScript: "medium",
  "Jest/Vitest": "medium",
  Node: "high",
  ESLint: "low",
  Generic: "low"
};

function classifySeverity(ruleName, stats7d) {
  const base = BASE_SEVERITY[ruleName] || "low";
  if (stats7d >= 5) return "high";
  return base;
}

async function applySeverityLabel(octokit, { owner, repo, issueNumber, severity }) {
  const prefix = "severity:";
  const targetLabel = prefix + severity;

  const { data: labels } = await octokit.rest.issues.listLabelsOnIssue({
    owner, repo, issue_number: issueNumber, per_page: 100
  });

  const stale = labels.filter(
    (l) => l.name.startsWith(prefix) && l.name !== targetLabel
  );

  for (const l of stale) {
    await octokit.rest.issues.removeLabel({
      owner, repo, issue_number: issueNumber, name: l.name
    });
  }

  const alreadyApplied = labels.some((l) => l.name === targetLabel);
  if (!alreadyApplied) {
    await octokit.rest.issues.addLabels({
      owner, repo, issue_number: issueNumber, labels: [targetLabel]
    });
  }
}

// -------------------- Stats line --------------------

function appendStatsLine(body, stats) {
  const statsLine = `**Last 7d:** ${stats.last7} | **Last 14d:** ${stats.last14}`;
  const statsRe = /^\*\*Last 7d:\*\*.+$/m;
  if (statsRe.test(body)) {
    return body.replace(statsRe, statsLine);
  }
  return body.replace(
    /^## Occurrences/m,
    `${statsLine}\n\n## Occurrences`
  );
}

// -------------------- Fix-PR detection --------------------

async function findFixingPR(octokit, { owner, repo, issueNumber }) {
  const q = `repo:${owner}/${repo} is:pr is:merged ${issueNumber}`;
  const result = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 5 });

  const linked = result.data.items.filter((pr) => {
    const body = (pr.body || "") + " " + (pr.title || "");
    return body.includes(`#${issueNumber}`) || body.includes(`issues/${issueNumber}`);
  });

  return linked.map((pr) => ({ number: pr.number, title: pr.title, url: pr.html_url }));
}

// -------------------- Auto-close --------------------

async function autoCloseQuietIssues(octokit, { issueOwner, issueRepo, label, quietDays }) {
  if (quietDays <= 0) return [];

  const q = `repo:${issueOwner}/${issueRepo} is:issue is:open label:${label}`;
  const result = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50 });

  const closed = [];
  const cutoff = new Date(Date.now() - quietDays * 86400000);

  for (const item of result.data.items) {
    const issue = await octokit.rest.issues.get({
      owner: issueOwner, repo: issueRepo, issue_number: item.number
    });

    const timestamps = parseOccurrenceTimestamps(issue.data.body || "");
    if (timestamps.length === 0) continue;

    const lastSeen = timestamps.reduce((a, b) => (a > b ? a : b));
    if (lastSeen >= cutoff) continue;

    const daysSince = Math.floor((Date.now() - lastSeen.getTime()) / 86400000);

    const fixingPRs = await findFixingPR(octokit, {
      owner: issueOwner, repo: issueRepo, issueNumber: item.number
    });

    let closeMsg = `Pattern inactive for ${daysSince} days — closing.`;
    if (fixingPRs.length > 0) {
      const links = fixingPRs.map((pr) => `- #${pr.number} ${pr.title}`).join("\n");
      closeMsg += `\n\n**Likely fixed by:**\n${links}`;
    }

    await octokit.rest.issues.createComment({
      owner: issueOwner, repo: issueRepo, issue_number: item.number, body: closeMsg
    });

    await octokit.rest.issues.update({
      owner: issueOwner, repo: issueRepo, issue_number: item.number, state: "closed"
    });

    closed.push(item.number);
  }

  return closed;
}

// -------------------- Issue upsert --------------------

async function upsertIssueForSignature({
  octokit, issueOwner, issueRepo, label, signature, signatureHash,
  occurrence, ruleName, notifyThreshold
}) {
  const q = `repo:${issueOwner}/${issueRepo} is:issue in:title "${signatureHash}" label:${label}`;
  const found = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 10 });

  const title = `[CI Pattern ${signatureHash.slice(0, 8)}] ${signature.slice(0, 120)}`;
  const header = `${ISSUE_MARKER}\n\n**Signature:**\n\`\`\`\n${signature}\n\`\`\`\n\n`;
  const repoTag = occurrence.sourceRepo ? ` (${occurrence.sourceRepo})` : "";
  const explainerSuffix = occurrence.explainerContext ? `\n  > ${occurrence.explainerContext}` : "";
  const occLine = `- ${occurrence.when} — ${occurrence.runUrl}${repoTag}${explainerSuffix}`;

  // Also search closed issues for previously resolved patterns
  if (found.data.items.length === 0) {
    const closedQ = `repo:${issueOwner}/${issueRepo} is:issue is:closed in:title "${signatureHash}" label:${label}`;
    const closedFound = await octokit.rest.search.issuesAndPullRequests({ q: closedQ, per_page: 10 });
    if (closedFound.data.items.length > 0) {
      found.data.items = closedFound.data.items;
    }
  }

  if (found.data.items.length > 0) {
    const issueNumber = found.data.items[0].number;
    const wasClosed = found.data.items[0].state === "closed";
    const existingLabels = (found.data.items[0].labels || []).map(
      (l) => (typeof l === "string" ? l : l.name)
    );
    const muted = existingLabels.includes("muted");

    const issue = await octokit.rest.issues.get({
      owner: issueOwner, repo: issueRepo, issue_number: issueNumber
    });

    const body = issue.data.body || "";
    const updatedBody = body.includes("## Occurrences")
      ? body.replace(/^## Occurrences\s*$/m, "## Occurrences")
      : body + (body.endsWith("\n") ? "" : "\n") + "\n## Occurrences\n";

    const prefixedOccLine = muted ? `- [muted] ${occurrence.when} — ${occurrence.runUrl}${repoTag}${explainerSuffix}` : occLine;
    let newBody = updatedBody.replace(
      /## Occurrences\s*\n/i,
      `## Occurrences\n${prefixedOccLine}\n`
    );

    const allTimestamps = parseOccurrenceTimestamps(newBody);
    const stats = computeWindowStats(allTimestamps, new Date());
    newBody = appendStatsLine(newBody, stats);

    const severity = classifySeverity(ruleName, stats.last7);

    const updatePayload = {
      owner: issueOwner, repo: issueRepo, issue_number: issueNumber, body: newBody
    };

    if (wasClosed) {
      updatePayload.state = "open";
    }

    await octokit.rest.issues.update(updatePayload);

    if (wasClosed) {
      await octokit.rest.issues.createComment({
        owner: issueOwner, repo: issueRepo, issue_number: issueNumber,
        body: "**Pattern recurred** — this issue was previously resolved but the same failure has reappeared. Check the previous closing comment for fix context."
      });
    }

    await applySeverityLabel(octokit, {
      owner: issueOwner, repo: issueRepo, issueNumber, severity
    });

    const totalOccurrences = allTimestamps.length;
    let thresholdReached = false;

    if (notifyThreshold > 0 && totalOccurrences >= notifyThreshold) {
      const thresholdLabel = "threshold-reached";
      const hasLabel = existingLabels.includes(thresholdLabel);
      if (!hasLabel) {
        await octokit.rest.issues.addLabels({
          owner: issueOwner, repo: issueRepo, issue_number: issueNumber,
          labels: [thresholdLabel]
        });
        thresholdReached = true;
      }
    }

    return { kind: wasClosed ? "reopened" : "updated", issueNumber, url: found.data.items[0].html_url, severity, muted, totalOccurrences, thresholdReached };
  }

  const severity = classifySeverity(ruleName, 0);

  const body = header + "## Occurrences\n" + occLine + "\n";
  const created = await octokit.rest.issues.create({
    owner: issueOwner, repo: issueRepo, title, body,
    labels: [label, `severity:${severity}`]
  });

  return { kind: "created", issueNumber: created.data.number, url: created.data.html_url, severity, muted: false, totalOccurrences: 1, thresholdReached: false };
}

// -------------------- JSON export --------------------

async function exportPatternsAsJson(octokit, { issueOwner, issueRepo, label }) {
  const q = `repo:${issueOwner}/${issueRepo} is:issue label:${label}`;
  const result = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 100 });

  const patterns = [];

  for (const item of result.data.items) {
    const issue = await octokit.rest.issues.get({
      owner: issueOwner, repo: issueRepo, issue_number: item.number
    });

    const body = issue.data.body || "";
    const timestamps = parseOccurrenceTimestamps(body);
    const lastSeen = timestamps.length > 0
      ? timestamps.reduce((a, b) => (a > b ? a : b)).toISOString()
      : null;

    const hashMatch = item.title.match(/\[CI Pattern ([a-f0-9]+)\]/);
    const hash = hashMatch ? hashMatch[1] : "";

    const sigMatch = body.match(/\*\*Signature:\*\*\n```\n([\s\S]*?)\n```/);
    const signature = sigMatch ? sigMatch[1] : item.title;

    const labels = (item.labels || []).map((l) => (typeof l === "string" ? l : l.name));
    const severity = labels.find((l) => l.startsWith("severity:"))?.replace("severity:", "") || "unknown";
    const muted = labels.includes("muted");

    patterns.push({
      issueNumber: item.number, hash, signature,
      occurrences: timestamps.length, lastSeen, severity, muted,
      state: item.state, url: item.html_url
    });
  }

  return patterns;
}

export {
  upsertIssueForSignature,
  autoCloseQuietIssues,
  exportPatternsAsJson
};
