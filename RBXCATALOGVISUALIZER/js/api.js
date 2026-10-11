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

  // Normalize an economy "asset details" response into our item shape.
  // PriceInRobux === null means "unknown / not priced here", NOT free: only an explicit 0 is free.
  toItem(d) {
    // Catalog item types only: skips Toolbox content (Models, Audio, Decals, Meshes, Scripts...)
    if (!ASSET_TYPES[d.AssetTypeId]) return null;
    const price = typeof d.PriceInRobux === "number" ? d.PriceInRobux : null;
    return {
      id: d.AssetId, name: d.Name, type: ASSET_TYPES[d.AssetTypeId],
      created: (d.Created || "").slice(0, 10), updated: (d.Updated || "").slice(0, 10),
      creator: d.Creator ? d.Creator.Name : "?", creatorId: d.Creator ? d.Creator.Id : 0, creatorType: d.Creator ? d.Creator.CreatorType : "User",
      priceNum: price, free: price === 0 && !!d.IsForSale, forSale: !!d.IsForSale, tradeable: !!d.IsLimited || !!d.IsLimitedUnique,
      sales: d.Sales || 0, fav: null, kind: "Asset",
      desc: d.Description || "", img: null
    };
  },

  // Search results (assets AND bundles). Packages are Bundles on Roblox (itemType "Bundle", bundleType 1).
  // Price rules: d.price = current price; d.lowestPrice = cheapest resale (limiteds);
  // d.priceStatus = "Free" | "Off Sale" | "No Resellers" | ... . Missing price is "unknown", never "Free".
  toSearchItem(d) {
    const isBundle = d.itemType === "Bundle";
    if (isBundle) { if (d.bundleType !== 1) return null; }                       // only BodyParts bundles (= old Packages)
    else if (d.itemType !== "Asset" || !ASSET_TYPES[d.assetType]) return null;
    const ps = d.priceStatus || "";
    let price = typeof d.price === "number" ? d.price : (typeof d.lowestPrice === "number" ? d.lowestPrice : null);
    const offSale = ps === "Off Sale" || ps === "No Resellers";
    const free = ps === "Free" || (price === 0 && !offSale);
    if (offSale && typeof d.price !== "number" && typeof d.lowestPrice !== "number") price = null;
    return { id: d.id, name: d.name || "?", type: isBundle ? "Package" : ASSET_TYPES[d.assetType],
      created: (d.itemCreatedUtc || "").slice(0, 10), updated: "",
      creator: d.creatorName || "?", creatorId: d.creatorTargetId || 0, creatorType: d.creatorType || "User",
      priceNum: free ? 0 : price, free, forSale: ps ? !offSale : price != null, tradeable: !!d.hasResellers,
      sales: 0, fav: d.favoriteCount == null ? null : d.favoriteCount, favDone: d.favoriteCount != null || isBundle,
      desc: d.description || "", img: null, kind: isBundle ? "Bundle" : "Asset" };
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
  async searchPage(keyword = "", cursor = "", source = "roblox", feed = "Accessories", vi = 0) {
    const variants = CAT_QUERY[feed] || CAT_QUERY.Accessories;
    const who = source === "community" ? "" : "&CreatorTargetId=1&CreatorType=User";
    // Community: best-selling all time surfaces the classic (2006-2013) items; newest/relevance is dominated by modern ones.
    const sort = source === "community" ? "&SortType=2&SortAggregation=5" : "&SortType=0&SortAggregation=5";
    const path = (lim, v) => `/v1/search/items/details?Limit=${lim}&${variants[v]}${who}${sort}&IncludeNotForSale=true&Keyword=${encodeURIComponent(keyword)}&Cursor=${encodeURIComponent(cursor)}`;
    const fetchPage = async v => {
      try { return await this.json(this.url("catalog", path(this.pageSize, v))); }
      catch (e) {
        if (e.status !== 400 || this.pageSize === 30) throw e;
        const r = await this.json(this.url("catalog", path(30, v)));   // if this 400s too, the FILTER was bad (not the page size) -> pageSize stays
        this.pageSize = 30; return r;                                   // Roblox refused the big page size
      }
    };
    let r, v = vi;
    for (;;) {
      try { r = await fetchPage(v); }
      catch (e) { if (!cursor && e.status === 400 && v < variants.length - 1) { v++; continue; } throw e; }   // bad filter value -> broader variant
      if (!cursor && !(r.data || []).length && !r.nextPageCursor && v < variants.length - 1) { v++; continue; }
      break;
    }
    const items = (r.data || []).map(d => this.toSearchItem(d)).filter(Boolean);
    return { items, cursor: r.nextPageCursor || "", vi: v };
  }
};
