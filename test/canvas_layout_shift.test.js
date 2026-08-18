// Regression tests for Step 3.5b cross-component push-down and related
// shift logic in canvas_layout.js. Run with `node test/canvas_layout_shift.test.js`.
//
// The historical bug: when a modifier component pushes multiple unrelated
// components down, computing dy per-component caused a comment sitting just
// above its target to be pushed FURTHER than the target itself (because the
// comment's higher minY produced a larger needed dy). The two then collapsed
// onto the same y. Fixed by computing one uniform dy per modifier pass.

const Layout = require('../src/core/canvas_layout.js');

const OPTS = {
    startX: 200, startY: 200, spacingY: 80, edgeGap: 80,
    componentGap: 80, bandGap: 80, maxColumns: Infinity
};
const NODE_HEIGHT = 30;

function nodeBox(n) {
    // Approximate width — good enough for an overlap check; real widths
    // come from estimateNodeWidth inside the layout engine.
    let w = (n.type === 'comment') ? 120 : 120;
    return {
        l: n.x - w / 2, r: n.x + w / 2,
        t: n.y - NODE_HEIGHT / 2, b: n.y + NODE_HEIGHT / 2
    };
}
function overlaps(a, b) {
    return !(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t);
}
function findOverlaps(nodes) {
    let out = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            if (nodes[i].type === 'tab' || nodes[j].type === 'tab') continue;
            if (overlaps(nodeBox(nodes[i]), nodeBox(nodes[j]))) {
                out.push([nodes[i], nodes[j]]);
            }
        }
    }
    return out;
}
function isGridAligned(n, grid) {
    return (n.x % grid) === 0 && (n.y % grid) === 0;
}
// Since the left-edge / edge-gap semantics change (15b11ae, 5763aa3), new
// nodes derive X from `neighbour edge + edgeGap` and captions left-align to
// their target — so CENTRES are no longer grid multiples; LEFT EDGES are the
// aligned quantity.
function leftEdge(n) {
    return n.x - Layout.estimateNodeWidth(n) / 2;
}

let passed = 0, failed = 0;
function it(label, fn) {
    try {
        fn();
        console.log('  ok  ' + label);
        passed++;
    } catch (e) {
        console.log('  FAIL ' + label);
        console.log('       ' + e.message);
        failed++;
    }
}
function describe(label, fn) {
    console.log(label);
    fn();
}
function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

// -----------------------------------------------------------------------

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
            OPTS);
        let bad = findOverlaps(nodes);
        assert(bad.length === 0, 'overlaps found: ' +
            bad.map(p => p[0].id + '/' + p[1].id).join(', '));
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
            { change: 1 }, { change:{x:820,y:870} }, OPTS);
        assert(cmt.y !== inj.y, 'comment ended up at inject.y');
        assert(inj.y - cmt.y === 40, 'comment should be 40px above inject');
        // Edge semantics: the inject aligns to its successor's row, sits
        // exactly edgeGap left of it, and the caption shares its left edge.
        assert(inj.y === change.y, 'inject should align to succ row, got ' + inj.y);
        assert(leftEdge(change) - (leftEdge(inj) + Layout.estimateNodeWidth(inj)) === OPTS.edgeGap,
            'inject should sit edgeGap left of succ');
        assert(leftEdge(cmt) === leftEdge(inj),
            'comment should left-align to inject: ' + leftEdge(cmt) + ' vs ' + leftEdge(inj));
        assert(leftEdge(inj) % 20 === 0, 'inject left edge not grid-aligned: ' + leftEdge(inj));
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
            { a:1, b:1 }, { a:{x:200,y:200}, b:{x:380,y:200} }, OPTS);
        assert(s2.y >= 280, 's2 should be nudged below row 200, got ' + s2.y);
        assert(findOverlaps(nodes).length === 0, 'sibling nudge produced overlap');
    });
});

describe('Grid alignment', function() {
    it('reflowCanvasNodes produces grid-aligned left edges', function() {
        const nodes = [
            { id: 'a', type: 'inject', wires: [['b']] },
            { id: 'b', type: 'function', name: 'compute aggregated rolling average', wires: [['c']] },
            { id: 'c', type: 'debug', wires: [] }
        ];
        Layout.reflowCanvasNodes(nodes, OPTS);
        // Left edges are the aligned quantity (see leftEdge above); centres
        // are derived as leftEdge + width/2 and may sit at half-grid when a
        // node's width is an odd grid multiple (e.g. the 100 px minimum).
        nodes.forEach(n => assert(leftEdge(n) % 20 === 0,
            n.id + ' left edge not grid-aligned: ' + leftEdge(n)));
        nodes.forEach(n => assert(n.y % 20 === 0,
            n.id + ' y not grid-aligned: ' + n.y));
    });

    it('placeAddedNodesNearNeighbors keeps left edges aligned', function() {
        const nodes = [
            { id: 'a', type: 'inject', x: 200, y: 200, wires: [['n']] },
            { id: 'n', type: 'function', name: 'wide', wires: [['b']],
              _llmOrder: 1, _llmAlias: 'fn_n' },
            { id: 'b', type: 'debug', x: 480, y: 200, wires: [] }
        ];
        Layout.placeAddedNodesNearNeighbors(nodes,
            { a:1, b:1 }, { a:{x:200,y:200}, b:{x:480,y:200} }, OPTS);
        const a = nodes[0], n = nodes[1];
        assert(leftEdge(n) === leftEdge(a) + Layout.estimateNodeWidth(a) + OPTS.edgeGap,
            'new node left edge should be pred right edge + edgeGap, got ' + leftEdge(n));
        nodes.forEach(nd => assert(leftEdge(nd) % 20 === 0,
            nd.id + ' left edge not grid-aligned: ' + leftEdge(nd)));
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
            { t:1 }, { t:{x:200,y:200} }, OPTS);
        [c1, c2, c3].forEach(n => assert(leftEdge(n) === leftEdge(t),
            n.id + ' should left-align to target: ' + leftEdge(n) + ' vs ' + leftEdge(t)));
        // Step = ceil(30/20)*20 = 40
        assert(c3.y === 160, 'bottom comment should be 40px above target');
        assert(c2.y === 120, 'middle comment should be 80px above target');
        assert(c1.y === 80,  'top comment should be 120px above target');
    });
});

describe('Standalone comments (no touching neighbour)', function() {
    it('reflowCanvasNodes leaves a bird\'s-eye caption at its original (x,y)', function() {
        // A comment far above all flow nodes (no neighbour within
        // stackStep+grid below) is a deliberate annotation — the
        // reflow should not drag it down into the orphan band.
        const flow = [
            { id: 'inj', type: 'inject',   name: 'in',  x: 280, y: 260, wires: [['fn']] },
            { id: 'fn',  type: 'function', name: 'fn',  x: 480, y: 260, wires: [['dbg']] },
            { id: 'dbg', type: 'debug',    name: 'dbg', x: 680, y: 260, wires: [] },
            { id: 'note', type: 'comment', name: 'Flow Explanation',
                          x: 180, y: 100, wires: [] }
        ];
        Layout.reflowCanvasNodes(flow, OPTS);
        const note = flow.find(n => n.id === 'note');
        assert(note.x === 180 && note.y === 100,
            'standalone comment moved from (180,100) to (' + note.x + ',' + note.y + ')');
    });

    it('placeAddedNodesNearNeighbors keeps the standalone caption put', function() {
        const flow = [
            { id: 'inj', type: 'inject',   name: 'in',  x: 280, y: 260, wires: [['fn']] },
            { id: 'fn',  type: 'function', name: 'fn',  x: 480, y: 260, wires: [['dbg']] },
            { id: 'dbg', type: 'debug',    name: 'dbg', x: 680, y: 260, wires: [] },
            { id: 'note', type: 'comment', name: 'Flow Explanation',
                          x: 180, y: 100, wires: [] }
        ];
        const baseIds = { inj:1, fn:1, dbg:1, note:1 };
        const basePos = { inj:{x:280,y:260}, fn:{x:480,y:260},
                          dbg:{x:680,y:260}, note:{x:180,y:100} };
        Layout.placeAddedNodesNearNeighbors(flow, baseIds, basePos, OPTS);
        const note = flow.find(n => n.id === 'note');
        assert(note.x === 180 && note.y === 100,
            'standalone comment moved from (180,100) to (' + note.x + ',' + note.y + ')');
    });

    it('placeAddedNodesNearNeighbors with a new sibling still preserves the caption', function() {
        // A flow with one existing chain and one bird's-eye comment.
        // Adding a new node should NOT cause the caption to migrate down.
        const flow = [
            { id: 'inj', type: 'inject',   name: 'in',  x: 280, y: 260, wires: [['fn']] },
            { id: 'fn',  type: 'function', name: 'fn',  x: 480, y: 260, wires: [['dbg']] },
            { id: 'dbg', type: 'debug',    name: 'dbg', x: 680, y: 260, wires: [] },
            { id: 'note', type: 'comment', name: 'Flow Explanation',
                          x: 180, y: 100, wires: [] },
            { id: 'newdbg', type: 'debug', name: 'new', wires: [],
                            _llmOrder: 1, _llmAlias: 'dbg_new' }
        ];
        // Wire new node from inj
        flow[0].wires = [['fn', 'newdbg']];
        const baseIds = { inj:1, fn:1, dbg:1, note:1 };
        const basePos = { inj:{x:280,y:260}, fn:{x:480,y:260},
                          dbg:{x:680,y:260}, note:{x:180,y:100} };
        Layout.placeAddedNodesNearNeighbors(flow, baseIds, basePos, OPTS);
        const note = flow.find(n => n.id === 'note');
        assert(note.x === 180 && note.y === 100,
            'standalone comment moved from (180,100) to (' + note.x + ',' + note.y + ')');
    });
});

// -----------------------------------------------------------------------
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
