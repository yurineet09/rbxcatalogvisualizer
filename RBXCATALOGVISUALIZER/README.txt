RETRO CATALOG - deploy notes

Deploy THIS folder as the project root (index.html and api/ must be at the top level).
Vercel: New Project -> import it -> Root Directory = "./" (this folder) -> Deploy.

Test the proxy after deploying:
  https://YOUR-SITE.vercel.app/api/rbx?s=economy&p=/v2/assets/63690008/details
It should return JSON. If it returns 404, api/ is not at the project root.

Local test: use "vercel dev" (a plain static server has no /api route).

Settings live in js/config.js:
  perPage / prefetchPages  items per page / how many pages are loaded ahead (pager shows 1 2 3 ... )
  maxAssetId               asset IDs above this are skipped without asking Roblox (2013 and older items only)
  maxPulls                 how many Roblox search requests one load step may use
