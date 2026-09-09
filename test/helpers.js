// Shared test scaffolding: the pass/fail counter, and the vm sandbox that
// runs the real client modules against a mocked editor.
//
// Each suite keeps its own `buildRED` — the registries and the state a
// scenario captures are the point of that suite.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// The editor's own load order (see src/client.js). Keeping it identical is
// deliberate: a load-time dependency that only holds in one order must fail
// here too, not only in production.
const CLIENT_MODULES = [
  'src/common.js',
  'src/core/canvas_layout.js',
  'src/core/flow_converter_core.js',
  'src/core/llm_json_parser.js',
  'src/chat_manager.js',
  'src/importer.js',
  'src/ui_core.js',
];

let assertions = 0, failures = 0;

function ok(cond, msg) {
  assertions++;
  if (cond) console.log('  ok  ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// A thrown assert is a failure, not a crash.
function it(label, fn) {
  assertions++;
  try {
    fn();
    console.log('  ok  ' + label);
  } catch (e) {
    failures++;
    console.log('  FAIL ' + label);
    console.log('       ' + (e && e.message ? e.message : e));
  }
}

function describe(label, fn) {
  console.log('\n' + label);
  fn();
}

// Call once, at the end.
function summary() {
  console.log('\n' + (assertions - failures) + ' passed, ' + failures + ' failed');
  process.exit(failures ? 1 : 0);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// The fenced block an LLM would emit.
function fence(obj) {
  return '```json\n' + JSON.stringify(obj) + '\n```';
}

// A FRESH context per scenario — the client modules hold singletons.
// → the sandbox's `window.LLMPlugin`
function loadPluginSandbox(RED) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    requestAnimationFrame: (cb) => cb(),
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
    document: {
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, appendChild() {} }),
    },
    RED,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const rel of CLIENT_MODULES) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  return sandbox.window.LLMPlugin;
}

// ------------------------------------------------------------------ //
//  A mock of the editor's node registry                               //
// ------------------------------------------------------------------ //
//
// Faithful on the two points the importer actually depends on:
//
//  1. LINKS ARE OBJECTS IN THEIR OWN REGISTRY. `node.wires` is not the
//     source of truth in the editor — `{ source, sourcePort, target }` link
//     objects are, and `createExportableNodeSet` derives `wires` from them.
//     A mock that stores `wires` on the node cannot tell a real rewire from
//     a no-op, which is precisely what the incremental applier has to get
//     right.
//  2. EACH ENTITY KIND HAS ITS OWN LOOKUP. filterNodes returns regular
//     canvas nodes only; junctions, groups and config nodes live apart, and
//     the remove API is different for each.
//
// `snapshot(z)` is what assertions should read: the flow as it now stands,
// not the payload that happened to be handed to import(). Under an
// incremental apply most changes never go through import() at all.
function buildEditorMock(opts) {
  opts = opts || {};
  const tabs = opts.tabs || [];
  const nodesById = {};
  const configById = {};
  const junctionsById = {};
  const groupsById = {};
  let links = [];
  let importCalls = 0;

  const captured = {
    imports: [], removed: [], removedJunctions: [], removedGroups: [],
    linksAdded: [], linksRemoved: [],
  };

  (opts.configs || []).forEach((c) => { configById[c.id] = clone(c); });
  (opts.junctions || []).forEach((j) => { junctionsById[j.id] = clone(j); });
  (opts.groups || []).forEach((g) => { groupsById[g.id] = clone(g); });

  const anyEntity = (id) =>
    nodesById[id] || junctionsById[id] || groupsById[id] || configById[id] || null;

  // Turn a node's `wires` array into link objects, the way import() does.
  function linkFromWires(node) {
    (node.wires || []).forEach((port, i) => {
      (Array.isArray(port) ? port : []).forEach((targetId) => {
        const target = nodesById[targetId] || junctionsById[targetId];
        if (!target) return;
        addLink({ source: node, sourcePort: i, target });
      });
    });
    // The array is dropped: keeping it would let an assertion pass by reading
    // a stale copy instead of the link registry.
    delete node.wires;
  }

  function addLink(l) {
    const dup = links.some(
      (x) => x.source.id === l.source.id && x.sourcePort === l.sourcePort && x.target.id === l.target.id
    );
    if (dup) return;
    links.push(l);
    captured.linksAdded.push(l.source.id + ':' + l.sourcePort + '->' + l.target.id);
  }

  function removeLink(l) {
    const i = links.indexOf(l);
    if (i === -1) return;
    links.splice(i, 1);
    captured.linksRemoved.push(l.source.id + ':' + l.sourcePort + '->' + l.target.id);
  }

  function wiresOf(node) {
    const outs = links.filter((l) => l.source.id === node.id);
    const width = Math.max(
      typeof node.outputs === 'number' ? node.outputs : 0,
      outs.reduce((m, l) => Math.max(m, l.sourcePort + 1), 0),
      Array.isArray(node._wireWidth) ? 0 : 0
    );
    const wires = [];
    for (let i = 0; i < width; i++) wires.push([]);
    outs.forEach((l) => {
      while (wires.length <= l.sourcePort) wires.push([]);
      wires[l.sourcePort].push(l.target.id);
    });
    return wires;
  }

  // Nodes arrive with `wires`; store them, then convert to links.
  (opts.nodes || []).forEach((n) => {
    const copy = clone(n);
    // Remember the declared port count so an export can rebuild an empty
    // trailing port (a node with 2 outputs and nothing on output 1).
    if (Array.isArray(n.wires) && typeof copy.outputs !== 'number') {
      copy._ports = n.wires.length;
    }
    nodesById[copy.id] = copy;
  });
  (opts.nodes || []).forEach((n) => {
    const live = nodesById[n.id];
    live.wires = clone(n.wires || []);
    linkFromWires(live);
  });
  // `captured` is the record of what the code under test did, so the links
  // laid down building the starting flow must not appear in it.
  captured.linksAdded.length = 0;
  captured.linksRemoved.length = 0;

  // The real convertNode() copies only the keys a node type DECLARES
  // (`_def.defaults`) plus id/type/z/d/g — so the editor's own bookkeeping
  // never reaches an export. Dropping them here matters: `dirty` leaking into
  // a snapshot would make every in-place update look like a config change to
  // anything comparing exports, Node-RED's deploy diff included.
  const EDITOR_INTERNAL = ['dirty', 'changed', 'moved', 'selected', 'resize', 'l', '_ports', '_def', '_'];
  // Fixtures list group members as ids; the editor holds the node objects
  // themselves. Swapping them in here is what makes RED.group.removeFromGroup
  // below behave like the real one — it finds a member with indexOf on the
  // object, so an array of ids would silently match nothing.
  (function resolveGroupMembers() {
    Object.values(groupsById).forEach((g) => {
      if (!Array.isArray(g.nodes)) { g.nodes = []; return; }
      g.nodes = g.nodes
        .map((m) => (typeof m === 'string' ? anyEntity(m) : m))
        .filter(Boolean);
    });
  })();

  function exportOne(entity) {
    const out = clone(entity);
    EDITOR_INTERNAL.forEach((k) => { delete out[k]; });
    if (entity.type === 'group') {
      // A live group holds node OBJECTS; the export shape is ids.
      out.nodes = (entity.nodes || []).map((m) => (typeof m === 'string' ? m : m && m.id)).filter(Boolean);
      return out;
    }
    if (junctionsById[entity.id] || configById[entity.id]) return out;
    const w = wiresOf(entity);
    const ports = typeof entity.outputs === 'number' ? entity.outputs : entity._ports;
    if (typeof ports === 'number') while (w.length < ports) w.push([]);
    out.wires = w;
    return out;
  }

  const RED = {
    notify: function () {},
    nodes: {
      filterNodes: (f) => Object.values(nodesById).filter((n) => !f || n.z === f.z),
      junctions: (z) => Object.values(junctionsById).filter((j) => j.z === z),
      groups: (z) => Object.values(groupsById).filter((g) => g.z === z),
      junction: (id) => junctionsById[id] || null,
      group: (id) => groupsById[id] || null,
      workspace: (id) => tabs.find((t) => t.id === id) || null,
      eachWorkspace: (cb) => tabs.forEach(cb),
      eachNode: (cb) => Object.values(nodesById).forEach(cb),
      eachConfig: (cb) => Object.values(configById).forEach(cb),
      node: (id) => nodesById[id] || configById[id] || null,
      getType: () => undefined,
      createExportableNodeSet: (set) => (set || []).filter(Boolean).map(exportOne),
      getNodeLinks: (id, portType) =>
        links.filter((l) => (portType === 1 ? l.target.id === id : l.source.id === id)),
      addLink,
      removeLink,
      updateConfigNodeUsers: function () {},
      import: function (nodes) {
        importCalls++;
        // Reproduces a mid-import failure (a malformed node, a registry that
        // rejects the set) so the rollback path runs.
        if (opts.failFirstImport && importCalls === 1) {
          throw new Error('simulated import failure');
        }
        captured.imports.push(clone(nodes));
        const added = [];
        clone(nodes).forEach((n) => {
          if (!n || !n.id) return;
          if (n.type === 'junction') junctionsById[n.id] = n;
          else if (n.type === 'group') groupsById[n.id] = n;
          else if (n.z === undefined) configById[n.id] = n;
          else { nodesById[n.id] = n; added.push(n); }
        });
        added.forEach((n) => {
          if (Array.isArray(n.wires) && typeof n.outputs !== 'number') n._ports = n.wires.length;
          linkFromWires(n);
        });
        return { nodes };
      },
      remove: function (id) {
        captured.removed.push(id);
        links.filter((l) => l.source.id === id || l.target.id === id).slice().forEach(removeLink);
        delete nodesById[id];
        delete configById[id];
      },
      removeJunction: function (j) {
        captured.removedJunctions.push(j.id);
        links.filter((l) => l.source.id === j.id || l.target.id === j.id).slice().forEach(removeLink);
        delete junctionsById[j.id];
      },
      removeGroup: function (g) {
        captured.removedGroups.push(g.id);
        delete groupsById[g.id];
      },
      dirty: () => {},
    },
    view: { redraw: () => {} },
    actions: { invoke: () => {} },
    // Mirrors @node-red/editor-client's RED.group on the points the importer
    // depends on: members are matched by object identity, a node whose `g`
    // does not name this group is refused outright, and a successful removal
    // clears `g` as well as splicing the list. Both halves, or neither —
    // that pairing is the whole reason the API exists.
    group: {
      removeFromGroup: function (group, nodes, reparent) {
        if (!Array.isArray(nodes)) nodes = [nodes];
        for (const n of nodes) { if (n.g !== group.id) return; }
        nodes.forEach((n) => {
          const i = group.nodes.indexOf(n);
          if (i !== -1) group.nodes.splice(i, 1);
          if (reparent && group.g) { n.g = group.g; } else { delete n.g; }
        });
      },
    },
    workspaces: {
      active: () => opts.activeId,
      refresh: () => {},
      show: () => {},
      isLocked: () => !!opts.workspaceLocked,
    },
  };

  // The flow as it now stands, in export shape — what the canvas IS, rather
  // than what was handed to import().
  function snapshot(z) {
    const ents = Object.values(nodesById).filter((n) => n.z === z)
      .concat(Object.values(junctionsById).filter((j) => j.z === z))
      .concat(Object.values(groupsById).filter((g) => g.z === z));
    return ents.map(exportOne);
  }
  function idsIn(z) { return snapshot(z).map((n) => n.id); }

  return { RED, captured, snapshot, idsIn, anyEntity };
}

module.exports = {
  ROOT,
  ok, assert, it, describe, summary,
  clone, fence, loadPluginSandbox, buildEditorMock,
};
