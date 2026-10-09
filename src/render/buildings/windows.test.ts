import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FRAME,
  GLASS,
  SILL,
  WINDOW_FRAME_SCALE,
  WINDOW_MAX_VERTICES,
  WINDOW_PROUD,
  WINDOW_SILL_DROP,
  windowGeometry,
} from './windows.ts';

interface Vertex {
  x: number;
  y: number;
  z: number;
  color: THREE.Color;
}

function vertices(geometry: THREE.BufferGeometry): Vertex[] {
  const position = geometry.getAttribute('position');
  const color = geometry.getAttribute('color');
  return Array.from({ length: position.count }, (_, i) => ({
    x: position.getX(i),
    y: position.getY(i),
    z: position.getZ(i),
    color: new THREE.Color(color.getX(i), color.getY(i), color.getZ(i)),
  }));
}

/** Float32 colour attributes lose precision, so compare with a tolerance. */
function isColor(v: Vertex, hex: number): boolean {
  const target = new THREE.Color(hex);
  return (
    Math.abs(v.color.r - target.r) < 1e-6 &&
    Math.abs(v.color.g - target.g) < 1e-6 &&
    Math.abs(v.color.b - target.b) < 1e-6
  );
}

function ofColor(all: Vertex[], hex: number): Vertex[] {
  return all.filter((v) => isColor(v, hex));
}

function bounds(vs: Vertex[]) {
  return {
    minX: Math.min(...vs.map((v) => v.x)),
    maxX: Math.max(...vs.map((v) => v.x)),
    minY: Math.min(...vs.map((v) => v.y)),
    maxY: Math.max(...vs.map((v) => v.y)),
    minZ: Math.min(...vs.map((v) => v.z)),
    maxZ: Math.max(...vs.map((v) => v.z)),
  };
}

describe('windowGeometry', () => {
  const geometry = windowGeometry();
  const all = vertices(geometry);

  it('carries a vertex colour per vertex and stays within the vertex budget', () => {
    expect(geometry.getAttribute('color')).toBeDefined();
    expect(geometry.getAttribute('color').count).toBe(geometry.getAttribute('position').count);
    expect(geometry.getAttribute('normal').count).toBe(geometry.getAttribute('position').count);
    expect(all.length).toBeLessThanOrEqual(WINDOW_MAX_VERTICES);
  });

  it('spans the glass over x -0.5..0.5 and y 0..1', () => {
    const glass = bounds(ofColor(all, GLASS));
    expect(glass.minX).toBeCloseTo(-0.5, 6);
    expect(glass.maxX).toBeCloseTo(0.5, 6);
    expect(glass.minY).toBeCloseTo(0, 6);
    expect(glass.maxY).toBeCloseTo(1, 6);
    expect(glass.minZ).toBeCloseTo(2 * WINDOW_PROUD, 6);
    expect(glass.maxZ).toBeCloseTo(2 * WINDOW_PROUD, 6);
  });

  it('frames the glass with a plane WINDOW_FRAME_SCALE larger, behind it', () => {
    const framePlane = ofColor(all, FRAME).filter((v) => Math.abs(v.z - WINDOW_PROUD) < 1e-9);
    expect(framePlane.length).toBe(4);
    const frame = bounds(framePlane);
    expect(frame.maxX - frame.minX).toBeCloseTo(WINDOW_FRAME_SCALE, 6);
    expect(frame.maxY - frame.minY).toBeCloseTo(WINDOW_FRAME_SCALE, 6);
    expect((frame.minX + frame.maxX) / 2).toBeCloseTo(0, 6);
    expect((frame.minY + frame.maxY) / 2).toBeCloseTo(0.5, 6);
    expect(bounds(ofColor(all, GLASS)).minZ).toBeGreaterThan(frame.maxZ);
  });

  it('puts the mullion cross in front of the glass', () => {
    const mullions = ofColor(all, FRAME).filter((v) => v.z > WINDOW_PROUD + 1e-9);
    expect(mullions.length).toBe(8);
    const glassZ = bounds(ofColor(all, GLASS)).maxZ;
    for (const v of mullions) expect(v.z).toBeGreaterThan(glassZ);
    const m = bounds(mullions);
    expect(m.minX).toBeCloseTo(-0.5, 6);
    expect(m.maxX).toBeCloseTo(0.5, 6);
    expect(m.minY).toBeCloseTo(0, 6);
    expect(m.maxY).toBeCloseTo(1, 6);
  });

  it('keeps everything proud of the wall except the sill back face', () => {
    for (const v of all) {
      if (v.z < WINDOW_PROUD - 1e-9) {
        expect(isColor(v, SILL)).toBe(true);
        expect(v.z).toBeCloseTo(0, 6);
      }
    }
  });

  it('runs the sill across the frame width below the glass', () => {
    const sill = bounds(ofColor(all, SILL));
    expect(sill.maxX - sill.minX).toBeCloseTo(WINDOW_FRAME_SCALE, 6);
    expect(sill.maxY).toBeLessThan(0);
    expect(sill.minY).toBeCloseTo(-WINDOW_SILL_DROP, 6);
    expect(sill.minZ).toBeCloseTo(0, 6);
    expect(sill.maxZ).toBeGreaterThan(WINDOW_PROUD);
  });
});
