// Regression tests for the layout engine (src/core/canvas_layout.js).
// Run with `node test/canvas_layout.test.js`.
//
// Three guarantees, each with its own history:
//
// 1. Cross-component push (Step 3.5b) moves every pushed component by ONE
//    uniform dy. Deriving dy per component made a comment sitting above its
//    target travel further than the target (its higher minY produced a bigger
//    dy) until the two collapsed onto the same row.
// 2. Insertion reflow (Step 3.6) fires whenever a NEW node is wired into the
//    graph, reflowing that component in place, anchored to its current
//    top-left. Orphan-band nodes (no positioned neighbour) are excluded.
// 3. A component the edit did not touch is RIGID: it may be translated as a
//    whole, never reflowed or sheared.

const Layout = require('../src/core/canvas_layout.js');
const { it, describe, assert, ok, summary } = require('./helpers.js');

const NODE_HEIGHT = 30;

// Wide spacing — used by the push-down / grid-alignment cases so the
// component gaps under test are unambiguous.
const WIDE = {
    startX: 200, startY: 200, spacingY: 80, edgeGap: 80,
    componentGap: 80, bandGap: 80
};
// Default-ish spacing — used by the insertion cases, which are about
// horizontal cadence rather than vertical banding.
const TIGHT = {
    startX: 100, startY: 100, spacingY: 40, edgeGap: 40,
    componentGap: 80, bandGap: 80
};

// --- Geometry helpers -------------------------------------------------
// Widths come from the engine's own estimator so an overlap check here
// measures the same boxes the layout was reasoning about.

function leftEdge(n, opts) {
    return n.x - Layout.estimateNodeWidth(n, opts) / 2;
}
function bbox(n, opts) {
    let w = Layout.estimateNodeWidth(n, opts);
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
                out.push(nodes[i].id + '/' + nodes[j].id);
            }
        }
    }
    return out;
}

// ======================================================================

describe('Step 3.5b cross-component push preserves comment/target gap', function() {
    it('uniform dy keeps comment above its target after cascade', function() {
        // Three existing chains stacked at y=200, 280, 360 with comments
        // 40px above each. Insert a tall node that forces chain 1 to grow
        // downward; cascade should push chain 2 + its comment by the same
        // amount so they don't collide.
        const c1a = { id: 'c1a', type: 'inject',   x: 200, y: 200, wires: [['c1b']] };
        const c1b = { id: 'c1b', type: 'function', x: 380, y: 200, wires: [], name: 'c1b' };
        const c2a = { id: 'c2a', type: 'inject',   x: 200, y: 280, wires: [['c2b']] };
        const c2b = { id: 'c2b', type: 'function', x: 380, y: 280, wires: [], name: 'c2b' };
        const c3a = { id: 'c3a', type: 'inject',   x: 200, y: 360, wires: [['c3b']] };
        const c3b = { id: 'c3b', type: 'function', x: 380, y: 360, wires: [], name: 'c3b' };
        const cm1 = { id: 'cm1', type: 'comment', name: 'c1', wires: [], x: 200, y: 160 };
        const cm2 = { id: 'cm2', type: 'comment', name: 'c2', wires: [], x: 200, y: 240 };
        const cm3 = { id: 'cm3', type: 'comment', name: 'c3', wires: [], x: 200, y: 320 };
        const big = { id: 'big', type: 'function', name: 'BIG_NEW_NODE',
                      wires: [['c1b']], _llmOrder: 1, _llmAlias: 'fn_big' };
        const nodes = [c1a, c1b, c2a, c2b, c3a, c3b, cm1, cm2, cm3, big];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { c1a:1, c1b:1, c2a:1, c2b:1, c3a:1, c3b:1, cm1:1, cm2:1, cm3:1 },
            { c1a:{x:200,y:200}, c1b:{x:380,y:200},
              c2a:{x:200,y:280}, c2b:{x:380,y:280},
              c3a:{x:200,y:360}, c3b:{x:380,y:360},
              cm1:{x:200,y:160}, cm2:{x:200,y:240}, cm3:{x:200,y:320} },
            WIDE);
        let bad = findOverlaps(nodes, WIDE);
        assert(bad.length === 0, 'overlaps found: ' + bad.join(', '));
        // The cm2/c2a gap (40) must be preserved across the shift.
        assert(c2a.y - cm2.y === 40,
            'cm2 should remain 40px above c2a, got ' + (c2a.y - cm2.y));
        // ...and the cascade must move every pushed component by the SAME
        // dy, so the chains it did not otherwise touch keep their original
        // 80px spacing. Deriving dy per component (the historical bug)
        // aims each one at the modifier's bottom edge instead, which a
        // later overlap pass then pulls apart to 110 — no collision, but
        // the band has been sheared. Assert the spacing, not just the
        // absence of overlap, or that regression goes unnoticed.
        assert(c3a.y - c2a.y === 80,
            'chains 2 and 3 should stay 80px apart, got ' + (c3a.y - c2a.y));
        assert(cm3.y - cm2.y === 80,
            'captions 2 and 3 should stay 80px apart, got ' + (cm3.y - cm2.y));
    });

    it('new comment lands on grid above its new-inject target', function() {
        // Prior bug repro: new inject hooked to existing change-node, new
        // comment anchored above the new inject. Should NOT end up at the
        // same y as the inject.
        const change = { id: 'change', type: 'change', x: 820, y: 870, wires: [], name: 'create_sensor_json' };
        const inj    = { id: 'inj1', type: 'inject', wires: [['change']],
                         _llmOrder: 1, _llmAlias: 'inject_mqtt_send' };
        const cmt    = { id: 'cmt1', type: 'comment', name: 'MQTT送信', wires: [],
                         _llmOrder: 0, _llmAlias: 'comment_mqtt_send', _llmAboveId: 'inj1' };
        const nodes = [change, inj, cmt];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { change: 1 }, { change:{x:820,y:870} }, WIDE);
        assert(cmt.y !== inj.y, 'comment ended up at inject.y');
        assert(inj.y - cmt.y === 40, 'comment should be 40px above inject');
        // Edge semantics: the inject aligns to its successor's row, sits
        // exactly edgeGap left of it, and the caption shares its left edge.
        assert(inj.y === change.y, 'inject should align to succ row, got ' + inj.y);
        assert(leftEdge(change, WIDE) - (leftEdge(inj, WIDE) + Layout.estimateNodeWidth(inj, WIDE)) === WIDE.edgeGap,
            'inject should sit edgeGap left of succ');
        assert(leftEdge(cmt, WIDE) === leftEdge(inj, WIDE),
            'comment should left-align to inject: ' + leftEdge(cmt, WIDE) + ' vs ' + leftEdge(inj, WIDE));
        assert(leftEdge(inj, WIDE) % 20 === 0, 'inject left edge not grid-aligned: ' + leftEdge(inj, WIDE));
    });
});

describe('Step 3.5a sibling nudge', function() {
    it('pushes a new sibling down by spacingY', function() {
        const a  = { id: 'a',  type: 'inject',   x: 200, y: 200, wires: [['b', 's2']] };
        const b  = { id: 'b',  type: 'function', x: 380, y: 200, wires: [], name: 'b' };
        const s2 = { id: 's2', type: 'function', wires: [], name: 's2',
                     _llmOrder: 1, _llmAlias: 'fn_s2' };
        const nodes = [a, b, s2];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { a:1, b:1 }, { a:{x:200,y:200}, b:{x:380,y:200} }, WIDE);
        assert(s2.y >= 280, 's2 should be nudged below row 200, got ' + s2.y);
        assert(findOverlaps(nodes, WIDE).length === 0, 'sibling nudge produced overlap');
    });
});

describe('Grid alignment', function() {
    // EDGES are the aligned quantity, not centres — on both axes. A node's
    // centre is derived as leftEdge + width/2 and lands on a half-grid
    // whenever the width is an odd grid multiple (e.g. the 100px minimum);
    // its `y` is derived from the row's top edge the same way, which is what
    // makes the gap above a flow the same as the gap beside it.
    it('reflowCanvasNodes puts left edges and centres on the grid', function() {
        const nodes = [
            { id: 'a', type: 'inject', wires: [['b']] },
            { id: 'b', type: 'function', name: 'compute aggregated rolling average', wires: [['c']] },
            { id: 'c', type: 'debug', wires: [] }
        ];
        Layout.reflowCanvasNodes(nodes, WIDE);
        nodes.forEach(n => assert(leftEdge(n, WIDE) % 20 === 0,
            n.id + ' left edge not grid-aligned: ' + leftEdge(n, WIDE)));
        nodes.forEach(n => assert(n.y % 20 === 0, n.id + ' centre not grid-aligned: ' + n.y));
        // The first row's top edge is `startY`, moved down onto the grid.
        const top = nodes[0].y - NODE_HEIGHT / 2;
        assert(top >= WIDE.startY && top < WIDE.startY + 20,
            'first row top edge ' + top + ', startY ' + WIDE.startY);
        assert(leftEdge(nodes[0], WIDE) === WIDE.startX,
            'first column left edge ' + leftEdge(nodes[0], WIDE));
    });

    it('placeAddedNodesNearNeighbors keeps left edges aligned', function() {
        const nodes = [
            { id: 'a', type: 'inject', x: 200, y: 200, wires: [['n']] },
            { id: 'n', type: 'function', name: 'wide', wires: [['b']],
              _llmOrder: 1, _llmAlias: 'fn_n' },
            { id: 'b', type: 'debug', x: 480, y: 200, wires: [] }
        ];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { a:1, b:1 }, { a:{x:200,y:200}, b:{x:480,y:200} }, WIDE);
        const a = nodes[0], n = nodes[1];
        assert(leftEdge(n, WIDE) === leftEdge(a, WIDE) + Layout.estimateNodeWidth(a, WIDE) + WIDE.edgeGap,
            'new node left edge should be pred right edge + edgeGap, got ' + leftEdge(n, WIDE));
        nodes.forEach(nd => assert(leftEdge(nd, WIDE) % 20 === 0,
            nd.id + ' left edge not grid-aligned: ' + leftEdge(nd, WIDE)));
    });

    it('comment placement uses grid-aligned stack step', function() {
        const t  = { id: 't',  type: 'function', x: 200, y: 200, wires: [], name: 'target' };
        const c1 = { id: 'c1', type: 'comment', name: 'top', wires: [],
                     _llmOrder: 1, _llmAlias: 'cmt_1', _llmAboveId: 't' };
        const c2 = { id: 'c2', type: 'comment', name: 'mid', wires: [],
                     _llmOrder: 2, _llmAlias: 'cmt_2', _llmAboveId: 't' };
        const c3 = { id: 'c3', type: 'comment', name: 'bot', wires: [],
                     _llmOrder: 3, _llmAlias: 'cmt_3', _llmAboveId: 't' };
        const nodes = [t, c1, c2, c3];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { t:1 }, { t:{x:200,y:200} }, WIDE);
        [c1, c2, c3].forEach(n => assert(leftEdge(n, WIDE) === leftEdge(t, WIDE),
            n.id + ' should left-align to target: ' + leftEdge(n, WIDE) + ' vs ' + leftEdge(t, WIDE)));
        // Step = ceil(30/20)*20 = 40
        assert(c3.y === 160, 'bottom comment should be 40px above target');
        assert(c2.y === 120, 'middle comment should be 80px above target');
        assert(c1.y === 80,  'top comment should be 120px above target');
    });
});

describe('Standalone comments (no touching neighbour)', function() {
    // A comment with empty space below it is a deliberate annotation, not a
    // caption: no anchor is captured for it and no pass may drag it into the
    // orphan band.
    function birdsEyeFlow() {
        return [
            { id: 'inj', type: 'inject',   name: 'in',  x: 280, y: 260, wires: [['fn']] },
            { id: 'fn',  type: 'function', name: 'fn',  x: 480, y: 260, wires: [['dbg']] },
            { id: 'dbg', type: 'debug',    name: 'dbg', x: 680, y: 260, wires: [] },
            { id: 'note', type: 'comment', name: 'Flow Explanation', x: 180, y: 100, wires: [] }
        ];
    }
    function assertNotePut(flow) {
        const note = flow.find(n => n.id === 'note');
        assert(note.x === 180 && note.y === 100,
            'standalone comment moved from (180,100) to (' + note.x + ',' + note.y + ')');
    }
    const BASE_IDS = { inj:1, fn:1, dbg:1, note:1 };
    const BASE_POS = { inj:{x:280,y:260}, fn:{x:480,y:260}, dbg:{x:680,y:260}, note:{x:180,y:100} };

    it('reflowCanvasNodes leaves a bird\'s-eye caption at its original (x,y)', function() {
        const flow = birdsEyeFlow();
        Layout.reflowCanvasNodes(flow, WIDE);
        assertNotePut(flow);
    });

    it('placeAddedNodesNearNeighbors keeps the standalone caption put', function() {
        const flow = birdsEyeFlow();
        Layout.placeAddedNodesNearNeighbors(flow, BASE_IDS, BASE_POS, WIDE);
        assertNotePut(flow);
    });

    it('placeAddedNodesNearNeighbors with a new sibling still preserves the caption', function() {
        const flow = birdsEyeFlow();
        flow.push({ id: 'newdbg', type: 'debug', name: 'new', wires: [],
                    _llmOrder: 1, _llmAlias: 'dbg_new' });
        flow[0].wires = [['fn', 'newdbg']];
        Layout.placeAddedNodesNearNeighbors(flow, BASE_IDS, BASE_POS, WIDE);
        assertNotePut(flow);
    });
});

describe('Step 3.6 insertion reflow', function() {
    it('new node between two tightly-packed existing nodes no longer overlaps', function() {
        // User has A and C tightly packed (gap = 50px).
        // LLM inserts wide X with wires A -> X, X -> C.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 150, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'New wide function here', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 300, y: 100, wires: [[]] };
        let nodes = [A, X, C];
        Layout.placeAddedNodesNearNeighbors(nodes, { A: true, C: true },
            { A: { x: 150, y: 100 }, C: { x: 300, y: 100 } }, TIGHT);

        let ov = findOverlaps(nodes, TIGHT);
        assert(ov.length === 0, 'expected no overlaps, got: ' + ov.join(', '));
        assert(A.x < X.x && X.x < C.x, 'chain order broken: A=' + A.x + ' X=' + X.x + ' C=' + C.x);
    });

    it('multi-node insertion (A -> X1 -> X2 -> C) clears overlap', function() {
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 150, y: 100, wires: [['X1']] };
        let X1 = { id: 'X1', type: 'function', name: 'first inserted', z: 'ws', wires: [['X2']] };
        let X2 = { id: 'X2', type: 'function', name: 'second inserted node', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 320, y: 100, wires: [[]] };
        let nodes = [A, X1, X2, C];
        Layout.placeAddedNodesNearNeighbors(nodes, { A: true, C: true },
            { A: { x: 150, y: 100 }, C: { x: 320, y: 100 } }, TIGHT);

        let ov = findOverlaps(nodes, TIGHT);
        assert(ov.length === 0, 'expected no overlaps, got: ' + ov.join(', '));
        assert(A.x < X1.x && X1.x < X2.x && X2.x < C.x,
            'chain order broken: A=' + A.x + ' X1=' + X1.x + ' X2=' + X2.x + ' C=' + C.x);
    });

    it('connected insertion always reflows, even with plenty of room', function() {
        // The contract is "fire on insertion", not "fire on residual
        // overlap": with X wired between A and C, the component reflows to a
        // uniform cadence, so C moves in rather than keeping its wide gap.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'X', z: 'ws', wires: [['C']] };
        let C = { id: 'C', type: 'function', name: 'C', z: 'ws', x: 700, y: 100, wires: [[]] };
        let nodes = [A, X, C];
        Layout.placeAddedNodesNearNeighbors(nodes, { A: true, C: true },
            { A: { x: 100, y: 100 }, C: { x: 700, y: 100 } }, TIGHT);

        assert(findOverlaps(nodes, TIGHT).length === 0, 'unexpected overlaps');
        assert(C.x < 700, 'reflow should have tightened C: ' + C.x + ' (expected < 700)');
        assert(A.x < X.x && X.x < C.x, 'chain order broken: A=' + A.x + ' X=' + X.x + ' C=' + C.x);
    });

    it('append-to-end is treated as a connected insertion too', function() {
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['B']] };
        let B = { id: 'B', type: 'function', name: 'B', z: 'ws', x: 300, y: 100, wires: [['X']] };
        let X = { id: 'X', type: 'function', name: 'appended', z: 'ws', wires: [[]] };
        let nodes = [A, B, X];
        Layout.placeAddedNodesNearNeighbors(nodes, { A: true, B: true },
            { A: { x: 100, y: 100 }, B: { x: 300, y: 100 } }, TIGHT);

        assert(findOverlaps(nodes, TIGHT).length === 0, 'unexpected overlaps');
        assert(A.x < B.x && B.x < X.x,
            'chain order broken: A=' + A.x + ' B=' + B.x + ' X=' + X.x);
    });

    it('orphan-band new node (no positioned neighbour) does not trigger reflow', function() {
        // O has no wires to A/B, so it lands in the orphan band and the
        // untouched component keeps its user-chosen positions exactly.
        let A = { id: 'A', type: 'function', name: 'A', z: 'ws', x: 100, y: 100, wires: [['B']] };
        let B = { id: 'B', type: 'function', name: 'B', z: 'ws', x: 500, y: 100, wires: [[]] };
        let O = { id: 'O', type: 'function', name: 'orphan', z: 'ws', wires: [[]] };
        let nodes = [A, B, O];
        Layout.placeAddedNodesNearNeighbors(nodes, { A: true, B: true },
            { A: { x: 100, y: 100 }, B: { x: 500, y: 100 } }, TIGHT);

        assert(A.x === 100 && A.y === 100, 'A moved unexpectedly: ' + A.x + ',' + A.y);
        assert(B.x === 500 && B.y === 100, 'B moved unexpectedly: ' + B.x + ',' + B.y);
        assert(typeof O.x === 'number' && typeof O.y === 'number', 'O should be placed somewhere');
    });
});

describe('An untouched flow stays rigid during an incremental edit', function() {
    const isCanvasNode = (n) => n && n.type !== 'tab' && String(n.type).indexOf('subflow:') !== 0;

    // Run one incremental layout; `newIds` marks the added node(s). Returns
    // the per-node delta (final − base) for nodes whose id starts with
    // `prefix`.
    function deltasFor(nodes, newIds, prefix) {
        const existingIdMap = {}, basePositions = {};
        nodes.forEach((n) => {
            if (!newIds[n.id]) { existingIdMap[n.id] = true; basePositions[n.id] = { x: n.x, y: n.y }; }
        });
        const watched = nodes.filter((n) => n.id.startsWith(prefix));
        const before = {};
        watched.forEach((n) => { before[n.id] = { x: n.x, y: n.y }; });
        Layout.placeAddedNodesNearNeighbors(nodes, existingIdMap, basePositions, {
            startX: 100, startY: 100, isCanvasNode,
        });
        return watched.map((n) => ({ id: n.id, dx: n.x - before[n.id].x, dy: n.y - before[n.id].y }));
    }
    function isUniform(deltas) {
        return deltas.length > 0 && deltas.every((d) => d.dx === deltas[0].dx && d.dy === deltas[0].dy);
    }

    // The upper flow branches (grows downward) into the flow below it.
    const d1 = deltasFor([
        { id: 'u1', type: 'inject',   z: 'z', name: 'U1', x: 100, y: 100, wires: [['u2', 'n']] },
        { id: 'u2', type: 'function', z: 'z', name: 'U2', x: 260, y: 100, wires: [[]] },
        { id: 'n',  type: 'debug',    z: 'z', name: 'N',                  wires: [[]] }, // NEW
        { id: 'l1', type: 'inject',   z: 'z', name: 'L1', x: 100, y: 180, wires: [['l2']] },
        { id: 'l2', type: 'function', z: 'z', name: 'L2', x: 260, y: 180, wires: [['l3']] },
        { id: 'l3', type: 'debug',    z: 'z', name: 'L3', x: 420, y: 180, wires: [[]] },
    ], { n: true }, 'l');
    ok(isUniform(d1), 'lower flow moved as a whole (uniform dx/dy)');
    ok(d1.every((x) => x.dx === 0), 'lower flow did not shift horizontally');
    ok(d1[0].dy >= 0, 'lower flow only moved down (or stayed)');

    // A TALL untouched flow whose top sits ABOVE the edited node: the
    // cross-component push skips it, so settleCollisions must move it rigidly.
    const tall = [
        { id: 'm1', type: 'function', z: 'z', name: 'M1', x: 100, y: 150, wires: [['n']] },
        { id: 'n',  type: 'debug',    z: 'z', name: 'N',                  wires: [[]] }, // NEW
        { id: 'o1', type: 'inject',   z: 'z', name: 'O1', x: 100, y: 100, wires: [['o2']] },
        { id: 'o2', type: 'function', z: 'z', name: 'O2', x: 100, y: 160, wires: [[]] },
    ];
    const gapBefore = 160 - 100;
    const d2 = deltasFor(tall, { n: true }, 'o');
    ok(isUniform(d2), 'tall untouched flow moved as a whole (uniform dx/dy)');
    const o1 = tall.find((x) => x.id === 'o1');
    const o2 = tall.find((x) => x.id === 'o2');
    ok((o2.y - o1.y) === gapBefore, 'its internal vertical gap is preserved (not sheared)');
});

// A box is drawn outside its members, so spacing the members is not spacing
// the boxes: `componentGap` (80) minus two paddings (25 each) left 30px
// between two grouped sequences, and a caption that joined a group ate the
// rest. `separateGroups` is the engine's guarantee that a box clears what is
// outside it; the end-to-end shape an LLM proposes is group_schema's.
describe('Group boxes clear each other by groupGap', function() {
    const PAD = 25;

    // Two stacked sequences, each boxed, with only `tight` px between boxes.
    function stacked(tight) {
        const topBottom = 160 + NODE_HEIGHT / 2 + PAD;    // SeqA's box bottom
        const bTop = topBottom + tight;
        const bY = bTop + PAD + NODE_HEIGHT / 2;
        return [
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 110, y: 160, g: 'gA', wires: [['a2']] },
            { id: 'a2', type: 'debug',  z: 'z', name: 'da', x: 310, y: 160, g: 'gA', wires: [[]] },
            { id: 'gA', type: 'group',  z: 'z', name: 'SeqA', nodes: ['a1', 'a2'],
              x: 35, y: 160 - NODE_HEIGHT / 2 - PAD, w: 340, h: NODE_HEIGHT + PAD * 2 },
            { id: 'b1', type: 'inject', z: 'z', name: 'b', x: 110, y: bY, g: 'gB', wires: [['b2']] },
            { id: 'b2', type: 'debug',  z: 'z', name: 'db', x: 310, y: bY, g: 'gB', wires: [[]] },
            { id: 'gB', type: 'group',  z: 'z', name: 'SeqB', nodes: ['b1', 'b2'],
              x: 35, y: bTop, w: 340, h: NODE_HEIGHT + PAD * 2 }
        ];
    }
    const box = (flow, id) => flow.find((n) => n.id === id);
    const gapBetween = (flow) => box(flow, 'gB').y - (box(flow, 'gA').y + box(flow, 'gA').h);

    const GAP = Layout.LAYOUT_DEFAULTS.groupGap;

    it('boxed sequences are componentGap apart member to member (' + GAP + 'px between boxes)', function() {
        const D = Layout.LAYOUT_DEFAULTS;
        assert(GAP + 2 * D.groupPadding === D.componentGap, 'groupGap is ' + GAP);
    });

    it('boxes that would overlap are pushed apart', function() {
        const flow = stacked(-10);
        Layout.separateGroups(flow, { isCanvasNode: (n) => !!n && n.type !== 'tab' });
        assert(gapBetween(flow) === GAP, 'gap is ' + gapBetween(flow));
    });

    it('the pushed sequence moves as a whole, box included', function() {
        const flow = stacked(-10);
        const before = { b1: box(flow, 'b1').y, b2: box(flow, 'b2').y, gB: box(flow, 'gB').y };
        Layout.separateGroups(flow, { isCanvasNode: (n) => !!n && n.type !== 'tab' });
        const dy = box(flow, 'b1').y - before.b1;
        assert(dy > 0, 'it moved down');
        assert(box(flow, 'b2').y - before.b2 === dy, 'its second node moved by the same dy');
        assert(box(flow, 'gB').y - before.gB === dy, 'its box moved by the same dy');
    });

    it('a sequence that already clears the box above is left where it is', function() {
        const flow = stacked(GAP + 60);
        const before = box(flow, 'b1').y;
        Layout.separateGroups(flow, { isCanvasNode: (n) => !!n && n.type !== 'tab' });
        assert(box(flow, 'b1').y === before, 'moved to ' + box(flow, 'b1').y);
    });

    it('running it again does not drift the canvas down', function() {
        const flow = stacked(-10);
        const opts = { isCanvasNode: (n) => !!n && n.type !== 'tab' };
        Layout.separateGroups(flow, opts);
        const settled = box(flow, 'b1').y;
        Layout.separateGroups(flow, opts);
        Layout.separateGroups(flow, opts);
        assert(box(flow, 'b1').y === settled, 'settled at ' + settled + ', then ' + box(flow, 'b1').y);
    });

    it('a caption outside the group travels with the sequence it heads', function() {
        const flow = stacked(-10);
        flow.push({ id: 'c1', type: 'comment', z: 'z', name: 'What B does',
            x: 110, y: box(flow, 'b1').y - 40 });
        const before = box(flow, 'c1').y;
        Layout.separateGroups(flow, { isCanvasNode: (n) => !!n && n.type !== 'tab' });
        const dy = box(flow, 'b1').y - (before + 40);
        assert(box(flow, 'c1').y - before === dy, 'caption dy ' + (box(flow, 'c1').y - before) +
            ' vs node dy ' + dy);
    });
});

// `x` is a CENTRE, so a rename moves both edges — and this engine aligns LEFT
// edges. A renamed node slid out of its column, took the caption above it with
// it, and a long enough name pushed the left edge off the canvas (left = -75
// was reachable with a group's box following it out there).
describe('A width change keeps the left edge', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    it('a node that grew keeps its left edge, not its centre', function() {
        const n = { id: 'n1', type: 'inject', name: 'tick', x: 110, y: 100 };
        const before = { n1: Layout.estimateNodeWidth(n, OPTS) };
        const left = n.x - before.n1 / 2;
        n.name = 'a considerably longer name';
        Layout.keepLeftEdges([n], before, OPTS);
        const now = Layout.estimateNodeWidth(n, OPTS);
        assert(n.x - now / 2 === left, 'left edge ' + (n.x - now / 2) + ', was ' + left);
    });

    it('and says which nodes it moved, so their chain can be re-spaced', function() {
        const a = { id: 'a', type: 'inject', name: 'tick', x: 110, y: 100 };
        const b = { id: 'b', type: 'debug', name: 'out', x: 310, y: 100 };
        const widths = {
            a: Layout.estimateNodeWidth(a, OPTS),
            b: Layout.estimateNodeWidth(b, OPTS),
        };
        a.name = 'a considerably longer name';
        const moved = Layout.keepLeftEdges([a, b], widths, OPTS);
        assert(moved.length === 1 && moved[0] === 'a', 'reported ' + JSON.stringify(moved));
    });

    it('a node whose width did not change is not moved at all', function() {
        const n = { id: 'n1', type: 'inject', name: 'tick', x: 110, y: 100 };
        const widths = { n1: Layout.estimateNodeWidth(n, OPTS) };
        Layout.keepLeftEdges([n], widths, OPTS);
        assert(n.x === 110, 'x is ' + n.x);
    });

    it('a caption takes its target\'s left edge, not the offset it had', function() {
        const target = { id: 't', type: 'inject', name: 'tick', x: 110, y: 100 };
        const caption = { id: 'c', type: 'comment', name: 'What this does', x: 130, y: 60 };
        const anchors = Layout.captureCommentAnchors([caption, target], OPTS);
        assert(anchors.c && anchors.c.targetId === 't', 'the caption is anchored to the node');
        target.name = 'a considerably longer name';
        Layout.applyCommentAnchors([caption, target], anchors, OPTS);
        const tLeft = target.x - Layout.estimateNodeWidth(target, OPTS) / 2;
        const cLeft = caption.x - Layout.estimateNodeWidth(caption, OPTS) / 2;
        assert(cLeft === tLeft, 'caption left ' + cLeft + ' vs node left ' + tLeft);
        assert(caption.y === 60, 'and it kept its row (' + caption.y + ')');
    });
});

// The order the passes run in is the contract: members are placed, then each
// box is fitted to the members it now holds, and only then are the boxes
// aligned and spaced against each other. A box left at its old size is a box
// the alignment would line up INSTEAD of the sequence inside it.
describe('Every box is fitted to its members', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };
    const PAD = 25;

    function oversized() {
        return [
            { id: 'n1', type: 'inject', z: 'z', name: 'a', x: 110, y: 160, g: 'g1', wires: [['n2']] },
            { id: 'n2', type: 'debug', z: 'z', name: 'b', x: 310, y: 160, g: 'g1', wires: [[]] },
            // Wider and taller than its members need, and further left.
            { id: 'g1', type: 'group', z: 'z', name: 'Box', nodes: ['n1', 'n2'],
              x: 0, y: 100, w: 800, h: 200 },
        ];
    }
    const box = (flow) => flow.find((n) => n.id === 'g1');

    it('every box is fitted to what it holds, whoever drew it', function() {
        const flow = oversized();
        Layout.fitGroups(flow, OPTS);
        const left = 110 - Layout.estimateNodeWidth(flow[0], OPTS) / 2;
        assert(box(flow).x === left - PAD, 'left edge ' + box(flow).x + ', member at ' + left);
        assert(box(flow).w < 800, 'and it is no longer 800 wide (' + box(flow).w + ')');
    });
});

// A caption is found by what it touches, and the tolerance is tight so a
// standalone annotation is left where the user put it. That tightness orphaned
// captions inside a box the moment one drifted out of the column: the box says
// the two belong together, and the box is the stronger statement.
describe('A caption in a box belongs to the box', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    function caption(extra) {
        return Object.assign({ id: 'c1', type: 'comment', z: 'z', name: 'What this does',
            x: 260, y: 160 }, extra || {});
    }
    function node(extra) {
        return Object.assign({ id: 'n1', type: 'inject', z: 'z', name: 'tick',
            x: 150, y: 200, wires: [[]] }, extra || {});
    }

    it('is anchored to the member below it even when the column drifted', function() {
        const flow = [caption({ g: 'grp' }), node({ g: 'grp' })];
        const anchors = Layout.captureCommentAnchors(flow, OPTS);
        assert(anchors.c1 && anchors.c1.targetId === 'n1',
            'anchored to ' + JSON.stringify(anchors.c1 || null));
    });

    it('and takes that member\'s column when the anchors are applied', function() {
        const flow = [caption({ g: 'grp' }), node({ g: 'grp' })];
        const anchors = Layout.captureCommentAnchors(flow, OPTS);
        flow[1].x = 600;                       // the node moves
        Layout.applyCommentAnchors(flow, anchors, OPTS);
        const left = (n) => n.x - Layout.estimateNodeWidth(n, OPTS) / 2;
        assert(left(flow[0]) === left(flow[1]),
            'caption left ' + left(flow[0]) + ' vs node left ' + left(flow[1]));
    });

    it('a caption in no box keeps the tight rule, so annotations stay put', function() {
        const flow = [caption(), node()];      // same geometry, no group
        const anchors = Layout.captureCommentAnchors(flow, OPTS);
        assert(!anchors.c1, 'anchored anyway: ' + JSON.stringify(anchors.c1 || null));
    });

    // The caption at the bottom of one sequence sits within touching distance
    // of the top of the next. Anchoring across that boundary tied the two
    // groups into ONE block — and a block cannot be pushed apart from itself,
    // so the boxes overlapped by the height of the caption that bridged them.
    it('never anchors to a node in a different box', function() {
        const flow = [
            { id: 'c1', type: 'comment', z: 'z', name: 'Heading', x: 260, y: 960, g: 'gA' },
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 250, y: 900, g: 'gA', wires: [[]] },
            { id: 'b1', type: 'inject', z: 'z', name: 'b', x: 250, y: 1000, g: 'gB', wires: [[]] },
        ];
        const anchors = Layout.captureCommentAnchors(flow, OPTS);
        assert(!anchors.c1 || anchors.c1.targetId !== 'b1',
            'anchored across the boundary: ' + JSON.stringify(anchors.c1 || null));
    });

    it('so two boxes a caption sits between are still pushed apart', function() {
        const flow = [
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 250, y: 900, g: 'gA', wires: [[]] },
            { id: 'c1', type: 'comment', z: 'z', name: 'Heading', x: 260, y: 960, g: 'gA' },
            { id: 'gA', type: 'group', z: 'z', name: 'A', nodes: ['a1', 'c1'],
              x: 175, y: 860, w: 300, h: 140 },
            { id: 'b1', type: 'inject', z: 'z', name: 'b', x: 250, y: 1000, g: 'gB', wires: [[]] },
            { id: 'gB', type: 'group', z: 'z', name: 'B', nodes: ['b1'],
              x: 175, y: 960, w: 300, h: 80 },
        ];
        Layout.separateGroups(flow, OPTS);
        const a = flow.find((n) => n.id === 'gA'), b = flow.find((n) => n.id === 'gB');
        assert(b.y - (a.y + a.h) >= Layout.LAYOUT_DEFAULTS.groupGap,
            'gap is ' + (b.y - (a.y + a.h)));
    });

    // A layout pass can move the members and leave the heading behind — below
    // the row it names, where nothing touches it and no anchor would be found
    // again. It is the box's heading, so it goes back above the box's first
    // member.
    it('a caption left below its own sequence is re-stacked above it', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'tick', x: 250, y: 790, g: 'grp', wires: [[]] },
            { id: 'n2', type: 'debug', z: 'z', name: 'out', x: 450, y: 930, g: 'grp', wires: [[]] },
            { id: 'c1', type: 'comment', z: 'z', name: 'Heading', x: 300, y: 970, g: 'grp' },
        ];
        const anchors = Layout.captureCommentAnchors(flow, OPTS);
        assert(anchors.c1 && anchors.c1.targetId === 'n1',
            'anchored to ' + JSON.stringify(anchors.c1 || null));
        Layout.applyCommentAnchors(flow, anchors, OPTS);
        const c = flow[2], n = flow[0];
        assert(c.y < n.y, 'caption at ' + c.y + ', its node at ' + n.y);
        const left = (x) => x.x - Layout.estimateNodeWidth(x, OPTS) / 2;
        assert(left(c) === left(n), 'caption left ' + left(c) + ' vs node left ' + left(n));
    });

    it('the box is fitted around the caption too', function() {
        const flow = [
            caption({ g: 'grp' }), node({ g: 'grp' }),
            { id: 'grp', type: 'group', z: 'z', name: 'Pair', nodes: ['c1', 'n1'] },
        ];
        Layout.fitGroups(flow, OPTS);
        const box = flow[2];
        assert(box.y <= 160 - NODE_HEIGHT / 2 - 25 + 0.01,
            'box top ' + box.y + ' does not clear the caption');
        assert(box.y + box.h >= 200 + NODE_HEIGHT / 2 + 25 - 0.01,
            'box bottom ' + (box.y + box.h) + ' does not clear the node');
    });
});

// Sequences stack in a column, so their boxes line up as one.
describe('Group boxes share a left edge', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    function twoSequencesAndATail() {
        return [
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 110, y: 160, g: 'gA', wires: [['a2']] },
            { id: 'a2', type: 'debug', z: 'z', name: 'da', x: 310, y: 160, g: 'gA', wires: [[]] },
            { id: 'gA', type: 'group', z: 'z', name: 'SeqA', nodes: ['a1', 'a2'],
              x: 35, y: 130, w: 340, h: 80 },
            { id: 'b1', type: 'inject', z: 'z', name: 'b', x: 310, y: 300, g: 'gB', wires: [['b2']] },
            { id: 'b2', type: 'debug', z: 'z', name: 'db', x: 510, y: 300, g: 'gB', wires: [[]] },
            { id: 'gB', type: 'group', z: 'z', name: 'SeqB', nodes: ['b1', 'b2'],
              x: 235, y: 270, w: 340, h: 80 },
            // A box around the TAIL of a chain: its block starts at c1, which
            // is outside the box.
            { id: 'c1', type: 'inject', z: 'z', name: 'c', x: 110, y: 460, wires: [['c2']] },
            { id: 'c2', type: 'debug', z: 'z', name: 'dc', x: 400, y: 460, g: 'gC', wires: [[]] },
            { id: 'gC', type: 'group', z: 'z', name: 'Tail', nodes: ['c2'],
              x: 325, y: 430, w: 150, h: 80 },
        ];
    }
    const byId = (flow, id) => flow.find((n) => n.id === id);

    it('a sequence sitting further right is pulled into line', function() {
        const flow = twoSequencesAndATail();
        Layout.separateGroups(flow, OPTS);
        assert(byId(flow, 'gB').x === byId(flow, 'gA').x,
            'SeqB at ' + byId(flow, 'gB').x + ', SeqA at ' + byId(flow, 'gA').x);
    });

    it('with its members, which keep their spacing', function() {
        const flow = twoSequencesAndATail();
        Layout.separateGroups(flow, OPTS);
        assert(byId(flow, 'b1').x === 110, 'b1 at ' + byId(flow, 'b1').x);
        assert(byId(flow, 'b2').x - byId(flow, 'b1').x === 200, 'the gap between them is unchanged');
    });

    it('a box around the tail of a chain is left where it is', function() {
        const flow = twoSequencesAndATail();
        Layout.separateGroups(flow, OPTS);
        assert(byId(flow, 'gC').x === 325, 'Tail at ' + byId(flow, 'gC').x);
        assert(byId(flow, 'c1').x === 110, 'and the node feeding it did not move');
    });

    // Two sequences wired to each other are ONE block, which is why boxes are
    // aligned per box: aligning blocks left this pair stepped, and a
    // reposition produces it constantly.
    it('boxes wired to each other still line up', function() {
        const flow = [
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 110, y: 160, g: 'gA', wires: [['a2']] },
            { id: 'a2', type: 'debug', z: 'z', name: 'da', x: 310, y: 160, g: 'gA', wires: [['b1']] },
            { id: 'gA', type: 'group', z: 'z', name: 'SeqA', nodes: ['a1', 'a2'],
              x: 35, y: 130, w: 340, h: 80 },
            { id: 'b1', type: 'function', z: 'z', name: 'b', x: 360, y: 300, g: 'gB', wires: [['b2']] },
            { id: 'b2', type: 'debug', z: 'z', name: 'db', x: 560, y: 300, g: 'gB', wires: [[]] },
            { id: 'gB', type: 'group', z: 'z', name: 'SeqB', nodes: ['b1', 'b2'],
              x: 285, y: 270, w: 340, h: 80 },
        ];
        Layout.separateGroups(flow, OPTS);
        assert(byId(flow, 'gB').x === byId(flow, 'gA').x,
            'SeqB at ' + byId(flow, 'gB').x + ', SeqA at ' + byId(flow, 'gA').x);
        assert(byId(flow, 'b1').x === 110, 'its members came along (b1 at ' + byId(flow, 'b1').x + ')');
    });

    // Alignment is for sequences stacked one above another. Boxes whose rows
    // overlap are side by side — or interlocked, because a node in one is
    // wired to a node in the other — and pulling those into one column drops
    // one sequence on top of the other.
    it('boxes whose rows overlap are left in their own columns', function() {
        const flow = [
            { id: 'a1', type: 'inject', z: 'z', name: 'a', x: 250, y: 215, g: 'gA', wires: [[]] },
            { id: 'gA', type: 'group', z: 'z', name: 'A', nodes: ['a1'],
              x: 175, y: 175, w: 260, h: 80 },
            { id: 'b1', type: 'inject', z: 'z', name: 'b', x: 950, y: 215, g: 'gB', wires: [[]] },
            { id: 'gB', type: 'group', z: 'z', name: 'B', nodes: ['b1'],
              x: 875, y: 175, w: 260, h: 80 },
        ];
        Layout.separateGroups(flow, OPTS);
        const a = flow.find((n) => n.id === 'gA'), b = flow.find((n) => n.id === 'gB');
        assert(b.x === 875, 'the box beside it moved to ' + b.x);
        assert(a.y === b.y, 'and neither was stacked below the other (' + a.y + ' / ' + b.y + ')');
    });

    // The column is set by the leftmost box; the canvas margin is restored
    // afterwards, for everything at once.
    it('alignment never leaves the canvas off its left edge', function() {
        const flow = twoSequencesAndATail();
        const gA = byId(flow, 'gA');
        const shift = -100;
        [gA, byId(flow, 'a1'), byId(flow, 'a2')].forEach((n) => { n.x += shift; });
        Layout.separateGroups(flow, OPTS);
        Layout.ensureCanvasMargins(flow, OPTS);
        const margin = Layout.LAYOUT_DEFAULTS.leftMargin;
        assert(byId(flow, 'gA').x >= margin && byId(flow, 'gB').x >= margin,
            'boxes at ' + byId(flow, 'gA').x + ' / ' + byId(flow, 'gB').x);
        assert(byId(flow, 'gA').x === byId(flow, 'gB').x, 'and still aligned with each other');
    });
});

// Two boxes wired to each other are ONE block, so the block pass cannot
// separate them — and a user looking at two borders crossing does not care
// why. Boxes are stacked as boxes, each moving with what it holds.
describe('Boxes never overlap, whatever ties them together', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    it('a box interlocked with another is still pushed clear', function() {
        // `a` is in Both, wired to `da` in A: one block, two boxes, rows
        // that cross.
        const flow = [
            { id: 'a', type: 'inject', z: 'z', name: 'a', x: 250, y: 215, g: 'both', wires: [['da']] },
            { id: 'b', type: 'inject', z: 'z', name: 'b', x: 250, y: 365, g: 'both', wires: [[]] },
            { id: 'both', type: 'group', z: 'z', name: 'Both', nodes: ['a', 'b'],
              x: 175, y: 175, w: 150, h: 230 },
            { id: 'da', type: 'debug', z: 'z', name: 'da', x: 450, y: 215, g: 'gA', wires: [[]] },
            { id: 'gA', type: 'group', z: 'z', name: 'A', nodes: ['da'],
              x: 375, y: 175, w: 160, h: 80 },
        ];
        Layout.separateGroups(flow, OPTS);
        const boxes = flow.filter((n) => n.type === 'group');
        const [top, bottom] = boxes.sort((x, y) => x.y - y.y);
        const overlap = top.x < bottom.x + bottom.w && bottom.x < top.x + top.w &&
            top.y < bottom.y + bottom.h && bottom.y < top.y + top.h;
        assert(!overlap, 'boxes still cross: ' +
            boxes.map((g) => g.name + ' ' + g.y + '..' + (g.y + g.h)).join(' / '));
    });

    it('and takes its members with it', function() {
        const flow = [
            { id: 'a', type: 'inject', z: 'z', name: 'a', x: 250, y: 215, g: 'both', wires: [['da']] },
            { id: 'b', type: 'inject', z: 'z', name: 'b', x: 250, y: 365, g: 'both', wires: [[]] },
            { id: 'both', type: 'group', z: 'z', name: 'Both', nodes: ['a', 'b'],
              x: 175, y: 175, w: 150, h: 230 },
            { id: 'da', type: 'debug', z: 'z', name: 'da', x: 450, y: 215, g: 'gA', wires: [[]] },
            { id: 'gA', type: 'group', z: 'z', name: 'A', nodes: ['da'],
              x: 375, y: 175, w: 160, h: 80 },
        ];
        const gapBefore = flow[1].y - flow[0].y;
        Layout.separateGroups(flow, OPTS);
        const box = flow.find((n) => n.id === 'both');
        const a = flow.find((n) => n.id === 'a'), b = flow.find((n) => n.id === 'b');
        assert(b.y - a.y === gapBefore, 'its members were sheared (' + (b.y - a.y) + ')');
        assert(box.y <= a.y - 15 && box.y + box.h >= b.y + 15, 'the box no longer holds them');
    });
});

// A caption is a row tall and so is the node it heads, so an offset of less
// than a row IS an overlap — whatever the caption's history, that is not a
// placement to preserve.
describe('A caption never lands on the node it heads', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    it('an offset smaller than a row is clamped to one row', function() {
        const target = { id: 't', type: 'inject', z: 'z', name: 'tick', x: 250, y: 300 };
        const caption = { id: 'c', type: 'comment', z: 'z', name: 'Heading', x: 250, y: 294 };
        Layout.applyCommentAnchors([caption, target],
            { c: { targetId: 't', dx: 0, dy: -6 } }, OPTS);
        assert(target.y - caption.y >= 40, 'caption at ' + caption.y + ', node at ' + target.y);
    });

    it('a deliberate offset further up is left as it is', function() {
        const target = { id: 't', type: 'inject', z: 'z', name: 'tick', x: 250, y: 300 };
        const caption = { id: 'c', type: 'comment', z: 'z', name: 'Heading', x: 250, y: 180 };
        Layout.applyCommentAnchors([caption, target],
            { c: { targetId: 't', dx: 0, dy: -120 } }, OPTS);
        assert(caption.y === 180, 'moved to ' + caption.y);
    });
});

// An annotation belongs to nobody, so the layout leaves it alone — right up
// until a pass lays a sequence over the top of it. Then it is the one to move.
describe('An annotation buried by the layout is moved clear', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    it('a note under a node is moved off it, and the node stays', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'tick', x: 250, y: 300, wires: [[]] },
            { id: 'c1', type: 'comment', z: 'z', name: 'A note', x: 250, y: 305 },
        ];
        Layout.settleCollisions(flow, OPTS);
        assert(flow[0].y === 300, 'node moved to ' + flow[0].y);
        assert(Math.abs(flow[1].y - flow[0].y) >= 30, 'note at ' + flow[1].y);
    });

    it('a note that is in nobody\'s way stays where it is', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'tick', x: 250, y: 300, wires: [[]] },
            { id: 'c1', type: 'comment', z: 'z', name: 'A note', x: 900, y: 700 },
        ];
        Layout.settleCollisions(flow, OPTS);
        assert(flow[1].y === 700 && flow[1].x === 900, 'moved to ' + flow[1].x + ',' + flow[1].y);
    });

    it('a caption over the node it heads is left to the comment pass', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'tick', x: 250, y: 300, wires: [[]] },
            { id: 'c1', type: 'comment', z: 'z', name: 'A note', x: 250, y: 290 },
        ];
        Layout.settleCollisions(flow, OPTS);
        assert(flow[1].y === 290 && flow[0].y === 300, 'moved to ' + flow[1].y + ' / ' + flow[0].y);
    });
});

// ensureCanvasMargins guards both edges, boxes included: a box is drawn one
// padding further out than the members it holds.
describe('Nothing is left hanging off the canvas', function() {
    const OPTS = { isCanvasNode: (n) => !!n && n.type !== 'tab' };

    it('a flow off the left edge slides back, geometry intact', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'a', x: -40, y: 100, wires: [['n2']] },
            { id: 'n2', type: 'debug', z: 'z', name: 'b', x: 160, y: 100, wires: [[]] },
        ];
        Layout.ensureCanvasMargins(flow, OPTS);
        const left = flow[0].x - Layout.estimateNodeWidth(flow[0], OPTS) / 2;
        const margin = Layout.LAYOUT_DEFAULTS.leftMargin;
        assert(left >= margin && left < margin + 20, 'leftmost edge at ' + left);
        assert((flow[0].x + 40) % 20 === 0, 'moved in whole grid squares (' + flow[0].x + ')');
        assert(flow[1].x - flow[0].x === 200, 'the gap between them is unchanged');
    });

    it('the gap above a boxed flow is the gap beside it', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'a', g: 'g1', wires: [['n2']] },
            { id: 'n2', type: 'debug', z: 'z', name: 'b', g: 'g1', wires: [[]] },
            { id: 'g1', type: 'group', z: 'z', name: 'Box', nodes: ['n1', 'n2'] },
        ];
        const opts = Object.assign({ startX: 200, startY: 200 }, OPTS);
        Layout.reflowCanvasNodes(flow, Object.assign({}, opts, {
            isCanvasNode: (n) => !!n && n.type !== 'tab' && n.type !== 'group',
        }));
        Layout.fitGroups(flow, opts);
        Layout.ensureCanvasMargins(flow, opts);
        // Equal up to the 5px a 30px-tall node centred on the grid leaves.
        const box = flow.find((n) => n.id === 'g1');
        assert(Math.abs(box.x - box.y) <= 5, 'box at (' + box.x + ',' + box.y + ')');
    });

    it('a box counts as the leftmost thing, not its members', function() {
        const flow = [
            { id: 'n1', type: 'inject', z: 'z', name: 'a', x: 110, y: 100, g: 'g1', wires: [[]] },
            { id: 'g1', type: 'group', z: 'z', name: 'Box', nodes: ['n1'],
              x: -25, y: 70, w: 150, h: 80 },
        ];
        Layout.ensureCanvasMargins(flow, OPTS);
        const margin = Layout.LAYOUT_DEFAULTS.leftMargin;
        assert(flow[1].x >= margin && flow[1].x < margin + 20, 'box at ' + flow[1].x);
        assert(flow[0].x - flow[1].x === 135, 'and its member moved with it (' + flow[0].x + ')');
    });

    it('a canvas that already clears the edge is not moved', function() {
        const flow = [{ id: 'n1', type: 'inject', z: 'z', name: 'a', x: 110, y: 100, wires: [[]] }];
        Layout.ensureCanvasMargins(flow, OPTS);
        assert(flow[0].x === 110, 'x is ' + flow[0].x);
    });
});

describe('settleCollisions: nothing this edit placed sits on anything', function() {
    const box = (id, nodes, x, y, w, h, extra) => Object.assign(
        { id, type: 'group', z: 'z', name: id, nodes, x, y, w, h }, extra || {});
    const node = (id, x, y, extra) => Object.assign(
        { id, type: 'change', z: 'z', name: id, x, y, wires: [[]] }, extra || {});
    const rectOf = (n) => n.type === 'group'
        ? { t: n.y, b: n.y + n.h, l: n.x, r: n.x + n.w }
        : { t: n.y - 15, b: n.y + 15, l: n.x - 50, r: n.x + 50 };
    const hits = (a, b) => { const p = rectOf(a), q = rectOf(b);
        return p.l < q.r && q.l < p.r && p.t < q.b && q.t < p.b; };

    it('in one chain, the lower of two overlapping nodes steps off alone', function() {
        const flow = [node('old', 300, 100, { wires: [['new']] }), node('new', 300, 100)];
        Layout.settleCollisions(flow, {});
        assert(flow[0].y === 100, 'existing node kept its row (' + flow[0].y + ')');
        assert(!hits(flow[0], flow[1]), 'and the placed one is clear of it (' + flow[1].y + ')');
    });

    it('two boxes that overlap end up groupGap apart, the lower one moved with its members', function() {
        const flow = [
            box('A', ['a'], 0, 0, 200, 80), node('a', 100, 40, { g: 'A' }),
            box('B', ['b'], 0, 60, 200, 80), node('b', 100, 100, { g: 'B' }),
        ];
        Layout.settleCollisions(flow, {});
        const A = flow[0], B = flow[2];
        assert(A.y === 0, 'the upper box stayed (' + A.y + ')');
        const GAP = Layout.LAYOUT_DEFAULTS.groupGap;
        assert(B.y >= A.y + A.h + GAP, 'the lower one is below it by the gap (' + B.y + ')');
        assert(flow[3].y === B.y + Layout.LAYOUT_DEFAULTS.groupPadding + 15, 'and took its member along (' + flow[3].y + ')');
    });

    it('a push that lands on a third box pushes that one too', function() {
        const flow = [
            box('A', ['a'], 0, 0, 200, 100), node('a', 100, 50, { g: 'A' }),
            box('B', ['b'], 0, 90, 200, 80), node('b', 100, 130, { g: 'B' }),
            box('C', ['c'], 0, 190, 200, 80), node('c', 100, 230, { g: 'C' }),
        ];
        Layout.settleCollisions(flow, {});
        const [A, , B, , C] = flow;
        const GAP = Layout.LAYOUT_DEFAULTS.groupGap;
        assert(B.y >= A.y + A.h + GAP && C.y >= B.y + B.h + GAP,
            'every box clears the one above (' + [A.y, B.y, C.y].join(',') + ')');
    });

    it('a loose node inside a box it is not in is moved out, below it', function() {
        const flow = [box('A', ['a'], 0, 0, 300, 120), node('a', 100, 40, { g: 'A' }), node('x', 200, 80)];
        Layout.settleCollisions(flow, {});
        assert(rectOf(flow[2]).t >= flow[0].y + flow[0].h + 40, 'x is clear of the box (' + flow[2].y + ')');
        assert(flow[1].y === 40, 'and the member did not move');
    });

    it('a member pushed down grows its box, which then clears the next box', function() {
        const flow = [
            box('A', ['a1', 'a2'], 0, 0, 200, 80), node('a1', 100, 40, { g: 'A', wires: [['a2']] }),
            node('a2', 100, 40, { g: 'A' }),
            box('B', ['b'], 0, 120, 200, 80), node('b', 100, 160, { g: 'B' }),
        ];
        Layout.settleCollisions(flow, {});
        const [A, a1, a2, B] = flow;
        assert(!hits(a1, a2), 'the members no longer overlap');
        assert(A.y + A.h >= rectOf(a2).b, 'the box grew around the one that moved');
        assert(B.y >= A.y + A.h + Layout.LAYOUT_DEFAULTS.groupGap, 'and the box below was pushed clear (' + B.y + ')');
    });

    it('an overlap already on the canvas is resolved too', function() {
        const flow = [node('p', 300, 100), node('q', 300, 100), node('n', 800, 100)];
        Layout.settleCollisions(flow, {});
        assert(!hits(flow[0], flow[1]), 'p and q no longer overlap (' + flow[0].y + ' / ' + flow[1].y + ')');
        assert(flow[2].y === 100, 'and n, clear of both, did not move');
    });

    it('a caption travels with the node it heads, and is itself kept clear', function() {
        const flow = [
            node('a', 300, 100), node('b', 300, 150),
            { id: 'c', type: 'comment', z: 'z', name: 'about b', x: 300, y: 110 },
        ];
        Layout.settleCollisions(flow, {});
        const [a, b, c] = flow;
        assert(!hits(a, b) && !hits(a, c), 'nothing overlaps a (' + [a.y, b.y, c.y].join(',') + ')');
        assert(c.y < b.y, 'and the caption is still above b');
    });

    it('a node on a junction steps off it; the junction stays', function() {
        const flow = [
            { id: 'j', type: 'junction', z: 'z', x: 300, y: 100, wires: [['n']] },
            node('n', 300, 100),
        ];
        Layout.settleCollisions(flow, {});
        assert(flow[0].x === 300 && flow[0].y === 100, 'junction at ' + flow[0].x + ',' + flow[0].y);
        assert(flow[1].y - 15 >= 105, 'node clear below it (' + flow[1].y + ')');
    });

    it('a box pushed down takes the routing that serves it along', function() {
        const flow = [
            box('A', ['a1', 'a2'], 0, 0, 200, 80), node('a1', 100, 40, { g: 'A', wires: [['a2', 'j']] }),
            node('a2', 100, 40, { g: 'A', wires: [['lo']] }),
            box('B', ['b'], 0, 120, 200, 80), node('b', 100, 160, { g: 'B' }),
            { id: 'j', type: 'junction', z: 'z', x: 240, y: 100, wires: [['b']] },
            { id: 'li', type: 'link in', z: 'z', x: 300, y: 160, links: ['lo'], wires: [['b']] },
            { id: 'lo', type: 'link out', z: 'z', x: 300, y: 40, links: ['li'], wires: [] },
        ];
        Layout.settleCollisions(flow, {});
        const [, a1, a2, , b, j, li, lo] = flow;
        const dy = b.y - 160;
        assert(dy > 0, 'the box below was pushed (' + dy + ')');
        assert(j.x === 240 && j.y === 100 + dy, 'the junction feeding it moved with it (' + j.x + ',' + j.y + ')');
        assert(li.x === 300 && li.y === 160 + dy, 'and so did the link in (' + li.y + ')');
        assert(a1.y === 40 && lo.y === a2.y, 'a link out moves with the node feeding it (' + lo.y + ' / ' + a2.y + ')');
    });

    it('routing serving two things that moved apart stays where it was', function() {
        const flow = [
            node('p', 300, 100), node('q', 300, 100),
            { id: 'j', type: 'junction', z: 'z', x: 500, y: 100, wires: [['p', 'q']] },
        ];
        Layout.settleCollisions(flow, {});
        assert(flow[0].y !== flow[1].y, 'p and q were parted');
        assert(flow[2].x === 500 && flow[2].y === 100, 'the junction did not move (' + flow[2].y + ')');
    });

    it('a junction on a box edge is left alone, and so is the box', function() {
        const flow = [box('A', ['a'], 0, 0, 200, 80), node('a', 100, 40, { g: 'A' }),
            { id: 'j', type: 'junction', z: 'z', x: 200, y: 40, wires: [] }];
        Layout.settleCollisions(flow, {});
        assert(flow[0].y === 0 && flow[2].x === 200 && flow[2].y === 40, 'nothing moved');
    });

    it('members are compared with each other, not with their own box', function() {
        const flow = [box('A', ['a', 'b'], 0, 0, 400, 80), node('a', 100, 40, { g: 'A' }), node('b', 300, 40, { g: 'A' })];
        assert(Layout.settleCollisions(flow, {}).length === 0, 'a tidy box is left alone');
    });
});

// Long chains are not wrapped: a box already makes a sequence readable, and a
// wrap that moved one or two nodes to a row of their own read worse than none.
describe('A long chain stays on one row', function() {
    it('ten nodes in a chain share row 0, one column each', function() {
        const ids = Array.from({ length: 10 }, (_, i) => 'n' + i);
        const outgoing = {}, incoming = {};
        ids.forEach((id) => { outgoing[id] = []; incoming[id] = []; });
        ids.slice(1).forEach((id, i) => { outgoing[ids[i]].push(id); incoming[id].push(ids[i]); });
        const pos = Layout.layoutNodes(ids, outgoing, incoming);
        assert(ids.every((id, i) => pos[id].row === 0 && pos[id].col === i),
            'rows ' + ids.map((id) => pos[id].row).join(','));
    });
});

// Two inputs of different widths into one node: both wires are edgeGap long,
// the narrower input right-aligned onto what it feeds.
describe('Every wire is edgeGap long, even into a merge', function() {
    it('the narrower of two inputs sits edgeGap before the node it feeds', function() {
        const flow = [
            { id: 'w', type: 'inject', z: 'z', name: 'A much wider trigger name', x: 0, y: 0, wires: [['m']] },
            { id: 'n', type: 'http in', z: 'z', name: 'GET /', url: '/', x: 0, y: 0, wires: [['m']] },
            { id: 'm', type: 'change', z: 'z', name: 'merge', x: 0, y: 0, wires: [[]] },
        ];
        Layout.reflowCanvasNodes(flow, {});
        const [w, n, m] = flow;
        const W = (x) => Layout.getNodeWidth(x, {});
        const gap = (a, b) => (b.x - W(b) / 2) - (a.x + W(a) / 2);
        assert(gap(w, m) === 40 && gap(n, m) === 40, 'gaps ' + gap(w, m) + ' / ' + gap(n, m));
    });
});

// Stacked sequences are componentGap apart member to member, boxed or not.
describe('Boxed sequences are as far apart as unboxed ones', function() {
    const D = Layout.LAYOUT_DEFAULTS;
    // componentGap (3 squares) plus the node, rounded up to the grid.
    const PITCH = Math.ceil((D.nodeHeight + D.componentGap) / D.gridSize) * D.gridSize;
    const seq = (p, y, g) => [
        { id: p + '1', type: 'inject', z: 'z', name: p, x: 110, y: y, g: g, wires: [[p + '2']] },
        { id: p + '2', type: 'debug', z: 'z', name: p + 'd', x: 310, y: y, g: g, wires: [[]] },
    ];
    const boxOf = (id, members) => ({ id: id, type: 'group', z: 'z', name: id, nodes: members, x: 0, y: 0, w: 0, h: 0 });
    it('two boxed sequences: members componentGap apart', function() {
        const flow = seq('a', 100, 'gA').concat(seq('b', 120, 'gB'),
            [boxOf('gA', ['a1', 'a2']), boxOf('gB', ['b1', 'b2'])]);
        Layout.fitGroups(flow, {});
        Layout.settleCollisions(flow, {});
        assert(flow[2].y - flow[0].y === PITCH, 'centre to centre ' + (flow[2].y - flow[0].y));
    });
    it('a boxed sequence over a plain one: members componentGap apart', function() {
        const flow = seq('a', 100, 'gA').concat(seq('b', 120), [boxOf('gA', ['a1', 'a2'])]);
        Layout.fitGroups(flow, {});
        Layout.settleCollisions(flow, {});
        assert(flow[2].y - flow[0].y === PITCH, 'centre to centre ' + (flow[2].y - flow[0].y));
    });
    it('unboxed sequences from a reflow: the same pitch', function() {
        const flow = [
            { id: 'a1', type: 'inject', wires: [['a2']] }, { id: 'a2', type: 'debug', wires: [] },
            { id: 'b1', type: 'inject', wires: [['b2']] }, { id: 'b2', type: 'debug', wires: [] },
        ];
        Layout.reflowCanvasNodes(flow, {});
        assert(flow[2].y - flow[0].y === PITCH, 'centre to centre ' + (flow[2].y - flow[0].y));
    });
});

// The editor snaps a node's centre y and its left edge; a layout that leaves
// them anywhere else cannot be lined up by dragging.
describe('Everything the layout moves lands on the grid', function() {
    it('an off-grid node snaps: left edge and centre', function() {
        const flow = [{ id: 'n', type: 'inject', z: 'z', name: 'a', x: 113, y: 107, wires: [[]] }];
        Layout.snapToGrid(flow, {});
        const left = flow[0].x - Layout.getNodeWidth(flow[0], {}) / 2;
        assert(left % 20 === 0 && flow[0].y % 20 === 0, 'at (' + flow[0].x + ',' + flow[0].y + ')');
    });
    it('what the edit left where it was stays there', function() {
        const flow = [{ id: 'n', type: 'inject', z: 'z', name: 'a', x: 113, y: 107, wires: [[]] }];
        Layout.snapToGrid(flow, { keep: { n: true } });
        assert(flow[0].x === 113 && flow[0].y === 107, 'at (' + flow[0].x + ',' + flow[0].y + ')');
    });
    it('a caption moves with the node it heads', function() {
        const flow = [
            { id: 'n', type: 'inject', z: 'z', name: 'a', x: 113, y: 107, wires: [[]] },
            { id: 'c', type: 'comment', z: 'z', name: 'about a', x: 113, y: 67, _llmAboveId: 'n', wires: [] },
        ];
        Layout.snapToGrid(flow, {});
        assert(flow[1].x - flow[0].x === 0 && flow[0].y - flow[1].y === 40,
            'caption at (' + flow[1].x + ',' + flow[1].y + '), node at (' + flow[0].x + ',' + flow[0].y + ')');
    });
    it('a junction stays where its wires put it', function() {
        const flow = [{ id: 'j', type: 'junction', z: 'z', x: 113, y: 107, wires: [[]] }];
        Layout.snapToGrid(flow, {});
        assert(flow[0].x === 113 && flow[0].y === 107, 'at (' + flow[0].x + ',' + flow[0].y + ')');
    });
});

summary();
