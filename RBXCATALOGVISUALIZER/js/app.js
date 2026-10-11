/* ===== App: state, rendering, routing ===== */
const $ = s => document.querySelector(s);
const SOURCES = { roblox: "ROBLOX", community: "Community" };
const SORTS = { created_desc: "Newest Created", created_asc: "Oldest Created", price_asc: "Lowest Price", price_desc: "Highest Price" };
const ERR = "There was a problem connecting to the server. Please try again later.";
const state = { items: [], cat: "All", source: "roblox", sort: "created_desc", showOff: true,
                ymin: CONFIG.years[0], ymax: CONFIG.years.at(-1), pmin: null, pmax: null,
                keyword: "", cursor: "", page: 1, busy: false };

/* ---------- helpers + input safety ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cleanQuery = v => String(v).replace(/[\u0000-\u001f<>"'`\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const safeUrl = u => /^https:\/\/[\w.-]+\.(rbxcdn\.com|roblox\.com|roproxy\.com)\//.test(u || "") ? u : "";
const TITLES = { home: "Home", catalog: "Catalog", about: "About", contact: "Contact" };
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 1600);
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch { const a = document.createElement("textarea"); a.value = text; document.body.append(a); a.select(); document.execCommand("copy"); a.remove(); }
  toast(msg || "Copied to clipboard!");
}
const year = i => +i.created.slice(0, 4);
const setStatus = (t, err) => { const s = $("#status"); s.textContent = t || ""; s.classList.toggle("err", !!err); };
const el = html => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; };
const creatorLink = i => !Number(i.creatorId) ? esc(i.creator) :
  `<a href="https://www.roblox.com/${i.creatorType === "Group" ? "groups" : "users"}/${Number(i.creatorId)}/${i.creatorType === "Group" ? "group" : "profile"}" target="_blank" rel="noopener noreferrer">${esc(i.creator)}</a>`;

/* ---------- filtering + sorting ---------- */
function visibleItems() {
  const types = CATEGORIES[state.cat].types, [key, dir] = state.sort.split("_"), m = dir === "asc" ? 1 : -1;
  const val = i => key === "price" ? i.priceNum : i[key];
  return state.items
    .filter(i => year(i) >= state.ymin && year(i) <= state.ymax &&
      (!types || types.includes(i.type)) && (state.showOff || i.forSale) &&
      (state.pmin == null || (i.priceNum != null && i.priceNum >= state.pmin)) &&
      (state.pmax == null || (i.priceNum != null && i.priceNum <= state.pmax)))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;       // off-sale items last when sorting by price
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * m;
    });
}

/* ---------- rendering ---------- */
function tabs(box, entries, current, onPick) {
  box.innerHTML = "";
  entries.forEach(([val, label]) => {
    const a = el(`<a href="#" class="tab${val === current ? " on" : ""}">${label}</a>`);
    a.onclick = e => { e.preventDefault(); onPick(val); };
    box.append(a);
  });
}

function pager(list) {
  const pages = Math.max(1, Math.ceil(list.length / CONFIG.perPage));
  [$("#pager-top"), $("#pager-bottom")].forEach(box => {
    box.innerHTML = "";
    if (pages === 1 && !state.cursor) return;                  // nothing to page through: no pager (avoids a lone "1")
    if (state.page > 1) { const pv = el(`<a href="#">&lt;&lt; Prev</a>`); pv.onclick = e => { e.preventDefault(); state.page--; render(); }; box.append(pv); }
    box.append(document.createTextNode(` Page ${state.page} of ${pages} `));
    if (state.page < pages || state.cursor) { const nx = el(`<a href="#">Next &gt;&gt;</a>`); nx.onclick = e => { e.preventDefault(); next(pages); }; box.append(nx); }
  });
}

function render() {
  tabs($("#sources"), Object.entries(SOURCES), state.source, v => { state.source = v; state.cat = "All"; closeSide(); reload(); });
  const cats = state.source === "community" ? COMMUNITY_CATEGORIES : Object.keys(CATEGORIES);
  tabs($("#cats"), cats.map(g => [g, g]), state.cat, v => { state.cat = v; closeSide(); reload(); });
  $("#listtitle").textContent = `${state.cat === "All" ? "All Items" : state.cat}, ${SORTS[state.sort]}`;
  $("#sortbtn").textContent = SORTS[state.sort];
  $("#sortlist").querySelectorAll("li").forEach(li => li.classList.toggle("on", li.dataset.k === state.sort));

  const list = visibleItems(), pages = Math.max(1, Math.ceil(list.length / CONFIG.perPage));
  state.page = Math.min(state.page, pages);
  const grid = $("#grid"); grid.innerHTML = "";
  const shown = list.slice((state.page - 1) * CONFIG.perPage, state.page * CONFIG.perPage);
  shown.forEach(i => grid.append(card(i)));
  fillFavs(shown);
  pager(list);
  if (!state.busy) setStatus(list.length ? "" : ERR, !list.length);
}

const thumb = i => i.img ? `<img src="${esc(safeUrl(i.img))}" alt="" loading="lazy">` : `<div class="thumb">No image</div>`;
const fmtDate = s => { const [y, m, d] = (s || "").split("-"); return y ? `${+m}/${+d}/${y}` : "?"; };

function card(i) {
  const price = i.priceNum != null ? `<div class="rb">R$: ${i.priceNum}</div>` : i.forSale ? `<div class="rb">Free</div>` : `<div class="off">Off sale</div>`;
  const c = el(`<div class="card"><div class="tbox">${thumb(i)}</div><a class="nm" href="#"></a>
    <div class="ln"><b>Updated:</b> ${fmtDate(i.updated || i.created)}</div>
    <div class="ln"><b>Creator:</b> ${creatorLink(i)}</div>
    <div class="ln"><b>Number Sold:</b> ${i.sales.toLocaleString()}</div>
    <div class="ln"><b>Favorited:</b> <span data-fav="${i.id}">${i.favDone ? fmtFav(i.fav) : "…"}</span></div>
    <div class="ln"><b>ID:</b> <span class="copy-id" title="Click to copy ID">${i.id}</span></div>${price}</div>`);
  c.querySelector(".nm").textContent = i.name;
  c.querySelectorAll("a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (a.target) window.open(a.href, "_blank"); else showDetail(i); }));
  c.querySelector(".copy-id").onclick = e => { e.stopPropagation(); copyText(i.id, `ID ${i.id} copied!`); };
  c.onclick = () => showDetail(i);
  return c;
}

/* ---------- detail: 2D by default, 3D on demand ---------- */
function showDetail(i) {
  Viewer.hide3D();
  $("#dbox").hidden = false; $("#dt").textContent = i.name;
  $("#detail").innerHTML = `
    <div id="viewer"><img class="v2d" alt=""><div id="vtog">
      <button class="btn blue on" id="b2d">2D</button><button class="btn blue" id="b3d">3D</button>
    </div></div>
    <div id="info"><h2></h2><table>
      <tr><td>Item ID</td><td><span class="copy-id" id="d-id" title="Click to copy">${i.id}</span></td></tr>
      <tr><td>Type</td><td><span class="tag">${esc(i.type)}</span></td></tr>
      <tr><td>Creator</td><td>${creatorLink(i)}</td></tr>
      <tr><td>Created</td><td>${esc(i.created)}</td></tr>
      <tr><td>Last updated</td><td>${esc(i.updated || "?")}</td></tr>
      <tr><td>Price</td><td class="price">${esc(i.price)}</td></tr><tr><td>Number Sold</td><td>${i.sales.toLocaleString()}</td></tr>
      <tr><td>Description</td><td class="d-desc"></td></tr>
    </table></div>`;
  $("#info h2").textContent = i.name; $(".d-desc").textContent = i.desc;
  $("#viewer .v2d").src = safeUrl(i.img);
  $("#d-id").onclick = () => copyText(i.id, `ID ${i.id} copied!`);
  const mode = m => { $("#b2d").classList.toggle("on", m === "2d"); $("#b3d").classList.toggle("on", m === "3d"); };
  $("#b2d").onclick = () => { Viewer.hide3D(); $("#vmsg")?.remove(); $("#viewer .v2d").hidden = false; mode("2d"); };
  $("#b3d").onclick = async () => {
    mode("3d"); $("#vmsg")?.remove();
    const msg = el(`<div id="vmsg">Loading 3D model…</div>`); $("#viewer").append(msg);
    try { await Viewer.show3D($("#viewer"), i.id); $("#viewer .v2d").hidden = true; msg.remove(); }
    catch { msg.textContent = "No 3D model available for this item."; mode("2d"); }
  };
  $("#catalog").scrollIntoView({ behavior: "smooth" });
}
function closeDetail() { Viewer.hide3D(); $("#dbox").hidden = true; $("#detail").innerHTML = ""; }

/* ---------- loading from the Roblox API ---------- */
// Keeps fetching API pages until a full display page of era items exists (or the API runs out)
async function load(reset) {
  if (state.busy) return; state.busy = true;
  if (reset) { state.items = []; state.cursor = ""; state.page = 1; render(); }
  setStatus("Loading…");
  const need = reset ? CONFIG.perPage : state.items.length ? visibleItems().length + CONFIG.perPage : CONFIG.perPage;
  try {
    const q = state.keyword, known = new Set(state.items.map(x => x.id));
    if (/^\d+$/.test(q)) {
      const d = await Api.details(q); state.cursor = "";
      if (d) { await Api.thumbnails([d]); state.items.push(d); }
    } else {
      const cat = CATEGORIES[state.cat].api || "";
      for (let tries = 0; tries < 4; tries++) {
        const r = await Api.browse(q, state.cursor, state.source, cat);
        const fresh = r.items.filter(x => !known.has(x.id)); fresh.forEach(x => known.add(x.id));
        await Api.thumbnails(fresh); state.items.push(...fresh); state.cursor = r.cursor;
        render();
        if (!state.cursor || visibleItems().length >= need) break;
      }
    }
  } catch { state.items = reset ? [] : state.items; state.cursor = ""; }
  state.busy = false; render();
}
const reload = () => load(true);

// "Favorited: N times" is fetched only for the cards on screen, through the throttled queue
const fmtFav = v => v == null ? "N/A" : v.toLocaleString() + " times";
function fillFavs(items) {
  items.filter(i => !i.favDone && !i.favBusy).forEach(async i => {
    i.favBusy = true; i.fav = await Api.favCount(i.id); i.favDone = true; i.favBusy = false;
    document.querySelectorAll(`[data-fav="${i.id}"]`).forEach(e => e.textContent = fmtFav(i.fav));
  });
}

async function next(pages) {
  if (state.page < pages) { state.page++; render(); }
  else if (state.cursor) { const before = visibleItems().length; await load(false); if (visibleItems().length > before) state.page++; render(); }
  $("#catalog").scrollIntoView({ behavior: "smooth" });
}

function setSort(k) { state.sort = k; state.page = 1; render(); }

/* ---------- routing: URL + title follow the section (#home / #catalog / #about / #contact) ---------- */
function setPage(name) {
  document.title = `${TITLES[name]} | ROBLOX Catalog Visualizer`;
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("on", a.dataset.page === name));
}
function route() {
  const h = location.hash.slice(1), name = TITLES[h] ? h : "home", page = name === "about" || name === "contact" ? name : "home";
  if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
  document.querySelectorAll(".page").forEach(p => p.hidden = p.id !== "page-" + page);
  setPage(name);
  if (name === "catalog") $("#catalog").scrollIntoView({ behavior: "smooth" }); else scrollTo({ top: 0 });
}
let scrollTick;                                   // while scrolling the main page, switch #home <-> #catalog
addEventListener("scroll", () => {
  if ($("#page-home").hidden) return;
  cancelAnimationFrame(scrollTick);
  scrollTick = requestAnimationFrame(() => {
    const name = $("#catalog").getBoundingClientRect().top < innerHeight * .45 ? "catalog" : "home";
    if (location.hash !== "#" + name) { history.replaceState(null, "", "#" + name); setPage(name); }
  });
}, { passive: true });

/* ---------- mobile filter drawer ---------- */
function openSide() { $("#side").classList.add("open"); $("#backdrop").hidden = false; document.body.classList.add("noscroll"); }
function closeSide() { $("#side").classList.remove("open"); $("#backdrop").hidden = true; document.body.classList.remove("noscroll"); }
$("#filtertoggle").onclick = openSide;
["#sideclose", "#sideclose-x", "#backdrop"].forEach(s => $(s).onclick = closeSide);

/* ---------- init ---------- */
const search = () => { state.keyword = cleanQuery($("#q").value); $("#q").value = state.keyword; load(true); $("#catalog").scrollIntoView({ behavior: "smooth" }); };
$("#go").onclick = search;
$("#q").onkeydown = e => { if (e.key === "Enter") search(); };
$("#showoff").onchange = e => { state.showOff = e.target.checked; state.page = 1; render(); };
const num = v => v === "" || !Number.isFinite(+v) ? null : Math.min(1e9, Math.max(0, Math.floor(+v)));
function readFilters() {
  const lo = CONFIG.years[0], hi = CONFIG.years.at(-1);
  let a = Math.min(hi, Math.max(lo, +$("#ymin").value || lo)), b = Math.min(hi, Math.max(lo, +$("#ymax").value || hi));
  if (a > b) [a, b] = [b, a];
  state.ymin = a; state.ymax = b; state.pmin = num($("#pmin").value); state.pmax = num($("#pmax").value); state.page = 1; render();
}
["ymin", "ymax", "pmin", "pmax"].forEach(id => $("#" + id).onchange = readFilters);
$("#ymin").value = CONFIG.years[0]; $("#ymax").value = CONFIG.years.at(-1);
$("#sortlist").append(...Object.entries(SORTS).map(([k, v]) => { const li = el(`<li data-k="${k}">${v}</li>`); li.onclick = () => { $("#sortlist").hidden = true; setSort(k); }; return li; }));
$("#sortbtn").onclick = e => { e.stopPropagation(); $("#sortlist").hidden = !$("#sortlist").hidden; };
addEventListener("click", () => $("#sortlist").hidden = true);
$("#close").onclick = closeDetail;
addEventListener("keydown", e => { if (e.key === "Escape") { closeDetail(); closeSide(); } });
$("#peek-img")?.addEventListener("error", e => e.target.remove());
$("#email").textContent = CONFIG.contactEmail;
$("#email").onclick = e => { e.preventDefault(); copyText(CONFIG.contactEmail, "Copied to clipboard!"); };
addEventListener("hashchange", route);
route(); render(); load(true);
