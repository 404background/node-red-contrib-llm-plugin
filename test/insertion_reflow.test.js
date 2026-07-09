// Regression tests for Step 3.6 (insertion reflow).
// Run:  node test/insertion_reflow.test.js
//
// Contract: any time a NEW node is wired into the graph (placed via
// tryPlace because a positioned neighbour exists), Step 3.6 reflows
// that node's whole component in place — anchored to the component's
// current top-left so neighbouring components don't drift. This
// guarantees a uniform width-aware cadence after every connected
// insertion, even when the per-edge pushes in 3.4 / 3.5a couldn't
// resolve the geometry. Orphan-band new nodes (no positioned
// neighbour) are excluded; they get a fresh layout from Step 4.

const Layout = require('../src/core/canvas_layout.js');

const OPTS = {
    startX: 100, startY: 100,
    spacingY: 40, edgeGap: 40,
    componentGap: 80, bandGap: 80,
    maxColumns: Infinity
};
const NODE_HEIGHT = 30;

function widthOf(n, opts) {
    return Layout.estimateNodeWidth(n, opts);
}
function bbox(n, opts) {
    let w = widthOf(n, opts);
    return {
        l: n.x - w / 2, r: n.x + w / 2,
        t: n.y - NODE_HEIGHT / 2, b: n.y + NODE_HEIGHT / 2
    };
}
function overlaps(a, b) {
    return !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
}
function findOverlaps(nodes, opts) {
    let out = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[i].type === 'tab' || nodes[j].type === 'tab') continue;
            if (overlaps(bbox(nodes[i], opts), bbox(nodes[j], opts))) {
                out.push([nodes[i].id, nodes[j].id]);
            }
        }
    }
    return out;
}

let passed = 0, failed = 0;
function describe(label, fn) { console.log('\n' + label); fn(); }
function it(label, fn) {
    try { fn(); console.log('  ok  ' + label); passed++; }
    catch (e) { console.log('  FAIL ' + label + '\n       ' + e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ----------------------------------------------------------------------

describe('Insertion reflow', function() {
    it('new node between two tightly-packed existing nodes no longer overlaps', function() {
        // User has A and C tightly packed (gap = 50px).
        // LLM inserts wide X with wires A -> X, X -> C.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 150, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'New wide function here', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 300, y: 100, wires: [[]] };
        let nodes = [A, X, C];
        let existingIdMap = { A: true, C: true };
        let basePositions = { A: { x: 150, y: 100 }, C: { x: 300, y: 100 } };

        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, OPTS);

        let ov = findOverlaps(nodes, OPTS);
        assert(ov.length === 0, 'expected no overlaps, got: ' + JSON.stringify(ov));
        // Sanity: chain ordering preserved (A < X < C horizontally).
        assert(A.x < X.x && X.x < C.x, 'chain order broken: A=' + A.x + ' X=' + X.x + ' C=' + C.x);
    });

    it('multi-node insertion (A -> X1 -> X2 -> C) clears overlap', function() {
        // Existing tight pair.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 150, y: 100, wires: [['X1']] };
        let X1 = { id: 'X1', type: 'function', name: 'first inserted', z: 'ws', wires: [['X2']] };
        let X2 = { id: 'X2', type: 'function', name: 'second inserted node', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 320, y: 100, wires: [[]] };
        let nodes = [A, X1, X2, C];
        let existingIdMap = { A: true, C: true };
        let basePositions = { A: { x: 150, y: 100 }, C: { x: 320, y: 100 } };

        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, OPTS);

        let ov = findOverlaps(nodes, OPTS);
        assert(ov.length === 0, 'expected no overlaps, got: ' + JSON.stringify(ov));
        assert(A.x < X1.x && X1.x < X2.x && X2.x < C.x,
            'chain order broken: A=' + A.x + ' X1=' + X1.x + ' X2=' + X2.x + ' C=' + C.x);
    });

    it('connected insertion always reflows, even with plenty of room', function() {
        // The user explicitly requested: fire on insertion, not on
        // residual overlap. With a brand-new X wired between A and C,
        // the affected component reflows to a uniform cadence — C is
        // expected to move toward the cleanly-packed position rather
        // than keep its old wide gap.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'X', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 700, y: 100, wires: [[]] };
        let nodes = [A, X, C];
        let existingIdMap = { A: true, C: true };
        let basePositions = { A: { x: 100, y: 100 }, C: { x: 700, y: 100 } };

        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, OPTS);

        let ov = findOverlaps(nodes, OPTS);
        assert(ov.length === 0, 'unexpected overlaps: ' + JSON.stringify(ov));
        // C should have moved closer to X (reflow with uniform edgeGap).
        assert(C.x < 700, 'reflow should have tightened C: ' + C.x + ' (expected < 700)');
        assert(A.x < X.x && X.x < C.x, 'chain order broken: A=' + A.x + ' X=' + X.x + ' C=' + C.x);
    });

    it('append-to-end is treated as a connected insertion too', function() {
        // Adding X at the end of A → B is still a connection. Per the
        // updated contract, the component reflows. A starts the chain
        // and B is repositioned to a uniform edgeGap distance away.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['B']] };
        let B = { id: 'B', type: 'function', name: 'B', z: 'ws', x: 300, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'appended', z: 'ws', wires: [[]] };
        let nodes = [A, B, X];
        let existingIdMap = { A: true, B: true };
        let basePositions = { A: { x: 100, y: 100 }, B: { x: 300, y: 100 } };

        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, OPTS);

        let ov = findOverlaps(nodes, OPTS);
        assert(ov.length === 0, 'unexpected overlaps: ' + JSON.stringify(ov));
        assert(A.x < B.x && B.x < X.x,
            'chain order broken: A=' + A.x + ' B=' + B.x + ' X=' + X.x);
    });

    it('orphan-band new node (no positioned neighbour) does not trigger reflow', function() {
        // O has no wires to A/B. It lands in the orphan band. A and B
        // belong to a different (untouched) component and must keep
        // their user-chosen positions.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['B']] };
        let B = { id: 'B', type: 'function', name: 'B', z: 'ws', x: 500, y: 100, wires: [[]] };
        let O = { id: 'O', type: 'function', name: 'orphan', z: 'ws', wires: [[]] };
        let nodes = [A, B, O];
        let existingIdMap = { A: true, B: true };
        let basePositions = { A: { x: 100, y: 100 }, B: { x: 500, y: 100 } };

        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, OPTS);

        assert(A.x === 100 && A.y === 100, 'A moved unexpectedly: ' + A.x + ',' + A.y);
        assert(B.x === 500 && B.y === 100, 'B moved unexpectedly: ' + B.x + ',' + B.y);
        assert(typeof O.x === 'number' && typeof O.y === 'number', 'O should be placed somewhere');
    });
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
