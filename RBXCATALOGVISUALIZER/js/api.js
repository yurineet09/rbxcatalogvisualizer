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

  async json(url, tries = 4) {
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

  // Normalize an economy "asset details" response into our item shape
  toItem(d) {
    // Catalog item types only: skips Toolbox content (Models, Audio, Decals, Meshes, Scripts...)
    if (!ASSET_TYPES[d.AssetTypeId]) return null;
    return {
      id: d.AssetId, name: d.Name, type: ASSET_TYPES[d.AssetTypeId],
      created: (d.Created || "").slice(0, 10), updated: (d.Updated || "").slice(0, 10),
      creator: d.Creator ? d.Creator.Name : "?", creatorId: d.Creator ? d.Creator.Id : 0, creatorType: d.Creator ? d.Creator.CreatorType : "User",
      priceNum: d.PriceInRobux == null ? null : d.PriceInRobux, forSale: !!d.IsForSale, tradeable: !!d.IsLimited || !!d.IsLimitedUnique,
      sales: d.Sales || 0, fav: null, kind: "Asset",
      desc: d.Description || "", img: null
    };
  },

  async details(id) {
    const hit = Cache.get("d:" + id); if (hit) return hit.skip ? null : { ...hit };
    try { const it = this.toItem(await this.json(this.url("economy", `/v2/assets/${id}/details`))); Cache.set("d:" + id, it || { skip: 1 }); return it; }   // non-catalog items are remembered too
    catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }   // missing = skip, server error = throw
  },

  // Packages are catalog bundles, not assets. Keeping them separate fixes the old
  // behavior where Faces/Heads/Packages silently disappeared or errored.
  async bundleDetails(id) {
    const hit = Cache.get("bundle:" + id); if (hit) return { ...hit };
    const d = await this.json(this.url("catalog", `/v1/bundles/${id}/details`));
    const product = d.product || {}, creator = d.creator || {};
    const it = { id: d.id, name: d.name || `Package ${id}`, type: "Package", created: "", updated: "",
      creator: creator.name || "?", creatorId: creator.id || 0, creatorType: creator.type || "User",
      priceNum: product.priceInRobux == null ? null : product.priceInRobux, forSale: !!product.isForSale,
      tradeable: !!(d.collectibleItemDetail && d.collectibleItemDetail.hasResellers), sales: 0, fav: null,
      desc: d.description || "", img: null, kind: "Bundle" };
    Cache.set("bundle:" + id, it); return it;
  },

  async detailsEntry(entry) { return entry.kind === "Bundle" ? this.bundleDetails(entry.id) : this.details(entry.id); },

  // Details for many ids at once (the queue limits real concurrency). Returns { items, failed } - failed ids can be retried later.
  async detailsBatch(entries, workers = 6) {
    const res = [], failed = [], assets = entries.filter(e => e.kind !== "Bundle"), bundles = entries.filter(e => e.kind === "Bundle");
    let n = 0;
    await Promise.all(Array.from({ length: Math.min(workers, assets.length) }, async () => {
      while (n < assets.length) { const k = n++; try { const item = await this.detailsEntry(assets[k]); if (item) res.push(item); } catch { failed.push(assets[k]); } }
    }));
    // Bundle details has a much stricter Roblox rate limit than normal assets.
    // Keep it serial so selecting Packages remains usable without starving all searches.
    for (const entry of bundles) {
      try { const item = await this.detailsEntry(entry); if (item) res.push(item); }
      catch { /* Do not immediately retry bundles: Roblox has already rate-limited this endpoint. */ }
      if (bundles.length > 1) await sleep(900);
    }
    return { items: res, failed };
  },

  async favCount(id) {
    const hit = Cache.get("f:" + id, 864e5); if (hit != null) return hit;
    try { const v = +(await this.json(this.url("catalog", `/v1/favorites/assets/${id}/count`))); if (Number.isFinite(v)) Cache.set("f:" + id, v); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  },

  // Fills item.img for a list of items (batch endpoint, up to 100 ids). Single pass: items still "Pending" at Roblox stay without img.
  async thumbnails(items) {
    items.forEach(i => { const t = Cache.get("t:" + i.kind + ":" + i.id); if (t) i.img = t; });
    const need = items.filter(i => !i.img), assets = need.filter(i => i.kind !== "Bundle"), bundles = need.filter(i => i.kind === "Bundle");
    for (let i = 0; i < assets.length; i += 100) {
      const chunk = assets.slice(i, i + 100);
      try {
        const res = await this.json(this.url("thumbnails", `/v1/assets?assetIds=${chunk.map(x => x.id).join(",")}&size=250x250&format=Png`));
        (res.data || []).forEach(t => { const it = chunk.find(x => x.id === t.targetId); if (it && t.state === "Completed" && t.imageUrl) { it.img = t.imageUrl; Cache.set("t:" + it.kind + ":" + it.id, t.imageUrl); } });
      } catch {}
    }
    for (let i = 0; i < bundles.length; i += 100) {
      const chunk = bundles.slice(i, i + 100);
      try { const res = await this.json(this.url("thumbnails", `/v1/bundles/thumbnails?bundleIds=${chunk.map(x => x.id).join(",")}&size=150x150&format=Png&isCircular=false`));
        (res.data || []).forEach(t => { const it = chunk.find(x => x.id === t.targetId); if (it && t.state === "Completed" && t.imageUrl) { it.img = t.imageUrl; Cache.set("t:" + it.kind + ":" + it.id, t.imageUrl); } });
      } catch {}
    }
    return items;
  },

  // Bigger picture for the detail view
  async bigThumb(id) {
    const hit = Cache.get("b:" + id); if (hit) return hit;
    try {
      const res = await this.json(this.url("thumbnails", `/v1/assets?assetIds=${id}&size=420x420&format=Png`));
      const t = (res.data || [])[0];
      if (t && t.state === "Completed" && t.imageUrl) { Cache.set("b:" + id, t.imageUrl); return t.imageUrl; }
    } catch {}
    return null;
  },

  // The response is a glTF URL when Roblox accepts `useGltf`; it is intentionally
  // fetched through our proxy so an optional server-side API key stays private.
  async model3d(id) {
    const r = await this.json(this.url("thumbnails", `/v1/assets-thumbnail-3d?assetId=${id}&useGltf=true`), 0);
    return r && r.state === "Completed" ? r.imageUrl : "";
  },

  // One page of the live catalog search. source: roblox = made by ROBLOX; community = user-made clothing.
  // Category names such as Gear and BodyParts now return HTTP 400 from Roblox.
  // Search once, then apply the precise category/type filter after details load.
  async searchPage(keyword = "", cursor = "", source = "roblox", category = "") {
    const who = source === "community" ? "&category=Clothing" : "&creatorTargetId=1&creatorType=User";
    const path = lim => `/v1/search/items?limit=${lim}${who}&keyword=${encodeURIComponent(keyword)}&cursor=${encodeURIComponent(cursor)}`;
    let r;
    try { r = await this.json(this.url("catalog", path(this.pageSize))); }
    catch (e) {
      if (e.status === 400 && this.pageSize !== 30) { this.pageSize = 30; r = await this.json(this.url("catalog", path(30))); }   // Roblox refused the big page size
      else throw e;
    }
    const includeBundles = category === "Packages";
    const entries = (r.data || []).filter(x => (x.itemType === "Asset" || (includeBundles && x.itemType === "Bundle")) && x.id <= CONFIG.maxAssetId)
      .map(x => ({ id: x.id, kind: x.itemType }));
    return { entries, cursor: r.nextPageCursor || "" };
  }
};
