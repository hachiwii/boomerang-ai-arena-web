// LoL-style move-command marker (PC MOBA scheme): where the player right-clicked, a green ring contracts while four
// chevrons converge on the point and fade out (~0.45 s). Purely visual; drawn over the ground and grass.
import * as THREE from 'three';

const DURATION = 0.45;
const COLOR = 0x46f59a;
const SHADE = 0x07331d;
const Y = 0.075; // just above the ground plane the cursor is projected onto (0.06)

function overlayMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    toneMapped: false, // keep the exact UI green (ACES would wash it out to white)
    side: THREE.DoubleSide,
  });
}

function chevronGeometry(): THREE.ShapeGeometry {
  // A "V" pointing toward +x (the centre), 0.16 m long, 0.2 m wide, 0.05 m stroke
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(-0.15, 0.1);
  s.lineTo(-0.15, 0.05);
  s.lineTo(-0.075, 0);
  s.lineTo(-0.15, -0.05);
  s.lineTo(-0.15, -0.1);
  s.closePath();
  return new THREE.ShapeGeometry(s);
}

export class MoveMarker {
  private readonly group = new THREE.Group();
  private readonly ring: THREE.Mesh;
  private readonly ringShade: THREE.Mesh;
  private readonly dot: THREE.Mesh;
  private readonly chevrons: THREE.Mesh[] = [];
  private readonly shades: THREE.Mesh[] = [];
  private readonly materials: THREE.MeshBasicMaterial[] = [];
  private age = DURATION;

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.group.renderOrder = 999;
    const flat = new THREE.Group();
    flat.rotation.x = -Math.PI / 2; // shapes are built in XY; lay them on the ground (XZ)
    this.group.add(flat);

    const mat = (c: number, o: number) => {
      const m = overlayMaterial(c, o);
      this.materials.push(m);
      return m;
    };
    this.ringShade = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.44, 48), mat(SHADE, 0.35));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.33, 0.4, 48), mat(COLOR, 0.95));
    this.dot = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), mat(COLOR, 0.95));
    for (const m of [this.ringShade, this.ring, this.dot]) {
      m.renderOrder = 999;
      flat.add(m);
    }
    const geo = chevronGeometry();
    for (let i = 0; i < 4; i++) {
      const pivot = new THREE.Group();
      // Chevrons sit on the diagonals and point at the centre
      pivot.rotation.z = Math.PI / 4 + (i * Math.PI) / 2;
      const shade = new THREE.Mesh(geo, mat(SHADE, 0.4));
      shade.scale.setScalar(1.35);
      const chev = new THREE.Mesh(geo, mat(COLOR, 0.95));
      shade.renderOrder = 999;
      chev.renderOrder = 1000;
      pivot.add(shade, chev);
      flat.add(pivot);
      this.chevrons.push(chev);
      this.shades.push(shade);
    }
    scene.add(this.group);
  }

  /** Play the marker at a ground point in game millimetres. */
  show(xMm: number, yMm: number) {
    this.group.position.set(xMm / 1000, Y, yMm / 1000);
    this.age = 0;
    this.group.visible = true;
    this.apply(0);
  }

  hide() {
    this.age = DURATION;
    this.group.visible = false;
  }

  update(dtSec: number) {
    if (!this.group.visible) return;
    this.age += dtSec;
    if (this.age >= DURATION) {
      this.group.visible = false;
      return;
    }
    this.apply(this.age / DURATION);
  }

  private apply(f: number) {
    const ease = 1 - (1 - f) * (1 - f); // ease-out
    const fade = f < 0.55 ? 1 : 1 - (f - 0.55) / 0.45;
    const ringScale = 1.3 - 0.75 * ease;
    this.ring.scale.setScalar(ringScale);
    this.ringShade.scale.setScalar(ringScale);
    const dist = 0.62 - 0.42 * ease; // chevron tip distance from the centre (m)
    for (let i = 0; i < 4; i++) {
      this.chevrons[i].position.x = -dist;
      this.shades[i].position.x = -dist + 0.02;
    }
    this.dot.scale.setScalar(0.6 + 0.6 * (1 - ease));
    for (const m of this.materials) m.userData.base ??= m.opacity;
    for (const m of this.materials) m.opacity = (m.userData.base as number) * fade;
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    for (const m of this.materials) m.dispose();
  }
}
