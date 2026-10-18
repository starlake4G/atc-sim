import * as THREE from "three";
import type { World } from "../sim/world";

/** Small animated scene cues; their positions are derived from fixed simulation time. */
export class EnvironmentModel {
  readonly root = new THREE.Group();
  private sock = new THREE.Group();
  private closure = new THREE.Group();
  private vehicle = new THREE.Group();
  private beacon: THREE.Mesh;

  constructor() {
    const steel = new THREE.MeshStandardMaterial({ color: 0xc4ced0, roughness: .55, metalness: .55 });
    const orange = new THREE.MeshStandardMaterial({ color: 0xf16c32, roughness: .85 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4eee0, roughness: .85 });
    const yellow = new THREE.MeshBasicMaterial({ color: 0xffcb4e });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(.24, .3, 13, 8), steel); pole.position.set(1050, 6.5, 100);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(.12, .12, 2, 8), steel); arm.rotation.z = Math.PI / 2; arm.position.set(1050, 13, 100);
    this.sock.position.set(1050, 13, 100);
    for (let i = 0; i < 5; i++) {
      const segment = new THREE.Mesh(new THREE.CylinderGeometry(.88 - i * .14, 1.02 - i * .14, 2, 10, 1, true), i % 2 ? white : orange);
      segment.rotation.z = -Math.PI / 2; segment.position.x = 1 + i * 2; this.sock.add(segment);
    }
    for (const x of [-1120, 1120]) for (const angle of [-Math.PI / 4, Math.PI / 4]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(20, .15, 2.5), yellow); bar.position.set(x, .45, 0); bar.rotation.y = angle; this.closure.add(bar);
    }
    const body = new THREE.Mesh(new THREE.BoxGeometry(5.8, 1.7, 2.5), orange); body.position.y = 1.2;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.3, 1.4, 2.3), new THREE.MeshStandardMaterial({ color: 0x314b58, roughness: .3 })); cab.position.set(1, 2.3, 0);
    const wheels = new THREE.InstancedMesh(new THREE.CylinderGeometry(.55, .55, .35, 10), new THREE.MeshStandardMaterial({ color: 0x202b30 }), 4);
    const wheel = new THREE.Object3D(); wheel.rotation.x = Math.PI / 2; let i = 0;
    for (const x of [-1.8, 1.8]) for (const z of [-1.25, 1.25]) { wheel.position.set(x, .55, z); wheel.updateMatrix(); wheels.setMatrixAt(i++, wheel.matrix); }
    this.beacon = new THREE.Mesh(new THREE.BoxGeometry(.7, .25, .6), yellow); this.beacon.position.set(.6, 3.1, 0);
    this.vehicle.add(body, cab, wheels, this.beacon);
    this.closure.visible = this.vehicle.visible = false;
    this.root.add(pole, arm, this.sock, this.closure, this.vehicle);
  }

  update(world: World): void {
    const wave = Math.sin(world.time * 2.6) * .03 * Math.min(2, world.windKt / 12);
    this.sock.rotation.set(0, (90 - (world.windDirDeg + 180)) * Math.PI / 180 + wave, -Math.max(.02, .38 - world.windKt / 65));
    const inspection = world.operations.snapshot().find((event) => event.kind === "inspection" && event.stage === "active");
    this.closure.visible = this.vehicle.visible = !!inspection;
    if (inspection) {
      const progress = Math.min(1, (world.time - inspection.startedAt!) / inspection.durationSec);
      this.vehicle.position.set(1000 - (progress < .5 ? progress * 2 : 2 - progress * 2) * 2000, .1, 6);
      this.vehicle.rotation.y = progress < .5 ? Math.PI : 0;
      this.beacon.visible = Math.floor(world.time * 3) % 2 === 0;
    }
  }
}
