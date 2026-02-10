import AdmZip from "adm-zip";

function bufferFromOctokitData(data) {
  if (!data) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data);
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(data);
}

function classifyLogsPayload(buf, contentType = "") {
  const isZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return { kind: "zip", zipBuf: buf, contentType };

  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { kind: "text", text, contentType };
}

async function downloadJobLogs({ octokit, owner, repo, jobId }) {
  const resp = await octokit.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
    owner, repo, job_id: jobId, request: { redirect: "manual" }
  });

  if (resp.status === 200) {
    const buf = bufferFromOctokitData(resp.data);
    const ct = resp.headers?.["content-type"] || "";
    return classifyLogsPayload(buf, ct);
  }

  const location = resp.headers?.location || resp.headers?.Location;
  if (!location) throw new Error(`Expected redirect with Location header, got status=${resp.status}`);

  const r = await fetch(location);
  if (!r.ok) throw new Error(`Failed to fetch redirected logs URL: ${r.status} ${r.statusText}`);

  const ct = r.headers.get("content-type") || "";
  const arr = await r.arrayBuffer();
  const buf = Buffer.from(arr);
  return classifyLogsPayload(buf, ct);
}

function extractTextFilesFromZip(zipBuf, { maxFiles = 80, maxTotalBytes = 12 * 1024 * 1024 } = {}) {
  const zip = new AdmZip(zipBuf);
  const entries = zip.getEntries();

  const candidates = entries
    .filter((e) => !e.isDirectory)
    .filter((e) => {
      const n = (e.entryName || "").toLowerCase();
      return n.endsWith(".txt") || n.endsWith(".log") || n.includes("log");
    })
    .slice(0, maxFiles);

  const out = [];
  let used = 0;

  for (const e of candidates) {
    const buf = e.getData();
    if (!buf || buf.length === 0) continue;
    if (used + buf.length > maxTotalBytes) break;
    used += buf.length;

    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    out.push({ name: e.entryName, text });
  }

  return out;
}

export {
  bufferFromOctokitData,
  classifyLogsPayload,
  downloadJobLogs,
  extractTextFilesFromZip
};
