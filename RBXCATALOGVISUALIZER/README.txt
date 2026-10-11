RETRO CATALOG - deploy notes

Deploy THIS folder as the project root (index.html and api/ must be at the top level).
Vercel: New Project -> import it -> Root Directory = "./" (this folder) -> Deploy.

Test the proxy after deploying:
  https://YOUR-SITE.vercel.app/api/rbx?s=economy&p=/v2/assets/63690008/details
It should return JSON. If it returns 404, api/ is not at the project root.

Local test: use "vercel dev" (a plain static server has no /api route).
