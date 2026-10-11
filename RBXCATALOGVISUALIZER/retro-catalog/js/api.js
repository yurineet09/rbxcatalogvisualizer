/* ===== Network: one throttled queue + local cache, so Roblox does not answer 429 ===== */
const Net = {
  active: 0, max: 3, gap: 140, last: 0, pauseUntil: 0, q: [],
  run(fn) { return new Promise((res, rej) => { this.q.push({ fn, res, rej }); this.pump(); }); },
  pump() {
    while (this.active < this.max && this.q.length) {
      const t = this.q.shift(); this.active++;
      const at = Math.max(Date.now(), this.last + this.gap, this.pauseUntil); this.last = at;
      setTimeout(() => t.fn().then(t.res, t.rej).finally(() => { this.active--; this.pump(); }), at - Date.now());
    }
  }
};
const Cache = {
  get(k, ttl = 7 * 864e5) { try { const v = JSON.parse(localStorage.getItem("rcv:" + k)); if (v && Date.now() - v.t < ttl) return v.d; } catch {} return null; },
  set(k, d) { try { localStorage.setItem("rcv:" + k, JSON.stringify({ t: Date.now(), d })); } catch {} }
};

const Api = {
  url(service, path) { return CONFIG.proxy ? `${CONFIG.proxy}?s=${service}&p=${encodeURIComponent(path)}` : CONFIG.api[service] + path; },

  async json(url, tries = 4) {
    let r;
    for (let n = 0; ; n++) {
      r = await Net.run(() => fetch(url));
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
      priceNum: d.PriceInRobux == null ? null : d.PriceInRobux, forSale: !!d.IsForSale, sales: d.Sales || 0, fav: null,
      price: d.PriceInRobux ? d.PriceInRobux + " R$" : (d.IsForSale ? "Free" : "Off sale"),
      desc: d.Description || "", img: null
    };
  },

  async details(id) {
    const hit = Cache.get("d:" + id); if (hit) return hit.skip ? null : hit;
    try { const it = this.toItem(await this.json(this.url("economy", `/v2/assets/${id}/details`))); Cache.set("d:" + id, it || { skip: 1 }); return it; }   // non-catalog items are remembered too

    catch (e) { if (e.status === 404 || e.status === 400) return null; throw e; }   // missing = skip, server error = throw
  },

  // Limited concurrency so Roblox/the proxy doesn't rate-limit us
  async detailsMany(ids, workers = 5) {
    const out = []; let n = 0, fails = 0;
    await Promise.all(Array.from({ length: workers }, async () => {
      while (n < ids.length) { const id = ids[n++]; try { out.push(await this.details(id)); } catch { fails++; } }
    }));
    if (ids.length && fails === ids.length) throw new Error("server");
    return out.filter(Boolean);
  },

  async favCount(id) {
    const hit = Cache.get("f:" + id, 864e5); if (hit != null) return hit;
    try { const v = +(await this.json(this.url("catalog", `/v1/favorites/assets/${id}/count`))); if (Number.isFinite(v)) Cache.set("f:" + id, v); return Number.isFinite(v) ? v : null; }
    catch { return null; }
  },

  // Fills item.img for a list of items (batch endpoint, up to 100 ids)
  async thumbnails(items) {
    items.forEach(i => { const t = Cache.get("t:" + i.id); if (t) i.img = t; });
    const need = items.filter(i => !i.img);
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      try {
        const res = await this.json(this.url("thumbnails", `/v1/assets?assetIds=${chunk.map(x => x.id).join(",")}&size=250x250&format=Png`));
        res.data.forEach(t => { const it = chunk.find(x => x.id === t.targetId); if (it && t.state === "Completed") { it.img = t.imageUrl; Cache.set("t:" + it.id, t.imageUrl); } });
      } catch {}
    }
    return items;
  },

  // Browse the live catalog. source: roblox = made by ROBLOX; community = user-made clothing (shirts, t-shirts, pants). Returns { items, cursor } - nothing is hardcoded.
  async browse(keyword = "", cursor = "", source = "roblox", category = "") {
    const who = source === "community" ? "&category=Clothing" : "&creatorTargetId=1&creatorType=User" + (category ? `&category=${category}` : "");
    const r = await this.json(this.url("catalog", `/v1/search/items?limit=${CONFIG.pageSize}${who}` +
      `&keyword=${encodeURIComponent(keyword)}&cursor=${encodeURIComponent(cursor)}`));
    return { items: await this.detailsMany((r.data || []).map(x => x.id)), cursor: r.nextPageCursor || "" };
  },

  // Asset hash -> rbxcdn URL
  hashUrl(h) { let i = 31; for (const ch of h) i ^= ch.charCodeAt(0); return `https://t${i % 8}.rbxcdn.com/${h}`; },

  // The item's own 3D thumbnail data: { obj, textures[] } as CDN URLs
  async model3d(id) {
    let meta;
    for (let n = 0; n < 6; n++) {
      meta = await this.json(this.url("thumbnails", `/v1/assets-thumbnail-3d?assetId=${id}`));
      if (meta.state === "Completed") break;
      if (meta.state !== "Pending") throw new Error("No 3D model for this item");
      await new Promise(r => setTimeout(r, 1200));
    }
    if (meta.state !== "Completed") throw new Error("3D model not ready, try again");
    const d = await this.json(meta.imageUrl);
    return { obj: this.hashUrl(d.obj), textures: (d.textures || []).map(t => this.hashUrl(t)) };
  }
};
