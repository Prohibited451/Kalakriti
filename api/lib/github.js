// Shared helpers for the shop editor API.
// Needs these Azure app settings (Static Web App > Environment variables):
//   GITHUB_TOKEN       fine-grained token for this one repo, "Contents: Read and write"
//   GITHUB_REPO        e.g. Prohibited451/Kalakriti
//   ADMIN_GITHUB_USER  the only GitHub username allowed to edit, e.g. Prohibited451
//   GITHUB_BRANCH      optional, defaults to main

const API = "https://api.github.com";

function config() {
  return {
    token: process.env.GITHUB_TOKEN,
    repo: process.env.GITHUB_REPO,
    admin: (process.env.ADMIN_GITHUB_USER || "").toLowerCase(),
    branch: process.env.GITHUB_BRANCH || "main",
  };
}

// Azure Static Web Apps puts the signed-in user in this header. Only the named GitHub user passes.
function authorize(req) {
  const c = config();
  if (!c.token || !c.repo || !c.admin) return { ok: false, status: 500, error: "The editor is not configured yet (missing app settings)." };
  const raw = req.headers["x-ms-client-principal"];
  if (!raw) return { ok: false, status: 401, error: "Please sign in." };
  let p;
  try { p = JSON.parse(Buffer.from(raw, "base64").toString("utf8")); } catch (e) { return { ok: false, status: 401, error: "Please sign in." }; }
  if (!p || p.identityProvider !== "github" || String(p.userDetails || "").toLowerCase() !== c.admin) {
    return { ok: false, status: 403, error: "This GitHub account is not allowed to edit the shop." };
  }
  return { ok: true, user: p.userDetails };
}

async function gh(method, path, body) {
  const c = config();
  const r = await fetch(API + "/repos/" + c.repo + path, {
    method,
    headers: {
      Authorization: "Bearer " + c.token,
      Accept: "application/vnd.github+json",
      "User-Agent": "kalakriti-shop-editor",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* not json */ }
  if (!r.ok) {
    const err = new Error((json && json.message) || ("GitHub error " + r.status));
    err.status = r.status;
    throw err;
  }
  return json;
}

module.exports = { config, authorize, gh };
