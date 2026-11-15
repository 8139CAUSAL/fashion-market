// The market in 3D: the installed map's painted tiles as low-poly
// scenery — the ground in each tile's colour, roads, highways and footpaths
// along their tiles, bridges and crossings, houses on the home tiles by
// density in their area's colour, buildings, woodland and park trees,
// garages' decks (see-through, so the cars parked in them show), each
// mall's plan, roofless so its corridors' walkers show — the stores in
// their brand's colours, every household in the colour the Market tab
// picks, and, at watch pace, everyone outdoors where frame_pack() puts
// them: cars driving (paler heading home), people walking, cars parked.
//
// It takes what CityView takes, from the same calls on the Market tab
// (setGeometry, setHomes, setTravellers, setStores, setSelected), and does
// what it does on a click: a store opens its floor (onStore), anywhere else
// picks the household nearest the point (onHome).

import * as spatial from "./spatial.js";
import { cityModel, homesOf, travellersOf } from "./scene-adapter.js";
import { View3D, placeMatrix, carGeometry, personGeometry, houseGeometry, treeGeometry, ribbonGeometry, groundPlane, overlayMaterial } from "./view-3d.js";
import { cssVar, fmt } from "./ui.js";
import { tooltip } from "./charts.js";
import { mix } from "./city-view.js";

// The ground's colour on each land code, as CityView paints it.
const LAND_VARS = ["--map-land", "--map-water", "--map-park", null, "--map-plaza", "--map-land", "--map-water",
  "--map-wood", "--map-building", "--map-land", "--map-water", "--map-land", "--map-land", "--map-land", "--map-lot", "--map-garage", "--map-mall"];

const CAR_M = 4.6;           // a car's length, metres
const PERSON_M = 1.8;        // a walker's height
const LEVEL_M = 3.2;         // a garage's floor to floor
const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light";

export class Market3DView extends View3D {
  constructor(wrap, THREE, { onStore, onHome, createRenderer } = {}) {
    super(wrap, THREE, { createRenderer, label: "The market in 3D: its areas, households, stores and everyone outdoors", background: "--surface-2" });
    this.onStore = onStore; this.onHome = onHome;
    this.geo = null; this.world = null; this.model = null; this.homes = null; this.codes = null; this.mode = "brand";
    this.travellers = null; this.storeStats = null; this.selected = null; this.hoverStore = -1;
    this.agentScale = 1;
    // Shapes shared by every build (the scenery's are made with it).
    this.shapes = { car: carGeometry(THREE), person: personGeometry(THREE) };
    this.agents = {};
  }

  // ---- What the Market tab sends ------------------------------------------------------

  // The installed world: city_geometry(), homes_xy(), and the installed
  // world file (for the malls' storefronts). The scenery is rebuilt now
  // (on the next frame drawn), and only now.
  setGeometry(geo, homesXY, world = null) {
    this.geo = geo; this.world = world;
    this.model = cityModel(geo, world);
    this.homes = homesOf(homesXY);
    this.codes = null; this.travellers = null; this.storeStats = null; this.selected = null;
    this.staticDirty = true;
    const m = this.model.frame;
    this.frame({ X0: 0, X1: m.width, Z0: -m.depth, Z1: 0 });
    this.invalidate();
  }
  setHomes(codes, mode) { this.codes = codes; this.mode = mode; this.homesDirty = true; this.dynamicDirty = true; this.invalidate(); }
  setTravellers(t) { this.travellers = t; this.travellersDirty = true; this.dynamicDirty = true; this.invalidate(); }
  setStores(stats) { this.storeStats = stats; this.storesDirty = true; this.dynamicDirty = true; this.invalidate(); }
  setSelected(h) { this.selected = h; this.dynamicDirty = true; this.invalidate(); }

  // ---- The scenery ----------------------------------------------------------------------

  buildStatic() {
    if (!this.model) return;
    const THREE = this.THREE; const g = this.geo; const M = this.model; const p = M.frame.patch;
    const add = (o, order = 0) => { o.renderOrder = order; this.statics.add(o); return o; };
    const lambert = (opts = {}) => new THREE.MeshLambertMaterial(opts);
    const dark = isDark();
    const land = LAND_VARS.map((v) => (v ? cssVar(v, this.wrap) : null));
    const homeBase = cssVar("--map-homes", this.wrap);
    const tints = g.areas.map((a) => (dark ? mix(a.colour, cssVar("--map-land", this.wrap), 0.78) : a.colour));

    // The ground: one texel per tile, in the colours CityView paints them
    // (homes in their area's tint, denser darker).
    add(groundPlane(THREE, M.frame.nx, M.frame.ny, M.frame.width, M.frame.depth, (r, c) => {
      const i = r * g.nx + c; const code = g.land[i];
      if (code === 3) {
        const base = tints[g.area[i] - 1] ?? mix(cssVar("--map-land", this.wrap), homeBase, 0.5);
        return mix(base, homeBase, dark ? 0.05 + 0.03 * g.density[i] : 0.04 * g.density[i]);
      }
      return land[code] ?? land[0];
    }));

    // Roads (an edge, then the surface), highways over them, footpaths.
    const rw = 0.52 * p;
    add(new THREE.Mesh(ribbonGeometry(THREE, M.roads, M.roadDots, rw * 1.18), overlayMaterial(THREE, this.colour("--map-road-edge"), 1)));
    add(new THREE.Mesh(ribbonGeometry(THREE, M.roads, M.roadDots, rw), overlayMaterial(THREE, this.colour("--map-road"), 2)));
    if (M.highways.length) add(new THREE.Mesh(ribbonGeometry(THREE, M.highways, [], rw * 0.6), overlayMaterial(THREE, this.colour("--map-highway"), 3)));
    if (M.paths.length) add(new THREE.Mesh(ribbonGeometry(THREE, M.paths, [], Math.max(1.2, rw * 0.3)), overlayMaterial(THREE, this.colour("--map-path"), 2)));

    // Bridges: railings and piers along the way they carry; crossings: stripes.
    if (M.bridges.length) {
      const rail = new THREE.BoxGeometry(1, 1, 1); rail.translate(0, 0.5, 0);
      const rails = new THREE.Group();
      const railMat = lambert({ color: this.colour("--ink-2") });
      for (const side of [-1, 1]) {
        rails.add(this.instanced(rail, railMat, M.bridges.length, (i, m) => {
          const b = M.bridges[i]; const w = (b.foot ? 0.2 : 0.32) * p;
          const dx = -Math.sin(b.yaw) * side * w; const dz = -Math.cos(b.yaw) * side * w;
          placeMatrix(THREE, m, b.X + dx, 0, b.Z + dz, b.yaw, p, Math.max(1.2, p * 0.04), Math.max(0.6, p * 0.025));
        }));
      }
      add(rails);
    }
    if (M.crossings.length) {
      const stripe = new THREE.BoxGeometry(1, 1, 1); stripe.translate(0, 0.5, 0);
      add(this.instanced(stripe, overlayMaterial(THREE, this.colour("--map-road"), 4, false), M.crossings.length * 4, (i, m) => {
        const c = M.crossings[i >> 2]; const k = (i & 3) - 1.5;
        const along = k * 0.14 * p;
        placeMatrix(THREE, m, c.X + Math.cos(c.yaw) * along, 0, c.Z - Math.sin(c.yaw) * along, c.yaw + Math.PI / 2, 0.42 * p, 0.05, 0.06 * p);
      }));
    }

    // Houses: walls in the area's colour, roofs darker.
    const H = M.houses;
    if (H.n) {
      const mesh = add(this.instanced(houseGeometry(THREE), lambert({ vertexColors: true }), H.n, (i, m) => placeMatrix(THREE, m, H.X[i], 0, H.Z[i], H.yaw[i], H.size[i], H.height[i], H.size[i])));
      const fallback = this.colour("--map-homes");
      for (let i = 0; i < H.n; i++) {
        const tint = g.areas[H.area[i] - 1]?.colour;
        mesh.setColorAt(i, tint ? this.colour(dark ? mix(tint, "#333333", 0.4) : mix(tint, "#ffffff", 0.12)) : fallback);
      }
      mesh.instanceColor.needsUpdate = true;
      mesh.name = "houses";
    }

    // Buildings.
    if (M.buildings.length) {
      const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
      const mesh = add(this.instanced(box, lambert({ color: 0xffffff }), M.buildings.length, (i, m) => {
        const b = M.buildings[i]; placeMatrix(THREE, m, b.X, 0, b.Z, 0, b.size, b.height, b.size);
      }));
      const base = this.colour("--map-building");
      M.buildings.forEach((b, i) => mesh.setColorAt(i, base.clone().multiplyScalar(0.85 + 0.3 * (b.height / (0.75 * p)))));
      mesh.instanceColor.needsUpdate = true;
    }

    // Trees.
    if (M.trees.length) {
      add(this.instanced(treeGeometry(THREE, this.colour("--map-wood"), this.colour(dark ? "#5a4632" : "#8a6a48")), lambert({ vertexColors: true }), M.trees.length, (i, m) => {
        const t = M.trees[i]; placeMatrix(THREE, m, t.X, 0, t.Z, 0, t.scale, t.scale, t.scale);
      }));
    }

    // Parking: a garage's decks, see-through, with its pillars; a label for each facility.
    const decks = []; const pillars = [];
    for (const f of M.parking) {
      if (f.kind === "garage") {
        for (const t of f.tiles) {
          for (let k = 1; k <= f.levels; k++) decks.push({ ...t, y: k * LEVEL_M });
          for (const [dx, dz] of [[-0.42, -0.42], [0.42, -0.42], [-0.42, 0.42], [0.42, 0.42]]) pillars.push({ X: t.X + dx * p, Z: t.Z + dz * p, h: f.levels * LEVEL_M });
        }
      }
      this.addLabel(f.kind === "garage" ? "G" : "P", f.label.X, f.kind === "garage" ? f.levels * LEVEL_M + 1 : 1, f.label.Z,
        { cls: `parking ${f.kind}`, priority: 1, show: (d) => d < M.frame.width * 0.25 });
    }
    if (decks.length) {
      const slab = new THREE.BoxGeometry(1, 1, 1);
      add(this.instanced(slab, lambert({ color: this.colour("--map-garage"), transparent: true, opacity: 0.38, depthWrite: false }), decks.length,
        (i, m) => placeMatrix(THREE, m, decks[i].X, decks[i].y, decks[i].Z, 0, p * 0.96, 0.5, p * 0.96)), 3);
      const col = new THREE.BoxGeometry(1, 1, 1); col.translate(0, 0.5, 0);
      add(this.instanced(col, lambert({ color: this.colour("--map-garage") }), pillars.length,
        (i, m) => placeMatrix(THREE, m, pillars[i].X, 0, pillars[i].Z, 0, Math.max(0.5, p * 0.03), pillars[i].h, Math.max(0.5, p * 0.03))));
    }

    // Malls: walls cut away low, corridors and entrances on the ground, storefronts in their store's brand colour.
    for (const v of M.venues) {
      if (!v.plan) continue;
      const { cell, cells } = v.plan;
      const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
      const wallH = Math.min(6, cell * 0.5);
      if (cells.wall.length) add(this.instanced(unit, lambert({ color: this.colour("--map-mall") }), cells.wall.length,
        (i, m) => placeMatrix(THREE, m, cells.wall[i].X, 0, cells.wall[i].Z, 0, cell, wallH, cell)));
      const flat = [...cells.corridor.map((c) => [c, "--map-plaza"]), ...cells.entrance.map((c) => [c, "--good"])];
      if (flat.length) {
        const mesh = add(this.instanced(unit, overlayMaterial(THREE, 0xffffff, 2, false), flat.length, (i, m) => placeMatrix(THREE, m, flat[i][0].X, 0, flat[i][0].Z, 0, cell, 0.05, cell)));
        flat.forEach(([, v2], i) => mesh.setColorAt(i, this.colour(v2)));
        mesh.instanceColor.needsUpdate = true;
      }
      if (cells.front.length) {
        const mesh = add(this.instanced(unit, lambert({ color: 0xffffff }), cells.front.length, (i, m) => placeMatrix(THREE, m, cells.front[i].X, 0, cells.front[i].Z, 0, cell, wallH * 0.7, cell)));
        cells.front.forEach((c, i) => mesh.setColorAt(i, this.colour(g.brands[g.stores[c.store]?.brand - 1]?.colour ?? "--map-mall")));
        mesh.instanceColor.needsUpdate = true;
      }
    }

    // Stores: a block in the brand's colour under a darker roof band, a halo of today's visits under it.
    const S = M.stores;
    if (S.length) {
      const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
      const body = add(this.instanced(box, lambert({ color: 0xffffff }), S.length, (i, m) => placeMatrix(THREE, m, S[i].X, 0, S[i].Z, 0, 2 * S[i].half, S[i].height, 2 * S[i].half)), 2);
      const roof = add(this.instanced(box, lambert({ color: 0xffffff }), S.length, (i, m) => placeMatrix(THREE, m, S[i].X, S[i].height, S[i].Z, 0, 2.2 * S[i].half, S[i].half * 0.18, 2.2 * S[i].half)), 2);
      S.forEach((s, i) => {
        const c = g.brands[s.brand - 1]?.colour ?? "#888888";
        body.setColorAt(i, this.colour(c)); roof.setColorAt(i, this.colour(mix(c, dark ? "#ffffff" : "#000000", 0.3)));
      });
      body.instanceColor.needsUpdate = true; roof.instanceColor.needsUpdate = true;
      body.name = "stores"; this.storeMesh = body;
      const disc = new THREE.CircleGeometry(1, 28); disc.rotateX(-Math.PI / 2);
      this.halos = add(this.instanced(disc, overlayMaterial(THREE, 0xffffff, 5, true, 0.22), 0, () => {}, S.length), 3);
      this.halos.name = "halos";
      // Names: every store's when there are few or the canvas is wide (as on
      // the 2D map), and close up whatever the number.
      const few = g.stores.length <= 40;
      this.storeLabels = S.map((s, i) => this.addLabel(g.stores[i].short, s.X, s.height + s.half * 0.6 + 2, s.Z,
        { cls: "store", priority: 2, show: (d) => few || d < M.frame.width * 0.35 }));
    }
    for (const a of M.areas) this.addLabel(a.name.toUpperCase(), a.X, 2, a.Z, { cls: "area", priority: 3 });

    // The households: a square each, coloured as the Market tab says, over the ground.
    if (this.homes?.n) {
      const sq = new THREE.PlaneGeometry(1, 1); sq.rotateX(-Math.PI / 2);
      this.homesMesh = add(this.instanced(sq, new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false }), this.homes.n, () => {}), 1);
      this.homesMesh.name = "households";
      this.homesMesh.frustumCulled = false;
      this.homesDirty = true; this.homesScale = 0;
    }
    // The household picked for the preference card.
    this.ring = add(new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: this.colour("--map-label"), depthTest: false })), 6);
    this.ring.visible = false;
    this.hoverRing = add(new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 4, 1, Math.PI / 4).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: this.colour("--map-label"), depthTest: false })), 6);
    this.hoverRing.visible = false;
    this.storesDirty = true; this.travellersDirty = true;
    this.#allocAgents();
  }

  // The agents' meshes live in the dynamic group, rebuilt with the colours.
  #allocAgents() {
    for (const k of Object.keys(this.agents)) { this.dynamics.remove(this.agents[k]); this.agents[k].material.dispose(); this.agents[k].dispose(); }
    this.agents = {};
    this.parkedColour = this.colour("--map-car"); this.surface = this.colour("--surface");
    this.brandColours = (this.geo?.brands ?? []).map((b) => this.colour(b.colour));
  }

  #agentMesh(kind, n) {
    const THREE = this.THREE; let mesh = this.agents[kind];
    if (mesh && mesh.instanceMatrix.count >= n) return mesh;
    const cap = Math.max(64, 2 ** Math.ceil(Math.log2(Math.max(1, n))));
    if (mesh) { this.dynamics.remove(mesh); mesh.material.dispose(); mesh.dispose(); }
    mesh = new THREE.InstancedMesh(kind === "walker" ? this.shapes.person : this.shapes.car, new THREE.MeshLambertMaterial({ color: 0xffffff }), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.count = 0; mesh.name = kind;
    mesh.setColorAt(0, this.surface);
    this.dynamics.add(mesh);
    this.agents[kind] = mesh;
    return mesh;
  }

  // ---- The moving parts -------------------------------------------------------------------

  // How much bigger than life the agents are drawn: life-size close up,
  // bigger as the camera pulls back, so they read at the market's scale
  // (as the 2D map's dots keep their size at any zoom).
  scaleFor(distance) { return Math.min(30, Math.max(1, distance / 700)); }

  cameraChanged() {
    super.cameraChanged();
    const s = this.scaleFor(this.distance);
    if (Math.abs(s - this.agentScale) / this.agentScale > 0.03) { this.agentScale = s; this.travellersDirty = true; this.homesDirty = true; this.storesDirty = true; this.dynamicDirty = true; }
  }

  updateDynamic() {
    if (!this.model) return;
    const THREE = this.THREE; const s = this.agentScale; const m = new THREE.Matrix4(); const p = this.model.frame.patch;
    if (this.travellersDirty) {
      this.travellersDirty = false;
      const T = travellersOf(this.travellers, this.model);
      this.lastTravellers = T;
      for (const kind of ["car", "walker", "parked"]) {
        const a = T[kind]; const mesh = this.#agentMesh(kind, a.n);
        for (let i = 0; i < a.n; i++) {
          if (kind === "walker") placeMatrix(THREE, m, a.X[i], 0, a.Z[i], 0, PERSON_M * s * 1.3, PERSON_M * s * 1.3, PERSON_M * s * 1.3);
          else placeMatrix(THREE, m, a.X[i], 0.3, a.Z[i], a.yaw[i], CAR_M * s, CAR_M * s, CAR_M * s);
          mesh.setMatrixAt(i, m);
          const c = kind === "parked" ? this.parkedColour : (this.brandColours[a.brand[i] - 1] ?? this.parkedColour);
          // Heading home: paler, as the 2D map fades it.
          mesh.setColorAt(i, kind === "car" && a.back[i] ? c.clone().lerp(this.surface, 0.45) : c);
        }
        mesh.count = a.n;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    if (this.homesDirty && this.homesMesh) {
      this.homesDirty = false;
      const mesh = this.homesMesh; const H = this.homes;
      const size = Math.min(p * 0.35, Math.max(1.5, p * 0.06) * Math.sqrt(s));
      if (size !== this.homesScale) {
        this.homesScale = size;
        for (let i = 0; i < H.n; i++) { placeMatrix(THREE, m, H.X[i], 0.6, H.Z[i], 0, size, 1, size); mesh.setMatrixAt(i, m); }
        mesh.instanceMatrix.needsUpdate = true;
      }
      const palette = this.#homePalette().map((c) => this.colour(c));
      const codes = this.codes;
      // Households not yet coloured (or in no offer) recede, as they do on the 2D map.
      const faded = this.mode === "offer" ? palette[0].clone().lerp(this.colour("--map-land"), 0.65) : palette[0];
      for (let i = 0; i < H.n; i++) {
        const k = codes ? codes[i] : 0;
        mesh.setColorAt(i, k === 0 ? faded : (palette[k] ?? palette[0]));
      }
      mesh.instanceColor.needsUpdate = true;
    }
    if (this.storesDirty && this.halos) {
      this.storesDirty = false;
      const S = this.model.stores; const stats = this.storeStats;
      const maxVisits = Math.max(1, ...(stats ?? []).map((x) => x.visits));
      let n = 0;
      S.forEach((st, i) => {
        const stat = stats?.[i];
        if (stat) {
          const r = st.half * 1.4 * (0.9 + 1.4 * Math.sqrt(stat.visits / maxVisits)) * Math.max(1, Math.sqrt(s) * 0.6);
          placeMatrix(THREE, m, st.X, 0, st.Z, 0, r, 1, r);
          this.halos.setMatrixAt(n, m); this.halos.setColorAt(n, this.brandColours[st.brand - 1] ?? this.parkedColour); n++;
        }
        const label = this.storeLabels?.[i];
        if (label) { const t = `${this.geo.stores[i].short}${stat?.promo ? " %" : ""}`; if (label.node.textContent !== t) { label.node.textContent = t; label.text = t; } }
      });
      this.halos.count = n;
      this.halos.instanceMatrix.needsUpdate = true;
      if (this.halos.instanceColor) this.halos.instanceColor.needsUpdate = true;
    }
    if (this.ring) {
      this.ring.visible = !!this.selected;
      if (this.selected) {
        const at = spatial.macroToScene(this.selected.x, this.selected.y);
        const r = Math.max(4, p * 0.12) * Math.sqrt(s);
        this.ring.position.set(at.X, 1, at.Z); this.ring.scale.set(r, 1, r);
      }
    }
  }

  #homePalette() {
    const g = this.geo; const r = this.wrap;
    switch (this.mode) {
      case "segment": return ["#999", ...g.segments.map((x) => x.colour)];
      case "offer": return [cssVar("--brand-0", r), cssVar("--offer-0", r), cssVar("--offer-1", r), cssVar("--offer-2", r)];
      case "area": return [cssVar("--brand-0", r), ...g.areas.map((a) => mix(a.colour, "#555555", 0.55))];
      default: return [cssVar("--brand-0", r), ...g.brands.map((b) => b.colour)];
    }
  }

  // ---- The pointer -----------------------------------------------------------------------

  // The store under the pointer: its block, else the nearest within 14
  // pixels on screen (as the 2D map finds one), or -1.
  storeAt(ev) {
    if (!this.model) return -1;
    if (this.storeMesh) {
      this.storeMesh.computeBoundingSphere();
      const hit = this.ray(ev).intersectObject(this.storeMesh, false)[0];
      if (hit && hit.instanceId !== undefined) return hit.instanceId;
    }
    const r = this.canvas.getBoundingClientRect();
    const px = ev.clientX - r.left; const py = ev.clientY - r.top;
    let best = -1; let bd = 14 ** 2;
    this.model.stores.forEach((st, i) => {
      const sp = this.toScreen(st.X, st.height / 2, st.Z);
      if (!sp.on) return;
      const d = (sp.x - px) ** 2 + (sp.y - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  click(ev) {
    if (!this.model) return;
    const best = this.storeAt(ev);
    if (best >= 0) return this.onStore?.(best + 1);
    const hit = this.groundAt(ev);
    if (!hit) return;
    const { x, y } = spatial.sceneToMacro(hit.x, hit.z);
    if (x < 0 || y < 0 || x > this.geo.width || y > this.geo.height) return;
    this.onHome?.(x, y);
  }

  hover(ev) {
    if (!this.model) return;
    const best = this.storeAt(ev);
    this.canvas.style.cursor = best >= 0 ? "pointer" : "crosshair";
    if (best !== this.hoverStore) {
      this.hoverStore = best;
      if (this.hoverRing) {
        this.hoverRing.visible = best >= 0;
        if (best >= 0) { const st = this.model.stores[best]; const r = st.half * 1.9; this.hoverRing.position.set(st.X, 0.8, st.Z); this.hoverRing.scale.set(r, 1, r); }
      }
      this.invalidate();
    }
    if (best < 0) return tooltip.hide();
    const g = this.geo; const st = g.stores[best]; const stat = this.storeStats?.[best];
    tooltip.show(ev, st.name, [
      { colour: g.brands[st.brand - 1]?.colour, value: g.brands[st.brand - 1]?.name, name: `${st.format} layout · ${st.area ? g.areas[st.area - 1]?.name : "outside every area"}` },
      { value: fmt.int(stat?.visits), name: "visits today" },
      { value: fmt.int(stat?.inside), name: "in the store now" },
      { value: fmt.money(stat?.sales), name: "net sales this season (after refunds)" },
      { value: "Click", name: "to open its floor" },
    ]);
  }
}
