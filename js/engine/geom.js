/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 정적 지오메트리를 재질별로 한 메시에 합치는 배치와 파이프 변환 행렬 도우미.
 */
/**
 * SKALA 작전 — 정적 지오메트리 배치 (재질별로 한 메시에 합쳐 드로우콜 절약)
 *
 *   const batch = new GeoBatch();
 *   batch.addBox(minX,minY,minZ,maxX,maxY,maxZ, scale, { skipBottom:true });
 *   batch.addGeometry(threeGeometry, matrix4);   // 임의 지오메트리 합치기(색 있으면 color 속성 유지)
 *   const geo = batch.build();                    // THREE.BufferGeometry
 *
 * UV는 월드 좌표 / scale (텍스처가 실제 크기로 반복되게).
 */
import * as THREE from 'three';

export class GeoBatch {
  constructor(opt = {}) {
    this.pos = []; this.nor = []; this.uv = []; this.idx = [];
    this.col = opt.colors ? [] : null;
    this.vcount = 0;
    this._color = [1, 1, 1];
  }

  get empty() { return this.vcount === 0; }

  /** 이후 추가되는 정점 색 (colors:true 배치에서만 의미) */
  setColor(hex) {
    const c = new THREE.Color(hex);
    this._color = [c.r, c.g, c.b];
    return this;
  }

  _v(x, y, z, nx, ny, nz, u, v) {
    this.pos.push(x, y, z); this.nor.push(nx, ny, nz); this.uv.push(u, v);
    if (this.col) this.col.push(this._color[0], this._color[1], this._color[2]);
    return this.vcount++;
  }

  /** 사각형 a,b,c,d(반시계 = 앞면) */
  quad(a, b, c, d, n, s) {
    const i = this._v(a[0], a[1], a[2], n[0], n[1], n[2], a[3] / s, a[4] / s);
    this._v(b[0], b[1], b[2], n[0], n[1], n[2], b[3] / s, b[4] / s);
    this._v(c[0], c[1], c[2], n[0], n[1], n[2], c[3] / s, c[4] / s);
    this._v(d[0], d[1], d[2], n[0], n[1], n[2], d[3] / s, d[4] / s);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  tri(a, b, c, n, s) {
    const i = this._v(a[0], a[1], a[2], n[0], n[1], n[2], a[3] / s, a[4] / s);
    this._v(b[0], b[1], b[2], n[0], n[1], n[2], b[3] / s, b[4] / s);
    this._v(c[0], c[1], c[2], n[0], n[1], n[2], c[3] / s, c[4] / s);
    this.idx.push(i, i + 1, i + 2);
  }

  /** 축 정렬 박스. opt: { skipBottom, skipTop, skip:{px,nx,py,ny,pz,nz} } */
  addBox(x0, y0, z0, x1, y1, z1, s = 1, opt = {}) {
    const sk = opt.skip || {};
    // +X
    if (!sk.px) this.quad([x1, y0, z1, z1, y0], [x1, y0, z0, z0, y0], [x1, y1, z0, z0, y1], [x1, y1, z1, z1, y1], [1, 0, 0], s);
    // -X
    if (!sk.nx) this.quad([x0, y0, z0, z0, y0], [x0, y0, z1, z1, y0], [x0, y1, z1, z1, y1], [x0, y1, z0, z0, y1], [-1, 0, 0], s);
    // +Y
    if (!sk.py && !opt.skipTop) this.quad([x0, y1, z1, x0, -z1], [x1, y1, z1, x1, -z1], [x1, y1, z0, x1, -z0], [x0, y1, z0, x0, -z0], [0, 1, 0], s);
    // -Y
    if (!sk.ny && !opt.skipBottom) this.quad([x0, y0, z0, x0, z0], [x1, y0, z0, x1, z0], [x1, y0, z1, x1, z1], [x0, y0, z1, x0, z1], [0, -1, 0], s);
    // +Z
    if (!sk.pz) this.quad([x0, y0, z1, x0, y0], [x1, y0, z1, x1, y0], [x1, y1, z1, x1, y1], [x0, y1, z1, x0, y1], [0, 0, 1], s);
    // -Z
    if (!sk.nz) this.quad([x1, y0, z0, -x1, y0], [x0, y0, z0, -x0, y0], [x0, y1, z0, -x0, y1], [x1, y1, z0, -x1, y1], [0, 0, -1], s);
  }

  /** 쐐기(경사로). dir 방향으로 y0→y1 상승 */
  addRamp(x0, y0, z0, x1, y1, z1, dir, s = 1, opt = {}) {
    const h = y1 - y0;
    // 로컬: 경사 축 a(0→L), 가로 축 b. 월드로 바꾸는 함수
    let P, L, W;
    if (dir === '+x' || dir === '-x') {
      L = x1 - x0; W = z1 - z0;
      P = dir === '+x' ? (a, y, b) => [x0 + a, y, z0 + b] : (a, y, b) => [x1 - a, y, z1 - b];
    } else {
      L = z1 - z0; W = x1 - x0;
      P = dir === '+z' ? (a, y, b) => [x1 - b, y, z0 + a] : (a, y, b) => [x0 + b, y, z1 - a];
    }
    const V = (a, y, b, u, v) => { const p = P(a, y, b); return [p[0], p[1], p[2], u, v]; };
    const nrm = (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      return [nx / l, ny / l, nz / l];
    };
    const slopeLen = Math.hypot(L, h);
    // 경사면: (0,y0,0) (0,y0,W) (L,y1,W) (L,y1,0)
    {
      const a = V(0, y0, 0, 0, 0), b = V(0, y0, W, W, 0), c = V(L, y1, W, W, slopeLen), d = V(L, y1, 0, 0, slopeLen);
      const n = nrm(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      if (n[1] < 0) this.quad(d, c, b, a, [-n[0], -n[1], -n[2]], s); else this.quad(a, b, c, d, n, s);
    }
    // 뒷면(높은 끝, 세로)
    {
      const a = V(L, y0, 0, 0, y0), b = V(L, y1, 0, 0, y1), c = V(L, y1, W, W, y1), d = V(L, y0, W, W, y0);
      const n = nrm(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      const out = P(L + 1, y0, W / 2), ctr = P(L, y0, W / 2);
      const want = [out[0] - ctr[0], 0, out[2] - ctr[2]];
      if (n[0] * want[0] + n[2] * want[2] < 0) this.quad(d, c, b, a, [-n[0], -n[1], -n[2]], s); else this.quad(a, b, c, d, n, s);
    }
    // 옆면 삼각형 2개
    for (const bb of [0, W]) {
      const a = V(0, y0, bb, 0, y0), b = V(L, y0, bb, L, y0), c = V(L, y1, bb, L, y1);
      const n = nrm(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      const out = P(L / 2, y0, bb === 0 ? -1 : W + 1), ctr = P(L / 2, y0, W / 2);
      const want = [out[0] - ctr[0], 0, out[2] - ctr[2]];
      if (n[0] * want[0] + n[2] * want[2] < 0) this.tri(c, b, a, [-n[0], -n[1], -n[2]], s); else this.tri(a, b, c, n, s);
    }
    // 바닥
    if (!opt.skipBottom) {
      const a = V(0, y0, 0, 0, 0), b = V(L, y0, 0, L, 0), c = V(L, y0, W, L, W), d = V(0, y0, W, 0, W);
      const n = nrm(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
      if (n[1] > 0) this.quad(d, c, b, a, [0, -1, 0], s); else this.quad(a, b, c, d, [0, -1, 0], s);
    }
  }

  /** 세로 원통 (매끈한 옆면 노멀) */
  addCylinder(cx, y0, cz, r, h, s = 1, opt = {}) {
    const seg = opt.segments || Math.max(12, Math.min(40, Math.round(r * 9)));
    const y1 = y0 + h;
    const circ = Math.PI * 2 * r;
    const base = this.vcount;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const u = ((i / seg) * circ) / s;
      this._v(cx + ca * r, y0, cz + sa * r, ca, 0, sa, u, y0 / s);
      this._v(cx + ca * r, y1, cz + sa * r, ca, 0, sa, u, y1 / s);
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    const cap = (y, up) => {
      const c0 = this._v(cx, y, cz, 0, up ? 1 : -1, 0, cx / s, cz / s);
      for (let i = 0; i <= seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        this._v(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r, 0, up ? 1 : -1, 0, (cx + Math.cos(a) * r) / s, (cz + Math.sin(a) * r) / s);
      }
      for (let i = 0; i < seg; i++) {
        if (up) this.idx.push(c0, c0 + 2 + i, c0 + 1 + i); else this.idx.push(c0, c0 + 1 + i, c0 + 2 + i);
      }
    };
    if (!opt.skipTop) cap(y1, true);
    if (!opt.skipBottom) cap(y0, false);
  }

  /** three 지오메트리를 행렬로 변환해 합치기 (UV는 그대로, 없으면 0) */
  addGeometry(geo, matrix) {
    const g = geo;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv, col = g.attributes.color;
    const nm = new THREE.Matrix3().getNormalMatrix(matrix);
    const v = new THREE.Vector3(), vn = new THREE.Vector3();
    const base = this.vcount;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(matrix);
      if (n) vn.fromBufferAttribute(n, i).applyMatrix3(nm).normalize(); else vn.set(0, 1, 0);
      this.pos.push(v.x, v.y, v.z); this.nor.push(vn.x, vn.y, vn.z);
      this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      if (this.col) {
        if (col) this.col.push(col.getX(i), col.getY(i), col.getZ(i));
        else this.col.push(this._color[0], this._color[1], this._color[2]);
      }
      this.vcount++;
    }
    if (g.index) {
      const ix = g.index;
      for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    } else {
      for (let i = 0; i < p.count; i++) this.idx.push(base + i);
    }
  }

  build() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.setIndex(this.vcount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/** 두 점 사이 원통(파이프)용 변환 행렬: 단위 원통(반지름 1, 높이 1, y 0→1) 기준 */
const _up = new THREE.Vector3(0, 1, 0);
export function pipeMatrix(from, to, r, out = new THREE.Matrix4()) {
  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const dir = b.clone().sub(a);
  const len = dir.length() || 0.001;
  dir.divideScalar(len);
  const q = new THREE.Quaternion().setFromUnitVectors(_up, dir);
  out.compose(a, q, new THREE.Vector3(r, len, r));
  return out;
}
