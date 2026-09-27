// One Agent-node reply, applied by one editor: every open editor gets it over
// comms, and the first to claim its id applies it. Module state, shared by the
// node and the admin route. See docs/{en,jp}/llm-request.md.
const crypto = require('crypto');

// Longer than an editor needs to react to a comms message, short enough that
// unclaimed ids (no editor open) do not pile up.
const CLAIM_WINDOW_MS = 10 * 60 * 1000;

let open = {};   // id -> expiry time

function prune(now) {
    Object.keys(open).forEach(function(id) {
        if (open[id] <= now) delete open[id];
    });
}

function issue() {
    const now = Date.now();
    prune(now);
    const id = crypto.randomBytes(12).toString('hex');
    open[id] = now + CLAIM_WINDOW_MS;
    return id;
}

// True exactly once per issued id.
function claim(id) {
    prune(Date.now());
    if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(open, id)) return false;
    delete open[id];
    return true;
}

module.exports = { issue: issue, claim: claim };
