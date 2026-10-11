/* ===== Viewer: 2D picture by default; 3D loads the item's OWN model from Roblox ===== */
const Viewer = {
  renderer: null, scene: null, cam: null, pivot: null, running: false, cache: {},

  init() {
    if (this.renderer) return;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.scene = new THREE.Scene();
    this.cam = new THREE.PerspectiveCamera(40, 1, .01, 100);
    this.scene.add(new THREE.AmbientLight(0xffffff, .8));
    const sun = new THREE.DirectionalLight(0xffffff, .7); sun.position.set(3, 6, 5); this.scene.add(sun);
    this.pivot = new THREE.Group(); this.scene.add(this.pivot);
    const cv = this.renderer.domElement; let drag = false, px = 0;
    cv.addEventListener("mousedown", e => { drag = true; px = e.clientX; });
    addEventListener("mouseup", () => drag = false);
    addEventListener("mousemove", e => { if (drag) { this.pivot.rotation.y += (e.clientX - px) * .01; px = e.clientX; } });
    const loop = () => {
      requestAnimationFrame(loop);
      const p = cv.parentElement; if (!p) return;
      if (!drag) this.pivot.rotation.y += .01;
      const w = p.clientWidth, h = p.clientHeight;
      if (cv.width !== Math.round(w * devicePixelRatio)) {
        this.renderer.setPixelRatio(devicePixelRatio); this.renderer.setSize(w, h, false);
        this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
      }
      this.renderer.render(this.scene, this.cam);
    };
    loop();
  },

  // Fetch + build the item's mesh (cached per ID)
  async build(id) {
    if (this.cache[id]) return this.cache[id];
    const m = await Api.model3d(id);
    const obj = new THREE.OBJLoader().parse(await (await fetch(m.obj)).text());
    let tex = null;
    if (m.textures[0]) {
      const loader = new THREE.TextureLoader(); loader.setCrossOrigin("anonymous");
      tex = await new Promise(res => loader.load(m.textures[0], res, undefined, () => res(null)));
    }
    obj.traverse(o => { if (o.isMesh) o.material = new THREE.MeshLambertMaterial({ color: tex ? 0xffffff : 0xcccccc, map: tex, side: THREE.DoubleSide }); });
    const box = new THREE.Box3().setFromObject(obj), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    obj.position.sub(c);
    const wrap = new THREE.Group(); wrap.add(obj);
    wrap.scale.setScalar(2.4 / Math.max(size.x, size.y, size.z));
    return (this.cache[id] = wrap);
  },

  // Show 3D inside container; returns when done (throws if the item has no model)
  async show3D(container, id) {
    this.init(); this.pivot.children.slice().forEach(c => this.pivot.remove(c));
    const model = await this.build(id);
    this.pivot.rotation.y = 0; this.pivot.add(model); this.cam.position.set(0, 0, 6);
    container.prepend(this.renderer.domElement);
  },
  hide3D() { const cv = this.renderer && this.renderer.domElement; if (cv && cv.parentElement) cv.remove(); }
};
