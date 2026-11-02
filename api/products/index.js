// GET /api/products  ->  { data: <products.json>, photos: [{name, sha}] } straight from the repo (never stale).
const { config, authorize, gh } = require("../lib/github");

module.exports = async function (context, req) {
  const auth = authorize(req);
  if (!auth.ok) { context.res = { status: auth.status, headers: { "Content-Type": "application/json" }, body: { error: auth.error } }; return; }
  const c = config();
  try {
    const file = await gh("GET", "/contents/products.json?ref=" + encodeURIComponent(c.branch));
    const data = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    let photos = [];
    try {
      const list = await gh("GET", "/contents/photos?ref=" + encodeURIComponent(c.branch));
      photos = list.filter((f) => f.type === "file" && /^[A-Za-z0-9-]+-[1-5]\.jpg$/.test(f.name)).map((f) => ({ name: f.name, sha: f.sha }));
    } catch (e) { if (e.status !== 404) throw e; }
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: { data, photos } };
  } catch (e) {
    context.log.error(e.message);
    context.res = { status: 502, headers: { "Content-Type": "application/json" }, body: { error: "Could not read the shop data from GitHub." } };
  }
};
