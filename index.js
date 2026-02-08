const core = require("@actions/core");
const github = require("@actions/github");
const fs = require("fs");

const { toBool, clampInt, sha1, normalize, codeBlock, upsertComment, getRunContext } = require("./lib/utils");
const { downloadJobLogs, extractTextFilesFromZip } = require("./lib/log-downloader");
const { RUNBOOK_SLUGS, parseCustomRules, hintFor, getDeployRisk, detectFlaky, extractFilePaths, suggestReviewersForFiles, computeTimeToFix, formatFixTime, findFirstErrorInText, findFirstErrorAcrossTexts } = require("./lib/error-detector");
const { upsertIssueForSignature, autoCloseQuietIssues, exportPatternsAsJson } = require("./lib/pattern-tracker");

const MARKER = "<!-- ci-failure-analyzer:v0 -->";

const OLD_MARKERS = [
  "<!-- ci-failure-explainer:v0 -->",
  "<!-- failure-pattern-detector:v0 -->"
];

function appendStepSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    core.info(markdown);
    return;
  }
  fs.appendFileSync(summaryPath, markdown + "\n", { encoding: "utf8" });
}

async function deleteOldComments(octokit, { owner, repo, prNumbers }) {
  for (const prNumber of prNumbers.slice(0, 3)) {
    for (const marker of OLD_MARKERS) {
      try {
        const comments = await octokit.rest.issues.listComments({
          owner, repo, issue_number: prNumber, per_page: 100
        });
        const existing = comments.data.find((c) => (c.body || "").includes(marker));
        if (existing) {
          await octokit.rest.issues.deleteComment({ owner, repo, comment_id: existing.id });
          core.info(`Deleted old comment with marker ${marker} on PR #${prNumber}`);
        }
      } catch {
        // best effort
      }
    }
  }
}

async function run() {
  try {
    const token = core.getInput("github_token", { required: true });
    const commentOnPR = toBool(core.getInput("comment_on_pr"), false);
    const jsonOutput = toBool(core.getInput("json_output"), false);
    const runbookUrl = (core.getInput("runbook_url") || "").replace(/\/+$/, "");
    const customRules = parseCustomRules(core.getInput("custom_rules"));
    const flakyDetection = toBool(core.getInput("flaky_detection"), false);
    const flakyLookback = clampInt(core.getInput("flaky_lookback"), 10, 3, 30);
    const suggestReviewers = toBool(core.getInput("suggest_reviewers"), false);
    const showDeployRisk = toBool(core.getInput("deploy_risk"), false);
    const maxFailedJobs = clampInt(core.getInput("max_failed_jobs"), 5, 1, 20);

    // Pattern tracking inputs
    const trackPatterns = toBool(core.getInput("track_patterns"), false)
      || toBool(core.getInput("check_patterns"), false);
    const issueRepoInput = core.getInput("issue_repo") || "";
    const issueLabel = core.getInput("issue_label")
      || core.getInput("pattern_label")
      || "ci-failure-pattern";
    const quietDays = clampInt(core.getInput("quiet_days"), 0, 0, 365);
    const exportJson = toBool(core.getInput("export_json"), false);
    const notifyThreshold = clampInt(core.getInput("notify_threshold"), 0, 0, 10000);
    const explainerContext = (core.getInput("explainer_context") || "").trim();

    const octokit = github.getOctokit(token);
    const { owner, repo, runId, prNumbers } = await getRunContext(octokit);
    const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${runId}`;

    const issueOwner = issueRepoInput ? issueRepoInput.split("/")[0] : owner;
    const issueRepo = issueRepoInput ? issueRepoInput.split("/")[1] : repo;

    core.info(`CI Failure Analyzer: analyzing ${owner}/${repo} run_id=${runId}`);

    const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
      owner, repo, run_id: runId, per_page: 100
    });

    const failedJobs = jobsResp.data.jobs.filter((j) => j.conclusion === "failure");

    if (failedJobs.length === 0) {
      appendStepSummary("### CI Failure Analyzer\nNo failed jobs detected.\n");
      return;
    }

    let fixTimeMedians = {};
    if (trackPatterns) {
      try {
        fixTimeMedians = await computeTimeToFix(octokit, { owner, repo, label: issueLabel });
      } catch {
        // best-effort
      }
    }

    appendStepSummary("### CI Failure Analyzer\n");
    const summaryParts = ["### CI Failure Analyzer\n"];
    const jsonResults = [];

    // Clean up old comments from separate actions
    if (commentOnPR && prNumbers.length > 0) {
      await deleteOldComments(octokit, { owner, repo, prNumbers });
    }

    for (const job of failedJobs.slice(0, maxFailedJobs)) {
      appendStepSummary(`#### Failed job: ${job.name}\n`);
      appendStepSummary(`- Conclusion: **${job.conclusion}**\n`);
      appendStepSummary(`- URL: ${job.html_url}\n`);
      summaryParts.push(`#### Failed job: ${job.name}\n`);

      let payload;
      try {
        payload = await downloadJobLogs({ octokit, owner, repo, jobId: job.id });
      } catch (e) {
        const msg = e?.message || String(e);
        core.warning(`Could not download logs: ${msg}`);
        appendStepSummary(`- Could not download logs: ${msg}\n\n`);
        continue;
      }

      let hit = null;

      if (payload.kind === "zip") {
        core.info(`CI Failure Analyzer: job ${job.id} logs=zip (${payload.contentType || "?"})`);
        const textFiles = extractTextFilesFromZip(payload.zipBuf);
        hit = findFirstErrorAcrossTexts(textFiles, customRules);
      } else {
        core.info(`CI Failure Analyzer: job ${job.id} logs=text (${payload.contentType || "?"})`);
        hit = findFirstErrorInText({ text: payload.text, fileName: `job-${job.id}.log`, customRules });
      }

      if (!hit) {
        appendStepSummary(`- No obvious error signature found (rules too limited or logs too noisy).\n\n`);
        continue;
      }

      const normalized = normalize(hit.line);
      const [primaryHint, secondaryHint] = hintFor(hit.rule, customRules);
      const excerpt = (hit.excerpt || []).slice(0, 16).map(normalize).join("\n");

      appendStepSummary(`- Failing step: **${hit.stepName}**\n`);
      appendStepSummary(`- Detected type: **${hit.rule}**\n`);
      if (showDeployRisk) {
        appendStepSummary(`- Deploy risk: **${getDeployRisk(hit.rule)}**\n`);
      }
      if (fixTimeMedians[hit.rule] !== undefined) {
        appendStepSummary(`- Typical fix time: **${formatFixTime(fixTimeMedians[hit.rule])}**\n`);
      }
      appendStepSummary(`- Source log: \`${hit.fileName}\`\n`);
      appendStepSummary(`- First error (normalized):${codeBlock(normalized)}\n`);
      appendStepSummary(`- Likely fix: ${primaryHint}\n`);
      if (secondaryHint) appendStepSummary(`- Also check: ${secondaryHint}\n`);

      if (runbookUrl) {
        const runbookSlug = RUNBOOK_SLUGS[hit.rule] || hit.rule.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        appendStepSummary(`- [Runbook](${runbookUrl}/${runbookSlug})\n`);
      }

      // Pattern tracking (inline — no more piping between actions)
      let patternLink = null;
      let patternNote = "";

      if (trackPatterns) {
        const signature = `${hit.rule}: ${normalized}`;
        const signatureHash = sha1(signature);
        const nowISO = new Date().toISOString();
        const sourceRepo = (issueOwner !== owner || issueRepo !== repo) ? `${owner}/${repo}` : "";
        const occurrence = { when: nowISO, runUrl, sourceRepo, explainerContext };

        try {
          const issueRes = await upsertIssueForSignature({
            octokit, issueOwner, issueRepo, label: issueLabel,
            signature, signatureHash, occurrence, ruleName: hit.rule,
            notifyThreshold
          });

          patternLink = issueRes.url;
          core.info(`Pattern issue ${issueRes.kind}: ${issueRes.url}`);

          if (issueRes.muted) {
            core.info("Pattern is muted.");
          }
          if (issueRes.thresholdReached) {
            core.warning(`Pattern reached notification threshold (${notifyThreshold} occurrences): ${issueRes.url}`);
          }

          const recurrenceNote = issueRes.kind === "reopened"
            ? "- **Recurrence:** this pattern was previously resolved\n"
            : "";

          patternNote =
            `- Tracking issue: ${issueRes.url}\n` +
            recurrenceNote;

          appendStepSummary(`- Tracking issue: ${patternLink}\n`);
          if (issueRes.kind === "reopened") {
            appendStepSummary(`- **Recurrence:** this pattern was previously resolved\n`);
          }
        } catch (e) {
          core.warning(`Pattern tracking failed for ${job.name}: ${e?.message || e}`);
        }
      }

      let flakyNote = "";
      if (flakyDetection) {
        try {
          const flakyResult = await detectFlaky(octokit, {
            owner, repo, workflowId: null, jobName: job.name, lookback: flakyLookback
          });
          if (flakyResult.isFlaky) {
            const msg = `Likely flaky (${flakyResult.failures}/${flakyResult.total} recent runs failed)`;
            appendStepSummary(`- **${msg}**\n`);
            flakyNote = `- **${msg}**\n`;
            core.warning(`${job.name}: ${msg}`);
          }
        } catch {
          // best-effort
        }
      }

      let reviewerNote = "";
      if (suggestReviewers) {
        try {
          const filePaths = extractFilePaths(hit.line, hit.excerpt);
          if (filePaths.length > 0) {
            const prAuthor = github.context.payload?.pull_request?.user?.login || "";
            const suggestions = await suggestReviewersForFiles(octokit, { owner, repo, filePaths, prAuthor });
            if (suggestions.length > 0) {
              const names = suggestions.map((s) => `@${s.login} (${s.commits} commits)`).join(", ");
              appendStepSummary(`- Suggested reviewers: ${names}\n`);
              reviewerNote = `- Suggested reviewers: ${names}\n`;
            }
          }
        } catch {
          // best-effort
        }
      }

      appendStepSummary(`- Context:${codeBlock(excerpt)}\n`);

      const riskLine = showDeployRisk ? `- Deploy risk: **${getDeployRisk(hit.rule)}**\n` : "";
      const fixTimeLine = fixTimeMedians[hit.rule] !== undefined
        ? `- Typical fix time: **${formatFixTime(fixTimeMedians[hit.rule])}**\n`
        : "";

      let partBlock =
        `- Failing step: **${hit.stepName}**\n` +
        `- Detected type: **${hit.rule}**\n` +
        riskLine +
        fixTimeLine +
        `- First error:${codeBlock(normalized)}\n` +
        `- Likely fix: ${primaryHint}\n`;

      if (patternNote) partBlock += patternNote;

      if (runbookUrl) {
        const slug = RUNBOOK_SLUGS[hit.rule] || hit.rule.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        partBlock += `- [Runbook](${runbookUrl}/${slug})\n`;
      }
      partBlock += flakyNote;
      partBlock += reviewerNote;
      summaryParts.push(partBlock);

      if (jsonOutput) {
        jsonResults.push({
          job: job.name,
          step: hit.stepName,
          errorType: hit.rule,
          error: normalized,
          hint: primaryHint,
          context: excerpt,
          patternUrl: patternLink || "",
          flakyNote: flakyNote ? flakyNote.trim() : ""
        });
      }

      core.info(`CI Failure Analyzer: ${job.name} -> step="${hit.stepName}" rule="${hit.rule}" line="${normalized}"`);
    }

    // Auto-close quiet pattern issues
    if (trackPatterns && quietDays > 0) {
      try {
        const closed = await autoCloseQuietIssues(octokit, {
          issueOwner, issueRepo, label: issueLabel, quietDays
        });
        if (closed.length > 0) {
          core.info(`Auto-closed ${closed.length} quiet issue(s): ${closed.join(", ")}`);
        }
      } catch (e) {
        core.warning(`Auto-close failed: ${e?.message || e}`);
      }
    }

    // Post unified PR comment
    if (commentOnPR && prNumbers.length > 0) {
      const body = `${MARKER}\n` + summaryParts.join("\n");
      for (const prNumber of prNumbers.slice(0, 3)) {
        const c = await upsertComment(octokit, { owner, repo, issue_number: prNumber, body, marker: MARKER });
        core.info(`PR #${prNumber} comment ${c.updated ? "updated" : "created"}: ${c.url}`);
      }
    }

    // JSON outputs
    if (jsonOutput) {
      core.setOutput("failures_json", JSON.stringify(jsonResults));
      core.info(`Exported ${jsonResults.length} failure(s) as JSON.`);
    }

    if (trackPatterns && exportJson) {
      try {
        const patterns = await exportPatternsAsJson(octokit, {
          issueOwner, issueRepo, label: issueLabel
        });
        core.setOutput("patterns_json", JSON.stringify(patterns));
        core.info(`Exported ${patterns.length} pattern(s) as JSON.`);
      } catch (e) {
        core.warning(`Pattern export failed: ${e?.message || e}`);
      }
    }
  } catch (err) {
    core.setFailed(err?.message || String(err));
  }
}

run();
