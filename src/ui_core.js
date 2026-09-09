// UI core module — vanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    let UI = {};
    // client.js loads these before this file.
    let Common = window.LLMPlugin.Common;
    let Converter = window.LLMPlugin.FlowConverterCore;
    let Parser = window.LLMPlugin.LLMJsonParser;
    let escapeHtml = Common.escapeHtml;

    // Messages render inside the editor, which holds full admin privileges.
    // A regex over `href` is bypassed by entity encoding (`javascript&colon;`)
    // that the browser decodes on click, so each URL is resolved through the
    // DOM — what the browser itself does — and matched against this allowlist.
    let SAFE_URL_SCHEMES = { 'http:': 1, 'https:': 1, 'mailto:': 1, 'tel:': 1 };
    function sanitizeRenderedHtml(html) {
        // Inert document, not innerHTML on a live element: the allowlist below
        // must run before anything can be fetched. There is deliberately no
        // fallback — the only one available is the very thing this avoids.
        let holder = new DOMParser().parseFromString(html, 'text/html').body;
        // Anchors: keep the text, drop an unsafe href (relative/#/http(s)
        // resolve to http:/https: and are allowed).
        holder.querySelectorAll('a[href]').forEach(function(a) {
            let scheme = '';
            try { scheme = (a.protocol || '').toLowerCase(); } catch (e) { scheme = ''; }
            if (!SAFE_URL_SCHEMES[scheme]) a.removeAttribute('href');
            a.setAttribute('rel', 'noopener noreferrer');
        });
        // Media src (markdown images): forbid non-http(s) so data:/javascript
        // sources can't smuggle anything past the escape of raw < >.
        holder.querySelectorAll('[src]').forEach(function(el) {
            let scheme = '';
            try { scheme = new URL(el.getAttribute('src'), document.baseURI).protocol.toLowerCase(); }
            catch (e) { scheme = ''; }
            if (scheme && scheme !== 'http:' && scheme !== 'https:') el.removeAttribute('src');
        });
        return holder.innerHTML;
    }

    function formatMessage(text) {
        // Run with marked.js (assumed present in modern Node-RED environments)
        if (typeof marked !== 'undefined' && marked.parse) {
            let raw = String(text || '').trim();
            if (raw && (raw.charAt(0) === '{' || raw.charAt(0) === '[')) {
                try {
                    let parsedRaw = JSON.parse(raw);
                    if (parsedRaw && typeof parsedRaw === 'object') {
                        let descHtml = '';
                        let displayObj = parsedRaw;
                        if (parsedRaw.nodes && parsedRaw.connections &&
                            parsedRaw.description && typeof parsedRaw.description === 'string') {
                            descHtml = '<p>' + escapeHtml(parsedRaw.description) + '</p>';
                            displayObj = JSON.parse(JSON.stringify(parsedRaw));
                            delete displayObj.description;
                        }
                        return descHtml + '<pre><code class="language-json">' +
                            escapeHtml(JSON.stringify(displayObj, null, 2)) +
                            '</code></pre>';
                    }
                } catch (e) { /* not raw JSON */ }
            }

            let safeText = String(text || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            let html = marked.parse(safeText);
            return sanitizeRenderedHtml(html);
        }

        return escapeHtml(text);
    }

    // Focus a node the way the Debug sidebar does. Config nodes have no
    // canvas position, so they open their edit dialog instead. One try/catch
    // for the whole routine: focus is best-effort, and every failure along
    // the way has the same answer.
    function focusCanvasNode(nodeId) {
        try {
            if (!nodeId) return;
            let node = RED.nodes.node(nodeId);
            if (!node) {
                Common.notify('Node no longer exists', 'warning');
                return;
            }

            // Config nodes have no canvas position — open their editor instead.
            if (typeof node.x !== 'number' || typeof node.y !== 'number') {
                RED.editor.editConfig('', node.type, node.id);
                return;
            }

            if (node.z) RED.workspaces.show(node.z);
            node.highlighted = true;
            node.dirty = true;
            RED.view.reveal(node.id);
            RED.view.redraw();

            setTimeout(function() {
                let live = RED.nodes.node(nodeId);
                if (!live) return;
                live.highlighted = false;
                live.dirty = true;
                RED.view.redraw();
            }, 2500);
        } catch (e) {
            console.warn('[LLM Plugin] Could not focus node', nodeId, e);
        }
    }

    // Wire a code-like element so clicking it focuses the named node.
    function attachNodeRefHandler(el, nodeId) {
        el.classList.add('llm-node-ref');
        el.setAttribute('data-node-id', nodeId);
        el.title = 'Click to focus on this node';
        el.addEventListener('click', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            focusCanvasNode(this.getAttribute('data-node-id'));
        });
    }

    // Make node references clickable: pass 1 over inline <code>, pass 2 over
    // plain text (for when the LLM forgets to backtick an alias).
    //
    // The alias map must be built from the SAME node list the LLM saw —
    // toIntermediate numbers duplicates by iteration order, so `change_2`
    // otherwise points at a different node. Hence getFlowsByIds(targetFlowIds).
    function annotateNodeReferences(rootEl, targetFlowIds) {
        if (!rootEl) return;

        let scoped = Array.isArray(targetFlowIds) && targetFlowIds.length > 0;
        let allNodes = null;
        if (scoped) {
            try { allNodes = UI.getFlowsByIds(targetFlowIds); } catch (e) { allNodes = null; }
        }
        if (!Array.isArray(allNodes) || allNodes.length === 0) {
            allNodes = [];
            RED.nodes.eachNode(function(n) { allNodes.push(n); });
            RED.nodes.eachConfig(function(n) { allNodes.push(n); });
        }
        if (allNodes.length === 0) return;

        let lookup;
        try {
            lookup = Parser.buildFlowLookup(allNodes, Converter);
        } catch (e) { return; }

        function isFocusable(id) {
            let n = lookup.byId[id];
            if (!n || n.type === 'tab') return false;
            // Canvas nodes have x/y; config nodes don't (we open their
            // edit dialog instead). Both are focusable.
            return true;
        }

        // --- Pass 1: inline <code> -----------------------------------
        let codes = rootEl.querySelectorAll('code');
        for (let i = 0; i < codes.length; i++) {
            let code = codes[i];
            if (code.closest('pre')) continue;
            if (code.classList.contains('llm-node-ref')) continue;

            let text = (code.textContent || '').trim();
            if (!text || text.length < 2 || text.length > 80) continue;
            if (/\s/.test(text)) continue;

            let id;
            try { id = lookup.resolve(text, { fuzzy: false }); } catch (e) { continue; }
            if (!id || !isFocusable(id)) continue;

            attachNodeRefHandler(code, id);
        }

        // --- Pass 2: plain-text alias scan ---------------------------
        let aliasToId = lookup.aliasToId || {};
        // Longest-first so compound aliases win over their bare-type prefix;
        // aliases under 3 chars are skipped as noise.
        let aliases = Object.keys(aliasToId).filter(function(a) {
            return a.length >= 3 && isFocusable(aliasToId[a]);
        });
        if (aliases.length === 0) return;
        aliases.sort(function(a, b) { return b.length - a.length; });
        let pattern;
        try {
            pattern = new RegExp('\\b(' + aliases.map(Common.escapeRegExp).join('|') + ')\\b', 'g');
        } catch (e) { return; }

        let walker = document.createTreeWalker(
            rootEl,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: function(node) {
                    let p = node.parentNode;
                    while (p && p !== rootEl) {
                        let tag = p.tagName;
                        if (tag === 'CODE' || tag === 'PRE' || tag === 'A' ||
                            tag === 'SCRIPT' || tag === 'STYLE') {
                            return NodeFilter.FILTER_REJECT;
                        }
                        p = p.parentNode;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        // Collect first to avoid mutating the DOM during traversal.
        let textNodes = [];
        let tn;
        while ((tn = walker.nextNode())) textNodes.push(tn);

        textNodes.forEach(function(textNode) {
            let text = textNode.nodeValue;
            if (!text || text.length === 0) return;
            pattern.lastIndex = 0;
            if (!pattern.test(text)) return;
            pattern.lastIndex = 0;

            let frag = document.createDocumentFragment();
            let lastIdx = 0;
            let m;
            while ((m = pattern.exec(text)) !== null) {
                let matchText = m[1];
                let matchIdx = m.index;
                let id = aliasToId[matchText];
                if (!id) continue;
                if (matchIdx > lastIdx) {
                    frag.appendChild(document.createTextNode(text.slice(lastIdx, matchIdx)));
                }
                let code = document.createElement('code');
                code.textContent = matchText;
                attachNodeRefHandler(code, id);
                frag.appendChild(code);
                lastIdx = matchIdx + matchText.length;
            }
            if (lastIdx === 0) return;
            if (lastIdx < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx)));
            }
            textNode.parentNode.replaceChild(frag, textNode);
        });
    }

    // Re-annotate every assistant message. Historical messages can render
    // before RED.nodes is populated (empty alias map → silent skip), so
    // RED.events hooks catch up once nodes arrive and keep annotations in
    // sync across edits / deploys.
    let _reannotateDebounce = null;
    function reannotateAllAssistantMessages() {
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return;
        let messages = chatArea.querySelectorAll('.assistant-message');
        for (let i = 0; i < messages.length; i++) {
            let msgEl = messages[i];
            let content = msgEl.querySelector('.message-content');
            if (!content) continue;
            let scope = null;
            let raw = msgEl.dataset.targetFlowIds;
            if (raw) { try { scope = JSON.parse(raw); } catch (e) { scope = null; } }
            try { annotateNodeReferences(content, scope); } catch (e) {}
        }
    }
    function scheduleReannotate() {
        if (_reannotateDebounce) clearTimeout(_reannotateDebounce);
        _reannotateDebounce = setTimeout(function() {
            _reannotateDebounce = null;
            reannotateAllAssistantMessages();
        }, 200);
    }
    (function registerFlowsReadyHook() {
        if (typeof RED === 'undefined' || !RED.events || typeof RED.events.on !== 'function') {
            setTimeout(registerFlowsReadyHook, 200);
            return;
        }
        // flows:loaded fires once after initial flow load. The node-level
        // events keep annotations fresh as the user edits / deploys.
        // workspace:change picks up tab switches that bring config nodes
        // for newly-visited subflows into RED.nodes.
        let events = ['flows:loaded', 'deploy', 'workspace:change',
                      'nodes:add', 'nodes:remove', 'nodes:change'];
        events.forEach(function(ev) {
            try { RED.events.on(ev, scheduleReannotate); } catch (e) { /* ignore */ }
        });
        // Also run once immediately in case RED.nodes is already populated
        // (e.g. plugin loaded after editor was already up).
        scheduleReannotate();
    })();

    function createRestoreCheckpointButton(checkpointId) {
        let btn = Common.cloneTemplate('llm-plugin-restore-btn-template');
        btn.dataset.checkpointId = checkpointId;
        btn.addEventListener('click', function() {
            let cpId = btn.dataset.checkpointId;
            if (!cpId) return;
            let ok = confirm('Restore the flow from this checkpoint? Current flow will be replaced.');
            if (!ok) return;
            btn.disabled = true;
            LLMPlugin.Importer.restoreCheckpoint(cpId)
                .then(function(result) {
                    if (result && result.ok) {
                        Common.notify('Checkpoint restored', 'success');
                    } else {
                        Common.notify((result && result.error) || 'Failed to restore checkpoint', 'error');
                    }
                })
                .catch(function(err) {
                    Common.notify((err && err.message) || 'Failed to restore checkpoint', 'error');
                })
                .finally(function() {
                    btn.disabled = false;
                });
        });
        return btn;
    }

    UI.addMessageToUI = function(content, isUser, showActions, messageMeta) {
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return null;

        let message = document.createElement('div');
        message.className = 'llm-plugin-message ' + (isUser ? 'user-message' : 'assistant-message');
        if (messageMeta && messageMeta.id) {
            message.dataset.messageId = messageMeta.id;
        }
        // Persist the flow IDs that were sent as LLM context with this
        // message, so reannotateAllAssistantMessages can rescope alias
        // resolution after later events (flows:loaded, deploy, etc.).
        let targetFlowIds = (messageMeta && messageMeta.meta &&
                             Array.isArray(messageMeta.meta.targetFlowIds))
            ? messageMeta.meta.targetFlowIds : null;
        if (targetFlowIds && targetFlowIds.length > 0) {
            try { message.dataset.targetFlowIds = JSON.stringify(targetFlowIds); } catch (e) {}
        }

        let messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = formatMessage(content);

        // Wrap JSON / Vibe-Schema code blocks in a collapsible <details> element
        let codeBlocks = messageContent.querySelectorAll('pre');
        for (let i = 0; i < codeBlocks.length; i++) {
            let pre = codeBlocks[i];
            let codeEl = pre.querySelector('code') || pre;
            try {
                let text = codeEl.textContent || '';
                let parsed = JSON.parse(text);
                if (parsed && typeof parsed === 'object') {
                    let details = document.createElement('details');
                    details.className = 'json-collapsible';
                    let summary = document.createElement('summary');

                    // Mirror FlowConverterCore.isVibeSchema: `nodes` OR
                    // `connections` alone is valid (e.g. a node-prop-only
                    // edit omits connections, a wiring tweak omits nodes).
                    let hasNodesObj = parsed.nodes && typeof parsed.nodes === 'object' && !Array.isArray(parsed.nodes);
                    let hasConnectionsArr = Array.isArray(parsed.connections);
                    let isVibeSchema = hasNodesObj || hasConnectionsArr;
                    if (isVibeSchema) {
                        summary.textContent = 'Vibe Schema JSON';
                        // If the LLM included a description inside the JSON,
                        // show it as a text paragraph and strip from the JSON display.
                        if (parsed.description && typeof parsed.description === 'string') {
                            let descPara = document.createElement('p');
                            descPara.textContent = parsed.description;
                            pre.parentNode.insertBefore(descPara, pre);
                            // Re-render the code block without the description field
                            let display = JSON.parse(JSON.stringify(parsed));
                            delete display.description;
                            codeEl.textContent = JSON.stringify(display, null, 2);
                        }
                    } else if (Array.isArray(parsed)) {
                        summary.textContent = 'Flow JSON (' + parsed.length + ' nodes)';
                    } else {
                        summary.textContent = 'JSON';
                    }
                    pre.parentNode.insertBefore(details, pre);
                    details.appendChild(summary);
                    details.appendChild(pre);
                }
            } catch (e) { /* not JSON — leave as-is */ }
        }

        // Make inline code that names a current canvas node clickable -
        // mirrors Node-RED's debug-node "jump to node" behaviour. The
        // immediate call wins when RED.nodes is already populated; the
        // flows-loaded hook (registered once at module load) catches
        // the cold-start race where this runs before flows finish
        // loading.
        if (!isUser) {
            try { annotateNodeReferences(messageContent, targetFlowIds); } catch (e) {}
        }

        message.appendChild(messageContent);

        if (!isUser) {
            let meta = messageMeta && messageMeta.meta ? messageMeta.meta : null;
            if (meta && typeof meta.elapsedMs === 'number' && isFinite(meta.elapsedMs)) {
                let elapsed = document.createElement('div');
                elapsed.className = 'message-elapsed';
                let parts = [];
                // Show the turn's mode (ask / agent) so the user can tell at a
                // glance which mode produced this response - especially useful
                // after switching modes mid-conversation.
                if (meta.mode === 'ask' || meta.mode === 'agent') {
                    parts.push(meta.mode);
                }
                if (meta.model && typeof meta.model === 'string') {
                    parts.push(meta.model);
                }
                // Target flow name (which flow this turn acted on) — kept in
                // chat history so it stays readable when reviewing later.
                if (meta.targetFlowName && typeof meta.targetFlowName === 'string') {
                    parts.push('→ ' + meta.targetFlowName);
                }
                parts.push((meta.elapsedMs / 1000).toFixed(1) + 's');
                elapsed.textContent = parts.join(' / ');
                message.appendChild(elapsed);
            }
        }

        if (!isUser && showActions) {
            let messageActions = Common.cloneTemplate('llm-plugin-message-actions-template');
            messageActions.querySelector('.retry-btn')
                .addEventListener('click', function() { UI.retryLastUserMessage(messageMeta); });
            message.appendChild(messageActions);
        }

        if (!isUser) {
            try {
                let flowNodes = LLMPlugin.Importer.extractFlowNodes(content);
                let hasDirectivesOnly = (!flowNodes || flowNodes.length === 0) &&
                    LLMPlugin.Importer.hasFlowDirectives(content);
                if ((flowNodes && flowNodes.length > 0) || hasDirectivesOnly) {
                    let flowActions = Common.cloneTemplate('llm-plugin-flow-actions-template');
                    let importBtn = flowActions.querySelector('.import-btn');

                    let isAgent = messageMeta && messageMeta.meta && messageMeta.meta.mode === 'agent';
                    if (isAgent) importBtn.style.display = 'none';

                    // Show the Restore button for the checkpoint this import
                    // took. Shared by the fresh-import path below and the
                    // rebuild for an already-applied message further down.
                    function showRestoreButton(checkpointId) {
                        let preChatActions = message.querySelector('.pre-chat-actions');
                        if (!preChatActions) {
                            preChatActions = Common.cloneTemplate('llm-plugin-pre-chat-actions-template');
                            message.insertBefore(preChatActions, message.firstChild);
                        }
                        preChatActions.querySelectorAll('.restore-btn').forEach(function(b) { b.remove(); });
                        preChatActions.appendChild(createRestoreCheckpointButton(checkpointId));
                    }

                    importBtn.addEventListener('click', function() {
                        importBtn.disabled = true;
                        let chatId = LLMPlugin.ChatManager.getCurrentChatId();
                        let targetFlowIds = (messageMeta && messageMeta.meta && Array.isArray(messageMeta.meta.targetFlowIds))
                            ? messageMeta.meta.targetFlowIds
                            : null;

                        // Through the queue rather than straight to the
                        // importer: if an earlier edit is on the canvas and
                        // not deployed yet, this one waits for that deploy
                        // instead of merging on top of an uncommitted change.
                        LLMPlugin.ApplyQueue.enqueue({
                            source: 'sidebar',
                            label: 'Import Flow',
                            targetFlowIds: targetFlowIds,
                            // Everything below runs when this entry's turn
                            // comes, INCLUDING the checkpoint. Taken at click
                            // time it would snapshot a flow that the apply
                            // ahead of this one is about to change, and
                            // Restore would rewind to a state that never
                            // existed. If the checkpoint fails to save the
                            // import still runs, just with no Restore button.
                            apply: function() {
                                return LLMPlugin.ChatManager.saveImportCheckpoint(chatId, targetFlowIds)
                                    .then(function(checkpointId) {
                                        return LLMPlugin.Importer.importFlowFromMessage(content, {
                                            chatId: chatId,
                                            mode: (messageMeta && messageMeta.meta && messageMeta.meta.mode) ? messageMeta.meta.mode : 'ask',
                                            // Confine every write to the flows
                                            // this turn was given as context —
                                            // the same set the checkpoint above
                                            // covers, so Restore can always undo
                                            // whatever the import did, and the
                                            // same set the queue holds until the
                                            // next deploy.
                                            allowedWorkspaceIds: targetFlowIds
                                        }).then(function(result) {
                                            if (result && result.ok && checkpointId) {
                                                showRestoreButton(checkpointId);
                                                if (messageMeta && messageMeta.id) {
                                                    LLMPlugin.ChatManager.updateMessageMeta(messageMeta.id, {
                                                        pluginEdited: true,
                                                        checkpointId: checkpointId
                                                    });
                                                }
                                            }
                                            // The importer's result, not the
                                            // UI's: the queue reads `ok` off
                                            // this to decide whether to hold
                                            // these flows until a deploy.
                                            return result;
                                        });
                                    });
                            }
                        })
                        .catch(function(err) {
                            // An import error has already been reported by the
                            // importer itself. A cancellation has not — it is
                            // the queue's own outcome — so only that is
                            // announced here, and nothing is said twice.
                            if (err && /Cancelled/.test(err.message || '')) {
                                Common.notify('Import cancelled', 'warning');
                            }
                        })
                        .finally(function() {
                            importBtn.disabled = false;
                        });
                    });
                    // Rebuild restore button for previously edited plugin messages.
                    let existingCheckpointId = messageMeta && messageMeta.meta && messageMeta.meta.pluginEdited
                        ? messageMeta.meta.checkpointId
                        : null;
                    if (existingCheckpointId) showRestoreButton(existingCheckpointId);

                    message.appendChild(flowActions);
                }
            } catch (e) {
                // Was a bare swallow. The parse below it can legitimately
                // fail on a malformed reply, but a missing markup template
                // throws here too, and that must not vanish silently — it
                // would present as "the Import button stopped appearing".
                if (window.console) console.error('[LLM Plugin] flow actions not rendered:', e);
            }
        }

        chatArea.appendChild(message);
        chatArea.scrollTop = chatArea.scrollHeight;
        return message;
    };

    UI.retryLastUserMessage = function(messageMeta) {
        try {
            let chatId = LLMPlugin.ChatManager.getCurrentChatId();
            let history = LLMPlugin.ChatManager.getChatHistory();
            let chat = history[chatId];
            if (!chat || !chat.messages) return;
            let userMessages = chat.messages.filter(function(msg) { return msg.isUser; });
            if (userMessages.length === 0) return;
            let lastUserMsg = userMessages[userMessages.length - 1];
            let promptInput = document.getElementById('llm-plugin-prompt');
            let generateBtn = document.getElementById('llm-plugin-generate');
            if (!promptInput || !generateBtn) return;

            // Restore the checkpoint attached to the retried assistant
            // message so the next request sees the pre-edit flow. Without
            // this the LLM would resend against the already-edited state.
            let checkpointId = messageMeta && messageMeta.meta && messageMeta.meta.checkpointId;

            function doSend() {
                promptInput.value = lastUserMsg.content;
                generateBtn.click();
            }

            if (checkpointId) {
                LLMPlugin.Importer.restoreCheckpoint(checkpointId)
                    .then(doSend)
                    .catch(function(err) {
                        console.warn('[LLM Plugin] Retry restore failed; sending with current flow:', err);
                        doSend();
                    });
            } else {
                doSend();
            }
        } catch (e) {
            console.error('Error retrying message:', e);
        }
    };

    UI.getFlowsByIds = function(flowIds, opts) {
        try {
            if (!window.RED || !RED.nodes) return null;
            let ids = Array.isArray(flowIds) ? flowIds.filter(Boolean) : [];
            if (ids.length === 0) return null;

            let seenIds = {};
            let nodes = [];
            // Include tab definition nodes so the server can resolve
            // flow names when grouping multi-flow context for the LLM.
            ids.forEach(function(zid) {
                let ws = RED.nodes.workspace(zid);
                if (ws && ws.id && !seenIds[ws.id]) {
                    seenIds[ws.id] = true;
                    nodes.push(ws);
                }
            });
            
            ids.forEach(function(zid) {
                let n = RED.nodes.filterNodes({z: zid}) || [];
                n.forEach(function(node) {
                    if (node && node.id && !seenIds[node.id]) {
                        seenIds[node.id] = true;
                        nodes.push(node);
                    }
                });
            });

            // filterNodes never returns junctions or groups. A caller that
            // will REBUILD the flow must opt in, or the remove-then-reimport
            // cycle deletes them. The LLM-context path stays opted out so the
            // alias numbering the model sees does not change.
            if (opts && opts.includeCanvasExtras) {
                ids.forEach(function(zid) {
                    let extras = (RED.nodes.junctions(zid) || []).concat(RED.nodes.groups(zid) || []);
                    extras.forEach(function(node) {
                        if (node && node.id && !seenIds[node.id]) {
                            seenIds[node.id] = true;
                            nodes.push(node);
                        }
                    });
                });
            }
            if (nodes.length === 0) return null;

            let configNodes = collectReferencedConfigs(nodes, seenIds);
            let allNodes = nodes.concat(configNodes);

            return RED.nodes.createExportableNodeSet(allNodes);
        } catch (error) {
            console.error('Error getting flows by ids:', error);
            return null;
        }
    };

    // By reference only — the flow selection is the user's statement of what
    // may leave the machine. References are followed transitively (broker →
    // tls-config) and through array properties, matching `flowContextFor` in
    // node/llm-request/llm-request.js.
    function collectReferencedConfigs(nodes, seenIds) {
        let configById = {};
        RED.nodes.eachConfig(function(cn) {
            if (cn && cn.id) configById[cn.id] = cn;
        });

        let SKIP_KEYS = { id: 1, z: 1, type: 1, wires: 1, x: 1, y: 1, g: 1 };
        function referencedConfigIds(node) {
            let out = [];
            Object.keys(node).forEach(function(k) {
                if (SKIP_KEYS[k]) return;
                let value = node[k];
                let candidates = Array.isArray(value) ? value : [value];
                candidates.forEach(function(v) {
                    if (typeof v === 'string' && configById[v]) out.push(v);
                });
            });
            return out;
        }

        // `visited` is local so a reference cycle between two config nodes
        // terminates even when the caller passes no `seenIds`.
        let visited = {};
        let configNodes = [];
        let queue = nodes.slice();
        while (queue.length > 0) {
            let node = queue.pop();
            if (!node) continue;
            referencedConfigIds(node).forEach(function(id) {
                if (visited[id]) return;
                visited[id] = true;
                let cn = configById[id];
                if (!cn) return;
                // A config node may itself reference another one, so it is
                // queued whether or not the export set already holds it.
                queue.push(cn);
                if (seenIds && seenIds[id]) return;
                if (seenIds) seenIds[id] = true;
                configNodes.push(cn);
            });
        }
        return configNodes;
    }

    /**
     * Get the ID of the currently active workspace/tab.
     */
    UI.getActiveWorkspaceId = function() {
        if (window.RED && RED.workspaces) {
            return RED.workspaces.active() || null;
        }
        return null;
    };

    /**
     * Automatically extract unique tab/workspace IDs referenced by a list of nodes.
     */
    UI.extractWorkspaceIds = function(nodes) {
        if (!Array.isArray(nodes)) return [];
        let workspaceIds = {};
        nodes.forEach(function(n) {
            if (n && n.type === 'tab' && n.id) workspaceIds[n.id] = true;
            if (n && n.z) workspaceIds[n.z] = true;
        });
        return Object.keys(workspaceIds);
    };

    /**
     * Gets the full JSON configuration for the specified tab workspaces (or the active tab if omitted),
     * including nodes, subflows, and config nodes that are referenced by nodes on these tabs.
     */
    UI.getCurrentFlow = function(flowIds, opts) {
        let active = UI.getActiveWorkspaceId();
        let targetIds = [];
        if (flowIds && Array.isArray(flowIds) && flowIds.length > 0) {
            targetIds = flowIds;
        } else if (typeof flowIds === 'string' && flowIds.trim() !== '') {
            targetIds = [flowIds];
        } else if (active) {
            targetIds = [active];
        }
        return targetIds.length > 0 ? UI.getFlowsByIds(targetIds, opts) : null;
    };

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = UI;
})();
