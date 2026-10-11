/* ===== Network: one throttled queue + local cache, so Roblox does not answer 429 ===== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

const Net = {
  active: 0, max: 6, gap: 50, minGap: 50, last: 0, pauseUntil: 0, q: [],
  run(fn) { return new Promise((res, rej) => { this.q.push({ fn, res, rej }); this.pump(); }); },
  pump() {
    while (this.active < this.max && this.q.length) {
      const t = this.q.shift(); this.active++;
      const at = Math.max(Date.now(), this.last + this.gap, this.pauseUntil); this.last = at;
      setTimeout(() => t.fn().then(t.res, t.rej).finally(() => { this.active--; this.pump(); }), at - Date.now());
    }
  },
  slow() { this.gap = Math.min(400, this.gap + 40); },               // Roblox said 429: slow everybody down a bit
  ok()   { this.gap = Math.max(this.minGap, this.gap - 2); }         // ...and speed back up while things go well
};

const Cache = {
  get(k, ttl = 7 * 864e5) { try { const v = JSON.parse(localStorage.getItem("rcv:" + k)); if (v && Date.now() - v.t < ttl) return v.d; } catch {} return null; },
  set(k, d) { try { localStorage.setItem("rcv:" + k, JSON.stringify({ t: Date.now(), d })); } catch {} }
};

const Api = {
  noProxy: false,            // set when /api/rbx does not exist -> public mirrors
  bust: 0,                   // set by the Refresh button: makes search URLs skip the CDN cache
  pageSize: CONFIG.pageSize,

  url(service, path) {
    if (CONFIG.proxy && !this.noProxy)
      return `${CONFIG.proxy}?s=${service}&p=${encodeURIComponent(path)}` + (this.bust && path.includes("/search/") ? `&_=${this.bust}` : "");
    return CONFIG.api[service] + path;
  },

  async json(url, tries = 1) {
    let r;
    for (let n = 0; ; n++) {
      r = await Net.run(() => fetch(url));
      // Proxy missing (the host answered with a non-JSON 404): switch to the public mirror for this and later calls
      if (r.status === 404 && CONFIG.proxy && !this.noProxy && url.startsWith(CONFIG.proxy + "?") && !(r.headers.get("content-type") || "").includes("json")) {
        const q = new URL(url, location.href).searchParams;
        this.noProxy = true; Net.max = 3; Net.gap = Net.minGap = 140;
        console.warn("[RCV] " + CONFIG.proxy + " not found - using public mirror (rate limited). Deploy the api/ folder.");
        url = CONFIG.api[q.get("s")] + q.get("p"); continue;
      }
      if (r.status === 429) Net.slow(); else Net.ok();
      if (r.status !== 429 || n >= tries) break;
      Net.pauseUntil = Math.max(Net.pauseUntil, Date.now() + 1500 * 2 ** n);   // everyone waits, then retries
    }
    if (!r.ok) { const e = new Error(r.status); e.status = r.status; throw e; }
    return r.json();
  },

  // ---- Price rules (ONE place, used by search results, the verifier and the economy fallback) ----
  // Roblox spells priceStatus "Free" | "OffSale" | "NoResellers" (older responses: "Off Sale"), so it is normalised first.
  // Missing / non-numeric price = UNKNOWN (shown as "—"), never "Free". A Limited's listing price is often 0 or stale:
  // when it has resellers the market price is lowestPrice. priceSure = "this number is certain":
  // a positive price, or an explicit "Free" status. A bare price 0 is NOT certain and is double-checked (see verifyPrices).
  parsePrice(d) {
    const n = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const ps = String(d.priceStatus || "").replace(/[\s_-]/g, "").toLowerCase();
    const offSale = ps === "offsale" || ps === "noresellers";
    const price = n(d.price), low = n(d.lowestPrice);
    let cur = price;
    if (low != null && (price == null || price === 0 || offSale)) cur = low;      // resale market price
    // explicit "Free" status = free; a bare price 0 only counts when nothing says off sale and nobody resells it.
    // If the data contradicts itself (status Free but price > 0) the positive price wins.
    const free = ps === "free" ? (cur == null || cur === 0) : (cur === 0 && !offSale && low == null);
    const forSale = ps ? (ps === "free" || !offSale) : cur != null;
    return { priceNum: free ? 0 : cur, free, forSale, priceSure: (cur != null && cur > 0) || ps === "free" };
  },

  // Normalize an economy "asset details" response into our item shape.
  // PriceInRobux === null means "unknown / not priced here", NOT free: only an explicit 0 is free (and even that is unsure).
  toItem(d) {
    // Catalog item types only: skips Toolbox content (Models, Audio, Decals, Meshes, Scripts...)
    if (!ASSET_TYPES[d.AssetTypeId]) return null;
    const price = typeof d.PriceInRobux === "number" ? d.PriceInRobux : null;
    return {
      id: d.AssetId, name: d.Name, type: ASSET_TYPES[d.AssetTypeId],
      created: (d.Created || "").slice(0, 10), updated: (d.Updated || "").slice(0, 10),
      creator: d.Creator ? d.Creator.Name : "?", creatorId: d.Creator ? d.Creator.Id : 0, creatorType: d.Creator ? d.Creator.CreatorType : "User",
      priceNum: price, free: price === 0 && !!d.IsForSale, forSale: !!d.IsForSale, priceSure: price > 0, tradeable: !!d.IsLimited || !!d.IsLimitedUnique,
      sales: d.Sales || 0, fav: null, kind: "Asset",
      desc: d.Description || "", img: null
    };
  },

  // Search results (assets AND bundles). Packages are Bundles on Roblox (itemType "Bundle", bundleType BodyParts / 1).
  toSearchItem(d) {
    const isBundle = d.itemType === "Bundle";
    if (isBundle) {
      // only BodyParts bundles (= old Packages); animation bundles (2 / "AvatarAnimations") are not catalog "Packages"
      const bt = d.bundleType;
      if (bt != null && !(bt === 1 || bt === "1" || String(bt).toLowerCase() === "bodyparts")) return null;
    }
    else if (d.itemType !== "Asset" || !ASSET_TYPES[d.assetType]) return null;
    const pr = this.parsePrice(d);
    return { id: d.id, name: d.name || "?", type: isBundle ? "Package" : ASSET_TYPES[d.assetType],
      created: String(d.itemCreatedUtc || d.createdUtc || d.created || "").slice(0, 10), updated: "",
      creator: d.creatorName || "?", creatorId: d.creatorTargetId || 0, creatorType: d.creatorType || "User",
      priceNum: pr.priceNum, free: pr.free, forSale: pr.forSale, priceSure: pr.priceSure, tradeable: !!d.hasResellers,
      sales: 0, fav: d.favoriteCount == null ? null : d.favoriteCount, favDone: d.favoriteCount != null || isBundle,
      desc: d.description || "", img: null, kind: isBundle ? "Bundle" : "Asset" };
  },

  // ---- Price verification: the SAME endpoint the roblox.com item page uses (catalog items/details), through /api/price.
  // Search results can be up to an hour old (CDN cache) and an unsure "price 0" may really be 450 R$.
  // Called for the items on screen only (<=100 per request). Missing /api/price (static hosting) -> silently disabled.
  priceOff: false,
  canVerify() { return !!CONFIG.proxy && !this.noProxy && !this.priceOff; },
  applyPrice(i, p) {
    const ch = i.priceNum !== p.priceNum || i.free !== p.free || i.forSale !== p.forSale;
    Object.assign(i, { priceNum: p.priceNum, free: p.free, forSale: p.forSale, priceSure: true, pv: true });
    return ch;
  },
  async verifyPrices(items) {
    let changed = false;
    if (!this.canVerify()) return false;
    const uk = i => (i.kind === "Bundle" ? "b" : "a") + i.id, todo = [];
    items.forEach(i => { const c = Cache.get("p:" + uk(i), 3 * 60e3); if (c) changed = this.applyPrice(i, c) || changed; else todo.push(i); });
    for (let n = 0; n < todo.length; n += 100) {
      const chunk = todo.slice(n, n + 100), ids = k => chunk.filter(i => (i.kind || "Asset") === k).map(i => i.id).join(",");
      let res;
      try { res = await this.json(`/api/price?a=${ids("Asset")}&b=${ids("Bundle")}`); }
      catch (e) { if (e.status === 404 || e.status === 400 || e.status === 405) this.priceOff = true; continue; }   // not deployed -> stop asking
      (res.data || []).forEach(d => {
        const k = (String(d.itemType).toLowerCase().startsWith("b") || d.itemType === 2) ? "Bundle" : "Asset";
        const it = chunk.find(x => x.id === d.id && (x.kind || "Asset") === k); if (!it) return;
        const p = this.parsePrice(d); Cache.set("p:" + uk(it), p); changed = this.applyPrice(it, p) || changed;
      });
    }
    return changed;
  },

  async details(id) {
    const hit = Cache.get("d:" + id, 864e5); if (hit) return hit.skip ? null : { ...hit };
    try { const it = this.toItem(await this.json(this.url("economy", `/v2/assets/${id}/details`))); Cache.set("d:" + id, it || { skip: 1 }); return it; }   // non-catalog items are remembered too
    catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }   // missing = skip, server error = throw
  },

  async detailsEntry(entry) { return this.details(entry.id); },

  // Details for many ids at once (the queue limits real concurrency). Returns { items, failed } - failed ids can be retried later.
  async detailsBatch(entries, workers = 6) {
    const res = [], failed = [];
    let n = 0;
    await Promise.all(Array.from({ length: Math.min(workers, entries.length) }, async () => {
      while (n < entries.length) { const k = n++; try { const item = await this.detailsEntry(entries[k]); if (item) res.push(item); } catch { failed.push(entries[k]); } }
    }));
    return { items: res, failed };
  },

  async favCount(id) {
    const hit = Cache.get("f:" + id, 864e5); if (hit != null) return hit;
    try { const v = +(await this.json(this.url("catalog", `/v1/favorites/assets/${id}/count`))); if (Number.isFinite(v)) Cache.set("f:" + id, v); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  },

  // Fills item.img for a list of items (batch endpoints, up to 100 ids). Assets and bundles use different endpoints and id spaces.
  async thumbnails(items) {
    const ck = i => (i.kind === "Bundle" ? "tb:" : "t:") + i.id;
    items.forEach(i => { const t = Cache.get(ck(i)); if (t) i.img = t; });
    const need = items.filter(i => !i.img);
    for (const kind of ["Asset", "Bundle"]) {
      const group = need.filter(i => (i.kind || "Asset") === kind);
      for (let n = 0; n < group.length; n += 100) {
        const chunk = group.slice(n, n + 100), ids = chunk.map(x => x.id).join(",");
        const path = kind === "Bundle" ? `/v1/bundles/thumbnails?bundleIds=${ids}&size=150x150&format=Png`
                                       : `/v1/assets?assetIds=${ids}&size=250x250&format=Png`;
        try {
          const res = await this.json(this.url("thumbnails", path));
          (res.data || []).forEach(t => { const it = chunk.find(x => x.id === t.targetId); if (it && t.state === "Completed" && t.imageUrl) { it.img = t.imageUrl; Cache.set(ck(it), t.imageUrl); } });
        } catch {}
      }
    }
    return items;
  },

  // Bigger picture for the detail view
  async bigThumb(item) {
    const bundle = item.kind === "Bundle", key = (bundle ? "bb:" : "b:") + item.id;
    const hit = Cache.get(key); if (hit) return hit;
    try {
      const path = bundle ? `/v1/bundles/thumbnails?bundleIds=${item.id}&size=420x420&format=Png` : `/v1/assets?assetIds=${item.id}&size=420x420&format=Png`;
      const res = await this.json(this.url("thumbnails", path));
      const t = (res.data || [])[0];
      if (t && t.state === "Completed" && t.imageUrl) { Cache.set(key, t.imageUrl); return t.imageUrl; }
    } catch {}
    return null;
  },

  // One page from the detailed catalog endpoint: creation metadata arrives with the results.
  // feed = key of CAT_QUERY. vi = which query variant to use (a first page that fails/comes back empty falls through to the next one).
  // lim = the Limit the CURSOR was issued with: Roblox only accepts a cursor together with the same Limit as the page that produced it,
  // so each feed keeps its own limit even if another feed made the global pageSize drop to 30 meanwhile.
  async searchPage(keyword = "", cursor = "", source = "roblox", feed = "Accessories", vi = 0, lim = 0) {
    const variants = CAT_QUERY[feed] || CAT_QUERY.Accessories;
    const who = source === "community" ? "" : "&CreatorTargetId=1&CreatorType=User";
    // Community: best-selling all time surfaces the classic (2006-2013) items; newest/relevance is dominated by modern ones.
    const sort = source === "community" ? "&SortType=2&SortAggregation=5" : "&SortType=0&SortAggregation=5";
    const path = (n, v) => `/v1/search/items/details?Limit=${n}&${variants[v]}${who}${sort}&IncludeNotForSale=true&Keyword=${encodeURIComponent(keyword)}&Cursor=${encodeURIComponent(cursor)}`;
    const fetchPage = async v => {
      const first = cursor && lim ? lim : this.pageSize;
      try { return { r: await this.json(this.url("catalog", path(first, v))), n: first }; }
      catch (e) {
        if (e.status !== 400 || cursor || first === 30) throw e;      // only a FIRST page may fall back to a smaller limit
        const r = await this.json(this.url("catalog", path(30, v)));   // if this 400s too, the FILTER was bad (not the page size) -> pageSize stays
        this.pageSize = 30; return { r, n: 30 };                      // Roblox refused the big page size
      }
    };
    let out, v = vi;
    for (;;) {
      try { out = await fetchPage(v); }
      catch (e) {
        if (!cursor && e.status === 400) {
          if (v < variants.length - 1) { v++; continue; }              // bad filter value -> next variant
          console.warn(`[RCV] Roblox refused every query variant for "${feed}" (400):`, variants);
          return { items: [], cursor: "", vi: v, lim: this.pageSize };  // nothing to load for this feed: finished, not an error
        }
        throw e;
      }
      // empty FIRST page of a plain listing = wrong filter; an empty page for a keyword search is a legitimate "no results"
      if (!cursor && !keyword && !(out.r.data || []).length && !out.r.nextPageCursor && v < variants.length - 1) { v++; continue; }
      break;
    }
    const items = (out.r.data || []).map(d => this.toSearchItem(d)).filter(Boolean);
    return { items, cursor: out.r.nextPageCursor || "", vi: v, lim: out.n };
  }
};
