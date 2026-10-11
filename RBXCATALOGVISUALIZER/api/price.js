// Vercel serverless: /api/price?a=<assetId,assetId,...>&b=<bundleId,...>
// Asks the SAME endpoint the roblox.com item page uses (catalog items/details, a POST that needs an x-csrf-token handshake)
// so a price shown here matches what Roblox shows right now. Search results can be an hour old (CDN cache) and sometimes
// omit / zero the price; this is the source of truth the site uses to double-check the items on screen.
const URL_ = "https://catalog.roblox.com/v1/catalog/items/details";
const ids = v => String(v || "").split(",").filter(x => /^\d{1,12}$/.test(x)).map(Number);

module.exports = async (req, res) => {
  const items = [
    ...ids(req.query.a).map(id => ({ itemType: 1, id })),    // 1 = Asset
    ...ids(req.query.b).map(id => ({ itemType: 2, id }))     // 2 = Bundle
  ].slice(0, 100);
  if (!items.length) return res.status(400).json({ error: "no ids" });
  try {
    let token = "";
    const post = () => fetch(URL_, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...(token ? { "x-csrf-token": token } : {}) },
      body: JSON.stringify({ items })
    });
    let r = await post();
    if (r.status === 403 && r.headers.get("x-csrf-token")) { token = r.headers.get("x-csrf-token"); r = await post(); }   // CSRF handshake
    if (r.status === 429) {
      const wait = Number(r.headers.get("retry-after")) * 1000 || 800;
      await new Promise(t => setTimeout(t, Math.min(wait, 3000))); r = await post();
    }
    res.status(r.status).setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", r.ok ? "public, s-maxage=120, stale-while-revalidate=300" : "no-store");   // prices stay fresh (2 min)
    res.send(await r.text());
  } catch { res.status(502).json({ error: "upstream unreachable" }); }
};
