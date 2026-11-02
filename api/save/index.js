// POST /api/save  ->  one commit that updates products.json and photos together.
const { config, authorize, gh } = require("../lib/github");

const CODE = /^[A-Za-z0-9-]{1,12}$/;
const MAX_PHOTO_BYTES = 450 * 1024;

function fail(context, status, error) {
  context.res = { status, headers: { "Content-Type": "application/json" }, body: { error } };
}
const isStr = (v, max) => typeof v === "string" && v.length <= max;

// A colour is {name, hex}. A plain string is accepted too (name only, no swatch).
function cleanColor(c) {
  if (typeof c === "string") return isStr(c, 20) && c.trim() ? { name: c.trim() } : null;
  if (!c || typeof c !== "object" || !isStr(c.name, 20) || !c.name.trim()) return null;
  const out = { name: c.name.trim() };
  if (typeof c.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(c.hex)) out.hex = c.hex.toLowerCase();
  return out;
}

function cleanSettings(s) {
  if (!s || typeof s !== "object") throw new Error("Settings are missing.");
  const wa = String(s.whatsappNumber || "");
  if (!/^\d{10,15}$/.test(wa)) throw new Error("WhatsApp number must be 10 to 15 digits.");
  let fee = s.noidaFee;
  if (fee !== null && !(typeof fee === "number" && fee >= 0 && fee < 100000)) throw new Error("Noida fee must be a number or blank.");
  if (!isStr(s.shipDays, 24) || !s.shipDays.trim()) throw new Error("Normal delivery time is missing.");
  if (!isStr(s.preDiwaliCutoff, 40) || !s.preDiwaliCutoff.trim()) throw new Error("Order-by date is missing.");
  return { whatsappNumber: wa, noidaFee: fee === null ? null : Math.round(fee), shipDays: s.shipDays.trim(), preDiwaliCutoff: s.preDiwaliCutoff.trim() };
}

function cleanProducts(list) {
  if (!Array.isArray(list) || !list.length || list.length > 200) throw new Error("The product list is empty or too long.");
  const seen = new Set();
  return list.map((p) => {
    if (!p || !CODE.test(p.code || "")) throw new Error("A product code is invalid.");
    if (seen.has(p.code)) throw new Error("The code " + p.code + " is used twice.");
    seen.add(p.code);
    if (!isStr(p.name, 80) || !p.name.trim()) throw new Error(p.code + ": name is missing.");
    if (typeof p.price !== "number" || !(p.price > 0) || p.price > 1000000) throw new Error(p.code + ": price is invalid.");
    const o = { code: p.code, name: p.name.trim(), price: Math.round(p.price), preDiwali: p.preDiwali === true, description: isStr(p.description, 200) ? p.description.trim() : "" };
    if (isStr(p.ship, 40) && p.ship.trim()) o.ship = p.ship.trim();
    if (Array.isArray(p.colors)) {
      const cs = p.colors.map(cleanColor).filter(Boolean).slice(0, 8);
      if (cs.length) o.colors = cs;
    }
    return o;
  });
}

module.exports = async function (context, req) {
  const auth = authorize(req);
  if (!auth.ok) return fail(context, auth.status, auth.error);
  const c = config();
  const body = req.body;
  if (!body || typeof body !== "object") return fail(context, 400, "Nothing to save.");

  let settings, products;
  try { settings = cleanSettings(body.settings); products = cleanProducts(body.products); }
  catch (e) { return fail(context, 400, e.message); }

  const photoPlan = body.photos && typeof body.photos === "object" ? body.photos : {};
  const codes = new Set(products.map((p) => p.code));
  try {
    const ref = await gh("GET", "/git/ref/heads/" + encodeURIComponent(c.branch));
    const headSha = ref.object.sha;
    const headCommit = await gh("GET", "/git/commits/" + headSha);
    let existing = [];
    try { existing = await gh("GET", "/contents/photos?ref=" + encodeURIComponent(c.branch)); } catch (e) { if (e.status !== 404) throw e; }
    const have = new Map(existing.filter((f) => f.type === "file").map((f) => [f.name, f.sha]));

    const tree = [{ path: "products.json", mode: "100644", type: "blob", content: JSON.stringify({ settings, products }, null, 2) + "\n" }];
    let changed = 1;

    for (const code of Object.keys(photoPlan)) {
      if (!CODE.test(code)) throw new Error("Bad photo code.");
      const items = photoPlan[code];
      if (!Array.isArray(items) || items.length > 5) throw new Error(code + ": up to 5 photos.");
      if (items.length && !codes.has(code)) throw new Error(code + ": photos for a product that does not exist.");
      const finalNames = new Set();
      for (let i = 0; i < items.length; i++) {
        const name = code + "-" + (i + 1) + ".jpg";
        finalNames.add(name);
        const it = items[i] || {};
        if (typeof it.keep === "string") {
          if (!new RegExp("^" + code.replace(/[-]/g, "\\-") + "-[1-5]\\.jpg$").test(it.keep) || !have.has(it.keep)) throw new Error(code + ": a kept photo no longer exists.");
          if (it.keep !== name) { tree.push({ path: "photos/" + name, mode: "100644", type: "blob", sha: have.get(it.keep) }); changed++; }
        } else if (typeof it.b64 === "string") {
          const buf = Buffer.from(it.b64, "base64");
          if (buf.length < 1000 || buf.length > MAX_PHOTO_BYTES) throw new Error(code + ": a photo is too large (limit 450 KB).");
          if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) throw new Error(code + ": photos must be JPEG.");
          const blob = await gh("POST", "/git/blobs", { content: it.b64, encoding: "base64" });
          tree.push({ path: "photos/" + name, mode: "100644", type: "blob", sha: blob.sha }); changed++;
        } else throw new Error(code + ": bad photo entry.");
      }
      // Remove old files for this code that are no longer part of the final list.
      for (const n of have.keys()) {
        if (n.indexOf(code + "-") === 0 && /-[1-5]\.jpg$/.test(n) && n.slice(0, n.lastIndexOf("-")) === code && !finalNames.has(n)) {
          tree.push({ path: "photos/" + n, mode: "100644", type: "blob", sha: null }); changed++;
        }
      }
    }

    const newTree = await gh("POST", "/git/trees", { base_tree: headCommit.tree.sha, tree });
    const commit = await gh("POST", "/git/commits", { message: "Shop editor: update products (" + auth.user + ")", tree: newTree.sha, parents: [headSha] });
    await gh("PATCH", "/git/refs/heads/" + encodeURIComponent(c.branch), { sha: commit.sha, force: false });
    context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, commit: commit.sha, files: changed } };
  } catch (e) {
    context.log.error(e.message);
    const msg = /fast.?forward|reference/i.test(e.message) ? "The shop was changed while you were editing. Reload the page and try again." : (e.status ? "GitHub refused the save: " + e.message : e.message);
    fail(context, e.status && e.status >= 500 ? 502 : 400, msg);
  }
};
