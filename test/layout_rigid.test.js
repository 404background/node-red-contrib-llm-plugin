// Regression: during an incremental edit, a flow the user did NOT touch
// must only ever be TRANSLATED as a whole — never reflowed or sheared.
// Editing the upper flow (adding a node that overlaps a lower flow) must
// push the lower flow down by coordinates only, keeping its internal shape.
const Layout = require('../src/core/canvas_layout.js');

let assertions = 0, failures = 0;
function ok(cond, msg) {
  assertions++;
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

const isCanvasNode = (n) => n && n.type !== 'tab' && String(n.type).indexOf('subflow:') !== 0;

// Run one incremental layout; `newIds` marks the added node(s). Returns the
// per-node delta (final − base) for the nodes whose id starts with `prefix`.
function deltasFor(nodes, newIds, prefix) {
  const existingIdMap = {}, basePositions = {};
  nodes.forEach((n) => {
    if (!newIds[n.id]) { existingIdMap[n.id] = true; basePositions[n.id] = { x: n.x, y: n.y }; }
  });
  const watched = nodes.filter((n) => n.id.startsWith(prefix));
  const before = {};
  watched.forEach((n) => { before[n.id] = { x: n.x, y: n.y }; });
  Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, {
    startX: 100, startY: 100, maxColumns: Infinity, isCanvasNode,
  });
  return watched.map((n) => ({ id: n.id, dx: n.x - before[n.id].x, dy: n.y - before[n.id].y }));
}

function isUniform(deltas) {
  return deltas.length > 0 && deltas.every((d) => d.dx === deltas[0].dx && d.dy === deltas[0].dy);
}

console.log('Untouched flow stays rigid during an incremental edit');

// Case 1: upper flow branches (grows downward) into a lower flow below it.
(function () {
  const nodes = [
    { id: 'u1', type: 'inject',   z: 'z', name: 'U1', x: 100, y: 100, wires: [['u2', 'n']] },
    { id: 'u2', type: 'function', z: 'z', name: 'U2', x: 260, y: 100, wires: [[]] },
    { id: 'n',  type: 'debug',    z: 'z', name: 'N',                  wires: [[]] }, // NEW
    { id: 'l1', type: 'inject',   z: 'z', name: 'L1', x: 100, y: 180, wires: [['l2']] },
    { id: 'l2', type: 'function', z: 'z', name: 'L2', x: 260, y: 180, wires: [['l3']] },
    { id: 'l3', type: 'debug',    z: 'z', name: 'L3', x: 420, y: 180, wires: [[]] },
  ];
  const d = deltasFor(nodes, { n: true }, 'l');
  ok(isUniform(d), 'lower flow moved as a whole (uniform dx/dy)');
  ok(d.every((x) => x.dx === 0), 'lower flow did not shift horizontally');
  ok(d[0].dy >= 0, 'lower flow only moved down (or stayed)');
})();

// Case 2: a TALL untouched flow whose top sits ABOVE the edited node — the
// cross-component push skips it (it only pushes flows below), so the overlap
// reaches the safety net. It must translate rigidly, not shear. (This is the
// case that regressed before resolveOverlaps became component-rigid.)
(function () {
  const nodes = [
    { id: 'm1', type: 'function', z: 'z', name: 'M1', x: 100, y: 150, wires: [['n']] },
    { id: 'n',  type: 'debug',    z: 'z', name: 'N',                  wires: [[]] }, // NEW
    { id: 'o1', type: 'inject',   z: 'z', name: 'O1', x: 100, y: 100, wires: [['o2']] },
    { id: 'o2', type: 'function', z: 'z', name: 'O2', x: 100, y: 160, wires: [[]] },
  ];
  const gapBefore = 160 - 100;
  const d = deltasFor(nodes, { n: true }, 'o');
  ok(isUniform(d), 'tall untouched flow moved as a whole (uniform dx/dy)');
  const o1 = nodes.find((x) => x.id === 'o1');
  const o2 = nodes.find((x) => x.id === 'o2');
  ok((o2.y - o1.y) === gapBefore, 'its internal vertical gap is preserved (not sheared)');
})();

console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
