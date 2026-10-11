/* ===== App: state, rendering, routing ===== */
const $ = s => document.querySelector(s);
const SOURCES = { roblox: "ROBLOX", community: "Community" };
const SORTS = { relevance: "Relevance", created_desc: "Newest Created", created_asc: "Oldest Created", price_asc: "Lowest Price", price_desc: "Highest Price" };
const ERR = "There was a problem connecting to the server. Please try again later.";
const savedAdvanced = (() => { try { return localStorage.getItem("rcv:advanced") === "1"; } catch { return false; } })();
const state = { items: [], seen: new Set(), feeds: [], failed: [], expanded: false, direct: false, terms: [], ord: 0, gen: 0, err: false, adv: savedAdvanced,
                cat: "All", source: "roblox", sort: "relevance", showOff: true,
                ymin: CONFIG.years[0], ymax: CONFIG.years.at(-1), pmin: null, pmax: null,
                keyword: "", page: 1, busy: false, cur: null, detailTok: 0 };

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
const uid = i => (i.kind === "Bundle" ? "b" : "a") + i.id;                       // asset and bundle ids live in different spaces
const eraFree = i => i.kind === "Bundle" && CONFIG.packagesIgnoreEra;           // Packages (bundles) skip the 2006-2013 date filter
const hasDate = i => /^\d{4}-\d{2}-\d{2}$/.test(i.created || "");
// Roblox sometimes leaves the creation date out. Such an item is not thrown away: it counts as "in era" when its (growing) asset id is old enough.
const inEra = i => eraFree(i) || (hasDate(i) ? year(i) >= CONFIG.years[0] && year(i) <= CONFIG.years.at(-1) : Number(i.id) <= CONFIG.maxAssetId);
// the Community tab must not show Roblox's own items (the broad community query returns them too)
const sourceOk = i => state.source !== "community" || !(Number(i.creatorId) === 1 && i.creatorType === "User");
const el = html => { const d = document.createElement("div"); d.innerHTML = html.trim(); return d.firstChild; };
const creatorLink = i => !Number(i.creatorId) ? esc(i.creator) :
  `<a href="https://www.roblox.com/${i.creatorType === "Group" ? "groups" : "users"}/${Number(i.creatorId)}/${i.creatorType === "Group" ? "group" : "profile"}" target="_blank" rel="noopener noreferrer">${esc(i.creator)}</a>`;
const fmtDate = s => { const [y, m, d] = (s || "").split("-"); return y ? `${+m}/${+d}/${y}` : "?"; };
const fmtFav = v => v == null ? "N/A" : v.toLocaleString() + " times";
// "Free" only when Roblox says so explicitly. A missing price is unknown -> "—", never "Free".
// A bare "price 0" is not trusted on its own: it shows "…" until the official price check (api/price.js) confirms it.
const priceText = i => {
  if (i.priceNum > 0) return "R$ " + i.priceNum.toLocaleString();
  if (i.priceNum === 0 && (i.free || i.forSale)) return (i.priceSure || i.pv || !Api.canVerify()) ? "Free" : "…";
  return "—";
};
const priceCls = i => { const t = priceText(i); return t === "—" || t === "…" ? "off" : "rb"; };

// Verified prices: the items on screen are re-checked against Roblox's own item endpoint (batched, once per item)
const vPending = new Set(); let vTimer = 0;
function paintPrices(list) {
  list.forEach(i => {
    document.querySelectorAll(`[data-pid="${uid(i)}"]`).forEach(e => { e.textContent = priceText(i); e.classList.toggle("rb", priceCls(i) === "rb"); e.classList.toggle("off", priceCls(i) !== "rb"); });
    document.querySelectorAll(`[data-sid="${uid(i)}"]`).forEach(e => e.textContent = statusText(i));
  });
}
function queueVerify(items) {
  if (!Api.canVerify()) return;
  items.forEach(i => { if (!i.pv && !i.pvTried) { i.pvTried = true; vPending.add(i); } });
  if (!vPending.size) return;
  clearTimeout(vTimer);
  vTimer = setTimeout(async () => {
    const batch = [...vPending]; vPending.clear();
    let changed = false;
    try { changed = await Api.verifyPrices(batch); } catch { /* keep the search-result prices */ }
    paintPrices(batch);                                     // cards, detail view and related row already on screen
    if (changed) render();                                  // sort / price filter / "Show Off Sale" may depend on the new values
  }, 250);
}
const statusText = i => i.forSale ? "On sale" : "Off sale";

function setStatus(text, err, action) {
  const s = $("#status"); s.textContent = text || ""; s.classList.toggle("err", !!err);
  if (text && action) { const a = el(`<a href="#">${esc(action.label)}</a>`); a.onclick = e => { e.preventDefault(); action.fn(); }; s.append(" ", a); }
}

/* ---------- search words ---------- */
const words = s => String(s).toLowerCase().match(/[a-z0-9\u00c0-\u024f]+/g) || [];
const searchTerms = () => words(state.keyword).filter(w => w.length >= 2);
const uniqueWords = kw => [...new Set(words(kw))].filter(w => w.length >= 3);
// an item is shown when ANY typed word is contained in its name
const nameMatches = i => !state.terms.length || state.terms.some(w => i.name.toLowerCase().includes(w));
function scoreOf(i) {
  if (!state.terms.length) return 0;
  const n = i.name.toLowerCase(), nw = words(n);
  let s = n.includes(state.keyword.toLowerCase()) ? 4 : 0;
  state.terms.forEach(w => { if (nw.includes(w)) s += 2; else if (n.includes(w)) s += 1; });
  return s;
}

/* ---------- filtering + sorting ---------- */
function visibleItems() {
  if (state.direct) return state.items.filter(inEra);
  const types = CATEGORIES[state.cat].types;
  const list = state.items.filter(i => inEra(i) && (eraFree(i) || !hasDate(i) || (year(i) >= state.ymin && year(i) <= state.ymax)) &&
    (!types || types.includes(i.type)) && (state.showOff || i.forSale) &&
    (state.pmin == null || (i.priceNum != null && i.priceNum >= state.pmin)) &&
    (state.pmax == null || (i.priceNum != null && i.priceNum <= state.pmax)));
  if (state.sort === "relevance") return list.sort((a, b) => (b.score - a.score) || (a.ord - b.ord));
  const [key, dir] = state.sort.split("_"), m = dir === "asc" ? 1 : -1;
  const val = i => key === "price" ? i.priceNum : i[key];
  return list.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x == null && y == null) return a.ord - b.ord;
    if (x == null) return 1; if (y == null) return -1;           // off-sale items last when sorting by price
    return ((typeof x === "string" ? x.localeCompare(y) : x - y) * m) || (a.ord - b.ord);
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

// 1 ... 4 5 [6] 7 8 ... 12   (numbers around the current page, plus first and last)
function pageNums(cur, total) {
  const out = [], a = Math.max(1, cur - 2), b = Math.min(total, cur + 2);
  if (a > 1) { out.push(1); if (a > 2) out.push("…"); }
  for (let p = a; p <= b; p++) out.push(p);
  if (b < total) { if (b < total - 1) out.push("…"); out.push(total); }
  return out;
}

function pager(n) {
  const loadedPages = Math.max(1, Math.ceil(n / CONFIG.perPage)), more = hasMore();
  const pages = loadedPages + (more ? 1 : 0), cur = state.page;
  const link = (txt, fn) => { const a = el(`<a href="#">${txt}</a>`); a.onclick = e => { e.preventDefault(); fn(); }; return a; };
  [$("#pager-top"), $("#pager-bottom")].forEach(box => {
    box.innerHTML = "";
    if (pages === 1 && !more) return;                           // nothing to page through
    if (cur > 1) box.append(link("&lt;&lt; Prev", () => goPage(cur - 1)));
    pageNums(cur, pages).forEach(p => {
      if (p === "…") box.append(el(`<span class="dots">…</span>`));
      else if (p === cur) box.append(el(`<b>${p}</b>`));
      else box.append(link(p, () => goPage(p)));
    });
    if (more) box.append(el(`<span class="dots">…</span>`));    // Roblox does not tell the total, so more pages appear as they load
    if (cur < pages || more) box.append(link("Next &gt;&gt;", () => goPage(cur + 1)));
  });
}

function updateStatus(count) {
  if (state.busy) return setStatus("Loading…");
  if (count) return setStatus("");
  if (state.err) return setStatus("Roblox is temporarily rate-limiting this search.", true, { label: "Try again", fn: reload });
  if (hasMore()) return setStatus(state.keyword ? "No matching items found yet." : "No items found yet.", false, { label: "Search deeper", fn: more });
  setStatus(state.keyword ? "Your search did not find any items." : "No items found.");
}

function render() {
  tabs($("#sources"), Object.entries(SOURCES), state.source, v => { state.source = v; state.cat = "All"; closeSide(); reload(); });
  const cats = state.source === "community" ? COMMUNITY_CATEGORIES : Object.keys(CATEGORIES).filter(c => !UNAVAILABLE_CATS.includes(c));
  tabs($("#cats"), cats.map(g => [g, g]), state.cat, v => { state.cat = v; closeSide(); reload(); });
  // categories that do not load: grey text, not clickable, with a tip
  const off = $("#cats-off"); off.innerHTML = "";
  if (state.source !== "community") UNAVAILABLE_CATS.forEach(name => {
const s = el(`<span class="tab off" aria-disabled="true" title="Currently unavailable for analysis">${esc(name)}</span>`);
    off.append(s);
  });
  $("#listtitle").textContent = `${state.cat === "All" ? "All Items" : state.cat}, ${SORTS[state.sort]}`;
  $("#sortbtn").textContent = SORTS[state.sort];
  $("#sortlist").querySelectorAll("li").forEach(li => li.classList.toggle("on", li.dataset.k === state.sort));

  const list = visibleItems(), pages = Math.max(1, Math.ceil(list.length / CONFIG.perPage));
  state.page = Math.min(state.page, pages);
  const grid = $("#grid"); grid.innerHTML = "";
  const shown = list.slice((state.page - 1) * CONFIG.perPage, state.page * CONFIG.perPage);
  shown.forEach(i => grid.append(card(i)));
  if (state.adv) { fillFavs(shown); fillAdvanced(shown); }
  queueVerify(shown);
  pager(list.length);
  updateStatus(list.length);
}

const thumb = i => i.img ? `<img src="${esc(safeUrl(i.img))}" alt="" loading="lazy">` : `<div class="thumb">No image</div>`;
const cell = (k, v, cls = "") => `<div class="c ${cls}"><small class="k">${k}</small><span class="v">${v}</span></div>`;
const priceCell = i => `<div class="c"><small class="k">Price</small><span class="v ${priceCls(i)}" data-pid="${uid(i)}">${esc(priceText(i))}</span></div>`;
const statusCell = i => cell("Status", `<span data-sid="${uid(i)}">${statusText(i)}</span>`);
const favCell = i => cell("Favorited", `<span class="fav-count" data-fav="${i.id}">${i.favDone ? fmtFav(i.fav) : "…"}</span>`, "advonly wide");

function card(i) {
  const c = el(`<div class="card"><div class="tbox">${thumb(i)}</div><a class="nm" href="#"></a>
    <div class="info">
      ${cell("Released", fmtDate(i.created))}${cell("Creator", creatorLink(i))}
      ${cell("ID", `<span class="copy-id" title="Click to copy ID">${i.id}</span>`)}${cell("Type", esc(i.type))}
      ${statusCell(i)}${priceCell(i)}
      ${cell("Updated", fmtDate(i.updated || i.created), "advonly")}
      ${favCell(i)}
    </div></div>`);
  c.querySelector(".nm").textContent = i.name;
  c.querySelector(".nm").title = i.name;
  c.querySelectorAll("a").forEach(a => a.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); if (a.target) window.open(a.href, "_blank"); else showDetail(i); }));
  c.querySelector(".copy-id").onclick = e => { e.stopPropagation(); copyText(i.id, `ID ${i.id} copied!`); };
  c.onclick = () => showDetail(i);
  return c;
}

// "Favorited" is only fetched when Advanced Info is on, and only for the cards on screen
function fillFavs(items) {
  items.filter(i => !i.favDone && !i.favBusy).forEach(async i => {
    i.favBusy = true; i.fav = await Api.favCount(i.id); i.favDone = true; i.favBusy = false;
    document.querySelectorAll(`[data-fav="${i.id}"]`).forEach(e => e.textContent = fmtFav(i.fav));
  });
}

// Search responses omit sales and update time. Hydrate only visible cards after
// Advanced Info is requested, so normal catalog loading stays fast.
function fillAdvanced(items) {
  items.filter(i => !i.advancedDone && !i.advancedBusy && i.kind !== "Bundle").forEach(async i => {
    i.advancedBusy = true;
    try {
      const full = await Api.details(i.id);
      if (full) {
        // Price priority: verified price > search price > economy. Economy may only turn an unsure 0 / unknown into a real positive price
        // (it used to overwrite a correct 450 R$ with 0 / "Free").
        const before = { priceNum: i.priceNum, free: i.free, forSale: i.forSale, priceSure: i.priceSure };
        Object.assign(i, full, { img: i.img, fav: i.fav, favDone: i.favDone });
        if (i.pv || (before.priceNum != null && !(before.priceNum === 0 && full.priceNum > 0))) Object.assign(i, before);
        paintPrices([i]);
        if (state.cur === i && !$("#dbox").hidden) {
          const setDetail = (label, value) => Array.from($("#info .igrid").querySelectorAll(".c")).find(c => c.querySelector(".k")?.textContent === label)?.querySelector(".v").replaceChildren(document.createTextNode(value));
          setDetail("Last updated", fmtDate(i.updated || i.created));
          setDetail("Tradeable", i.tradeable ? "Yes" : "No");
        }
      }
    } catch { /* Keep the catalog-search fields if the optional request fails. */ }
    i.advancedDone = true; i.advancedBusy = false;
    if (state.adv) render();
  });
}

/* ---------- detail (2D) + Related Items ---------- */
function showDetail(i) {
  const tok = ++state.detailTok; state.cur = i;
  $("#dbox").hidden = false; $("#dt").textContent = i.name;
  $("#detail").innerHTML = `
    <div id="viewer"><div class="view-switch" role="group" aria-label="Preview mode"><button type="button" class="view-mode on">2D</button><button type="button" class="view-mode unavailable" disabled title="3D models are not available yet.">3D</button></div><div class="view-stage"><img class="v2d" alt=""></div></div>
    <div id="info"><h2></h2>
      <div class="igrid">
      ${cell("Item ID", `<span class="copy-id" id="d-id" title="Click to copy">${i.id}</span>`)}${cell("Creator", creatorLink(i))}
        ${cell("Type", esc(i.type), "advonly")}${cell("Tradeable", i.tradeable ? "Yes" : "No", "advonly")}
        ${cell("Released", esc(fmtDate(i.created)))}${statusCell(i)}
        ${priceCell(i)}
        ${cell("Last updated", esc(fmtDate(i.updated || i.created)), "advonly")}
        ${cell("Favorited", `<span data-fav="${i.id}">${i.favDone ? fmtFav(i.fav) : "…"}</span>`, "advonly")}
      </div>
      <div class="d-desc"></div>
      <a class="rbxlink" href="https://www.roblox.com/${i.kind === "Bundle" ? "bundles" : "catalog"}/${Number(i.id)}" target="_blank" rel="noopener noreferrer">See on Roblox &gt;&gt;</a>
    </div>
    <div id="related"><div class="rhead">Related Items <span class="rhint" hidden>scroll &rarr;</span></div>
      <div id="relwrap"><button type="button" class="relnav prev" aria-label="Previous related items" disabled>&#8249;</button><div id="relbody" tabindex="0">Loading…</div><button type="button" class="relnav next" aria-label="More related items" disabled>&#8250;</button></div></div>`;
  $("#info h2").textContent = i.name; $(".d-desc").textContent = i.desc;
  const img = $("#viewer .v2d"); img.src = safeUrl(i.img);
  Api.bigThumb(i).then(u => { if (tok === state.detailTok && u && safeUrl(u)) img.src = u; });
  $("#d-id").onclick = () => copyText(i.id, `ID ${i.id} copied!`);
  if (state.adv) { fillFavs([i]); fillAdvanced([i]); }
  queueVerify([i]);
  loadRelated(i, tok);
  $("#catalog").scrollIntoView({ behavior: "smooth" });
}
function closeDetail() { state.detailTok++; state.cur = null; $("#dbox").hidden = true; $("#detail").innerHTML = ""; }

// Related = same "style" (the meaningful words of the name) + words of the current search, then same-type items.
// ALWAYS tries to reach CONFIG.relatedMax (12): the first 6 are visible, the rest are reached by scrolling the row horizontally.
// The row used to be built only from items already loaded, so categories that load few items (clothing, faces...) ended with
// 2-5 related items = nothing to scroll. Now, when there are not enough, whole catalog pages of the SAME category are fetched to fill it.
const relCache = new Map();
function relatedList(best, item, pool) {
  const out = [], seen = new Set([uid(item)]);
  const push = c => { if (c && !seen.has(uid(c)) && inEra(c)) { seen.add(uid(c)); out.push(c); } };
  best.forEach(push);                                                        // same style words first
  [...pool.values()].filter(c => c.type === item.type).forEach(push);       // same type next
  [...pool.values()].forEach(push);                                          // anything else as the last filler
  return out.slice(0, CONFIG.relatedMax);
}
async function loadRelated(item, tok) {
  const body = () => tok === state.detailTok ? $("#relbody") : null;
  try {
    if (relCache.has(uid(item))) return showRelated(relCache.get(uid(item)), body());
    const kw = searchTerms();
    const key = [...new Set(words(item.name))].filter(w => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w));
    const pick = key.slice().sort((a, b) => (kw.includes(b) - kw.includes(a)) || b.length - a.length).slice(0, 2);
    const pool = new Map(), add = c => { if (c && uid(c) !== uid(item) && inEra(c)) pool.set(uid(c), c); };
    state.items.forEach(add);
    const src = item.creatorId === 1 && item.creatorType === "User" ? "roblox" : "community";
    const feed = TYPE_FEED[item.type] || "Accessories";
    const score = c => {
      const n = c.name.toLowerCase(), cw = words(n); let s = 0;
      key.forEach(w => { if (cw.includes(w)) s += 3; else if (n.includes(w)) s += 1.5; });
      kw.forEach(w => { if (n.includes(w)) s += 2; });
      if (c.type === item.type) s += .5;
      return s;
    };
    const best = () => [...pool.values()].map(c => ({ c, s: score(c) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).map(x => x.c);
    const enough = () => relatedList(best(), item, pool).length >= CONFIG.relatedMax;

    // 1) live searches for the style words
    for (const w of pick) {
      if (tok !== state.detailTok) return;
      try {
        const page = await Api.searchPage(w, "", src, feed);
        page.items.filter(c => uid(c) !== uid(item) && c.name.toLowerCase().includes(w)).forEach(add);
      } catch { /* one failed search must not hide the related row */ }
    }
    // 2) still not 12? read plain pages of the same category until the row is full.
    //    A community item has a small classic pool, so after its own source the Roblox-made items of the same type complete the row.
    for (const from of src === "roblox" ? ["roblox"] : ["community", "roblox"]) {
      let cur = "", vi = 0, lim = 0;
      for (let n = 0; n < CONFIG.relatedPages && !enough(); n++) {
        if (tok !== state.detailTok) return;
        try {
          const page = await Api.searchPage("", cur, from, feed, vi, lim);
          vi = page.vi; lim = page.lim; cur = page.cursor;
          page.items.forEach(add);
          if (!cur) break;
        } catch { break; }
      }
      if (enough()) break;
    }
    if (tok !== state.detailTok) return;
    const list = relatedList(best(), item, pool);
    await Api.thumbnails(list);
    relCache.set(uid(item), list);
    if (tok !== state.detailTok) return;
    showRelated(list, body());
  } catch { const b = body(); if (b) b.textContent = "Could not load related items."; }
}
function showRelated(list, box) {
  if (!box) return;
  if (!list.length) { box.textContent = "No related items found."; return; }
  box.innerHTML = "";
  list.forEach(c => {
    const d = el(`<div class="rcard"><div class="rt">${thumb(c)}</div><a class="rn" href="#"></a><span class="rp ${priceCls(c)}" data-pid="${uid(c)}">${esc(priceText(c))}</span></div>`);
    d.querySelector(".rn").textContent = c.name; d.querySelector(".rn").title = c.name;
    d.onclick = e => { e.preventDefault(); showDetail(c); };
    box.append(d);
  });
  initRelScroll();
  queueVerify(list);
}
// Arrows + hint make the horizontal row obvious (mobile browsers hide scrollbars). One click moves a whole "page" of 6.
function initRelScroll() {
  const body = $("#relbody"), wrap = $("#relwrap"); if (!body || !wrap) return;
  const prev = wrap.querySelector(".prev"), next = wrap.querySelector(".next"), hint = $(".rhint");
  const update = () => {
    const max = body.scrollWidth - body.clientWidth;
    prev.disabled = body.scrollLeft <= 2; next.disabled = body.scrollLeft >= max - 2;
    wrap.classList.toggle("scrollable", max > 2); wrap.classList.toggle("at-end", body.scrollLeft >= max - 2); if (hint) hint.hidden = !(max > 2);
  };
  const step = dir => body.scrollBy({ left: dir * Math.max(120, body.clientWidth - 20), behavior: "smooth" });
  prev.onclick = () => step(-1); next.onclick = () => step(1);
  body.onscroll = update;
  if (window.ResizeObserver) new ResizeObserver(update).observe(body);
  update(); requestAnimationFrame(update);
}

/* ---------- loading from the Roblox API ---------- */
// One feed per catalog category (see CAT_QUERY). "All" walks several feeds in turn, so no category gets drowned out.
// Community clothing is split into Shirts / T-Shirts / Pants feeds so each type gets its own pages.
function feedKeys() {
  if (state.source === "community") return state.cat === "All" ? ["Shirts", "T-Shirts", "Pants"] : [CATEGORIES[state.cat].feed];
  return state.cat === "All" ? ALL_CATS : [CATEGORIES[state.cat].feed];
}
const makeFeeds = kw => feedKeys().map(key => ({ kw, key, cursor: "", done: false, errs: 0, vi: 0, lim: 0 }));
const canExpand = () => !state.expanded && uniqueWords(state.keyword).length >= 2;
const hasMore = () => !state.direct && (state.feeds.some(f => !f.done) || canExpand());
// Several words: after the exact phrase is exhausted, search each word on its own (an item matches if ANY word is in its name)
function expandFeeds() {
  if (!canExpand()) return false;
  state.expanded = true;
  uniqueWords(state.keyword).slice(0, 3).forEach(w => state.feeds.push(...makeFeeds(w)));
  return true;
}

const typeOk = i => { const t = CATEGORIES[state.cat].types; return !t || t.includes(i.type); };
async function addItems(list, gen, direct, feed) {
  const fresh = direct ? list.filter(inEra) : list.filter(i => inEra(i) && typeOk(i) && nameMatches(i) && sourceOk(i));
  // "All": results of the different feeds are interleaved (hat, shirt, face, hat, shirt...) instead of 120 hats first
  const n = Math.max(1, state.feeds.length), at = feed ? Math.max(0, state.feeds.indexOf(feed)) : 0;
  fresh.forEach(i => { i.ord = feed ? (feed.cnt = (feed.cnt || 0) + 1, (feed.cnt - 1) * n + at) : state.ord++; i.score = scoreOf(i); });
  await Api.thumbnails(fresh);
  if (gen !== state.gen) return;
  state.items.push(...fresh);
  lateThumbs(fresh, 1, gen);
  render();
}
// thumbnails Roblox was still generating: try again a few times
function lateThumbs(items, n, gen) {
  const miss = items.filter(i => !i.img);
  if (!miss.length || n > 3) return;
  setTimeout(async () => {
    if (gen !== state.gen) return;
    await Api.thumbnails(miss);
    if (gen === state.gen) { render(); lateThumbs(miss, n + 1, gen); }
  }, 2500 * n);
}

async function pullFeed(f, gen) {
  let page;
  try { page = await Api.searchPage(f.kw, f.cursor, state.source, f.key, f.vi, f.lim); state.err = false; f.vi = page.vi; f.lim = page.lim; }
  catch {
    f.errs++; f.retryAt = Date.now() + Math.min(30000, 3000 * f.errs);
    state.err = true; return;
  }
  if (gen !== state.gen) return;
  f.cursor = page.cursor; f.pulled = (f.pulled || 0) + 1; if (!page.cursor) f.done = true;
  const items = page.items.filter(i => !state.seen.has(uid(i))); items.forEach(i => state.seen.add(uid(i)));
  if (!items.length) return;
  const failed = [];
  if (gen !== state.gen) return;
  state.failed.push(...failed);
  await addItems(items, gen, false, f);
}

// Keeps pulling search pages until `need` visible items exist (or the pull budget / the API runs out)
async function pull(gen, need) {
  let pulls = 0;
  const maxPulls = state.source === "community" ? CONFIG.maxPullsCommunity : CONFIG.maxPulls;
  while (pulls < maxPulls) {
    let active = state.feeds.filter(f => !f.done && (!f.retryAt || f.retryAt <= Date.now()));
    if (!active.length && expandFeeds()) active = state.feeds.filter(f => !f.done && (!f.retryAt || f.retryAt <= Date.now()));
    if (!active.length) break;
    for (const f of active) {
      if (gen !== state.gen) return;
      await pullFeed(f, gen); pulls++;
      // "All" must touch EVERY feed once (faces, heads, packages, shirts...) before it may stop because enough items were found
      if (gen !== state.gen || (visibleItems().length >= need && state.feeds.every(x => x.pulled || x.done)) || pulls >= maxPulls) break;
    }
    if (visibleItems().length >= need && state.feeds.every(x => x.pulled || x.done)) break;
  }
  // items whose details failed (rate limit): one more try
  if (gen === state.gen && state.failed.length) {
    const ids = state.failed.splice(0); await sleep(1200);
    const { items, failed } = await Api.detailsBatch(ids);
    if (gen !== state.gen) return;
    state.failed.push(...failed); await addItems(items, gen);
  }
}

// New search / category / refresh. Starting a new one cancels the old one (that was the "All is buggy" race).
async function reload() {
  const gen = ++state.gen;
  Object.assign(state, { items: [], seen: new Set(), feeds: [], failed: [], expanded: false, ord: 0, page: 1, err: false, busy: true,
    direct: /^\d+$/.test(state.keyword), terms: searchTerms() });
  setStatus("Loading…"); render();
  try {
    if (state.direct) { const d = await Api.details(state.keyword); if (gen === state.gen && d) await addItems([d], gen, true); }
    else {
      state.feeds = makeFeeds(state.keyword); await pull(gen, CONFIG.perPage * CONFIG.prefetchPages);
      // community clothing is a huge pool with few classic items: if not even one page was found, keep scanning on its own
      for (let r = 0; r < CONFIG.autoDeepen && gen === state.gen && visibleItems().length < CONFIG.perPage && hasMore(); r++) await pull(gen, CONFIG.perPage);
    }
  } catch { if (gen === state.gen) state.err = true; }
  if (gen !== state.gen) return;
  state.busy = false; render();
}

async function more() {
  if (state.busy || !hasMore()) return;
  const gen = state.gen; state.busy = true; setStatus("Loading…");
  try { await pull(gen, visibleItems().length + CONFIG.perPage); } catch { if (gen === state.gen) state.err = true; }
  if (gen !== state.gen) return;
  state.busy = false; render();
}

async function goPage(p) {
  const pagesNow = () => Math.max(1, Math.ceil(visibleItems().length / CONFIG.perPage));
  if (p <= pagesNow()) { state.page = p; render(); }
  else if (!state.busy && hasMore()) { await more(); state.page = Math.min(p, pagesNow()); render(); }
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
// An empty search box = the default listing
const search = () => { state.keyword = cleanQuery($("#q").value); $("#q").value = state.keyword; reload(); $("#catalog").scrollIntoView({ behavior: "smooth" }); };
$("#go").onclick = search;
$("#q").onkeydown = e => { if (e.key === "Enter") search(); };
$("#q").oninput = e => { if (e.target.value === "" && state.keyword !== "") search(); };      // cleared the box -> back to the default listing
$("#refresh").onclick = () => { Api.bust = Date.now(); relCache.clear(); reload(); toast("Refreshing…"); };
$("#showoff").onchange = e => { state.showOff = e.target.checked; state.page = 1; render(); };
$("#adv").checked = state.adv;
document.body.classList.toggle("adv", state.adv);
$("#adv").onchange = e => {
  state.adv = e.target.checked; try { localStorage.setItem("rcv:advanced", state.adv ? "1" : "0"); } catch {} document.body.classList.toggle("adv", state.adv); render();
  if (state.adv && state.cur && !$("#dbox").hidden) { fillFavs([state.cur]); fillAdvanced([state.cur]); }
};
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
route(); render(); reload();
