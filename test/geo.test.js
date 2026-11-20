import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../src/geo.js';
import { ll, square, ORIGIN, asPair } from './helpers.js';

const yard = square(20);
const near = (a, b, m) => geo.distanceM(a, b) <= m;

test('project and unproject round-trip with 111195.08 m per degree', () => {
  assert.ok(Math.abs(geo.M_PER_DEG - 111195.08) < 0.01);
  const p = ll(30, -40);
  const q = geo.project(ORIGIN, p);
  assert.ok(Math.abs(q.x - 30) < 0.01 && Math.abs(q.y + 40) < 0.01, JSON.stringify(q));
  const r = geo.unproject(ORIGIN, q);
  assert.ok(Math.abs(r.lat - p.lat) < 1e-9 && Math.abs(r.lng - p.lng) < 1e-9);
  assert.ok(Math.abs(geo.distanceM(ll(0, 0), ll(30, 40)) - 50) < 0.01);
});

test('pointInPolygon and signed distanceToBoundary (+ outside)', () => {
  assert.equal(geo.pointInPolygon(ll(0, 0), yard), true);
  assert.equal(geo.pointInPolygon(ll(25, 0), yard), false);
  assert.ok(Math.abs(geo.distanceToBoundary(ll(0, 0), yard) + 20) < 0.05);
  assert.ok(Math.abs(geo.distanceToBoundary(ll(15, 0), yard) + 5) < 0.05);
  assert.ok(Math.abs(geo.distanceToBoundary(ll(26, 0), yard) - 6) < 0.05);
  assert.ok(Math.abs(geo.distanceToBoundary(ll(23, 24), yard) - 5) < 0.05);
});

test('perimeter length and positions along it (vertex 0 is the start, wraps)', () => {
  assert.ok(Math.abs(geo.perimeterLength(yard) - 160) < 0.1);
  assert.ok(near(geo.pointAtPerimeter(yard, 10), ll(-10, -20), 0.05));
  assert.ok(near(geo.pointAtPerimeter(yard, 170), ll(-10, -20), 0.05));
  assert.ok(near(geo.pointAtPerimeter(yard, 45), ll(20, -15), 0.05));
});

test('segmentBoundaryCrossings returns every crossing sorted by t with its perimeter position', () => {
  const xs = geo.segmentBoundaryCrossings(ll(10, 5), ll(30, 5), yard);
  assert.equal(xs.length, 1);
  assert.ok(near(xs[0].point, ll(20, 5), 0.05));
  assert.ok(Math.abs(xs[0].t - 0.5) < 1e-6);
  assert.ok(Math.abs(xs[0].perimeter_m - 65) < 0.1);
  const through = geo.segmentBoundaryCrossings(ll(-30, 0), ll(30, 0), yard);
  assert.equal(through.length, 2);
  assert.ok(through[0].t < through[1].t);
  assert.ok(near(through[0].point, ll(-20, 0), 0.05));
  assert.ok(Math.abs(through[0].perimeter_m - 140) < 0.1);
  assert.deepEqual(geo.segmentBoundaryCrossings(ll(0, 0), ll(5, 5), yard), []);
});

test('circle, rectangle and geofenceToPolygon keep Tractive [lat, lng] order', () => {
  const c = geo.circleToPolygon(ORIGIN, 30);
  assert.equal(c.length, 32);
  for (const p of c) assert.ok(Math.abs(geo.distanceM(ORIGIN, p) - 30) < 0.05);
  const r = geo.rectangleToPolygon(ll(-10, -5), ll(10, 5));
  assert.equal(r.length, 4);
  assert.ok(Math.abs(geo.perimeterLength(r) - 60) < 0.1);
  const g = (shape, coords, radius = null) => ({ shape, coords, radius });
  const poly = geo.geofenceToPolygon(g('POLYGON', yard.map(asPair)));
  assert.equal(poly.length, 4);
  assert.ok(near(poly[0], yard[0], 0.01));
  assert.equal(geo.geofenceToPolygon(g('CIRCLE', [asPair(ORIGIN)], 25)).length, 32);
  assert.equal(geo.geofenceToPolygon(g('RECTANGLE', [asPair(ll(-10, -5)), asPair(ll(10, 5))])).length, 4);
  assert.equal(geo.geofenceToPolygon(g('POLYGON', [[41, 2], [41.0001, 2]])), null);
  assert.equal(geo.geofenceToPolygon(g('CIRCLE', [[41, 2]], null)), null);
  assert.equal(geo.geofenceToPolygon(g('POLYGON', [[91, 2], [41, 2], [41, 2.001]])), null);
  assert.equal(geo.geofenceToPolygon({ shape: 'POLYGON', coords: 'x' }), null);
  assert.equal(geo.geofenceToPolygon(null), null);
});

test('polylineLength sums segment distances', () => {
  assert.ok(Math.abs(geo.polylineLength([ll(0, 0), ll(30, 0), ll(30, 40)]) - 70) < 0.1);
  assert.equal(geo.polylineLength([]), 0);
});
