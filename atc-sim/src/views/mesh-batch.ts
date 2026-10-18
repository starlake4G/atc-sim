import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Batch only siblings with the same material; animated groups stay independent. */
export function batchStaticParts(root: THREE.Group, excluded: ReadonlySet<THREE.Object3D> = new Set()) {
  const groups = new Map<string, THREE.Mesh[]>();
  for (const object of root.children) {
    if (!(object instanceof THREE.Mesh) || object instanceof THREE.InstancedMesh || excluded.has(object) || Array.isArray(object.material)) continue;
    const key = object.material.uuid;
    groups.set(key, [...groups.get(key) ?? [], object]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const geometries = group.map((mesh) => {
      mesh.updateMatrix();
      return (mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()).applyMatrix4(mesh.matrix);
    });
    const merged = mergeGeometries(geometries);
    if (merged) {
      const mesh = new THREE.Mesh(merged, group[0]!.material);
      const originals = new Set(group.map((original) => original.geometry));
      group.forEach((original) => root.remove(original)); originals.forEach((geometry) => geometry.dispose());
      root.add(mesh);
    }
    geometries.forEach((geometry) => geometry.dispose());
  }
}
