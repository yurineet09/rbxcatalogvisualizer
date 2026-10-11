// Vercel serverless proxy: /api/rbx?s=<service>&p=<path+query>
// Calls Roblox from the server (no CORS, no shared third-party rate limit) and caches answers on Vercel's CDN.
const HOSTS = { economy: "economy.roblox.com", catalog: "catalog.roblox.com", thumbnails: "thumbnails.roblox.com" };
const ALLOWED = /^\/v[12]\/(assets\/\d+\/details|favorites\/assets\/\d+\/count|search\/items|assets|assets-thumbnail-3d|bundles\/\d+\/details|bundles\/thumbnails)$/;

module.exports = async (req, res) => {
  const host = HOSTS[req.query.s], path = String(req.query.p || "");
  if (!host || !path.startsWith("/") || !ALLOWED.test(path.split("?")[0])) return res.status(400).json({ error: "bad request" });
  try {
    // 3D thumbnails became authenticated in 2026. Add ROBLOX_API_KEY in Vercel
    // (Thumbnails: Read) to enable the optional 3D viewer without exposing a key.
    const headers = { accept: "application/json" };
    if (path.startsWith("/v1/assets-thumbnail-3d") && process.env.ROBLOX_API_KEY) headers["x-api-key"] = process.env.ROBLOX_API_KEY;
    const go = () => fetch(`https://${host}${path}`, { headers });
    let r = await go();
    if (r.status === 429) { await new Promise(t => setTimeout(t, 800)); r = await go(); }   // one polite retry
    res.status(r.status).setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", r.ok ? "public, s-maxage=3600, stale-while-revalidate=86400" : "no-store");
    res.send(await r.text());
  } catch { res.status(502).json({ error: "upstream unreachable" }); }
};
