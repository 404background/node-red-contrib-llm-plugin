// UI core module — vanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    let UI = {};
    let Common = window.LLMPlugin.Common;
    let escapeHtml = Common.escapeHtml;

    // Strip dangerous URL schemes from marked's output. A plain
    // href=~javascript: regex is trivially bypassed with HTML-entity
    // encoding (`javascript&colon;`, `&#106;avascript:`) which the browser
    // decodes on click — so we resolve each URL through the DOM (exactly
    // what the browser does) and drop anything outside a scheme allowlist.
    // This matters because the message renders in the editor, which holds
    // full RED admin privileges.
    let SAFE_URL_SCHEMES = { 'http:': 1, 'https:': 1, 'mailto:': 1, 'tel:': 1 };
    function sanitizeRenderedHtml(html) {
        let holder = document.createElement('div');
        holder.innerHTML = html;
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

    // Focus a node like the Debug sidebar does (show tab, highlight,
    // RED.view.reveal, clear highlight after a delay). Config nodes have
    // no canvas position, so they open their edit dialog instead.
    function focusCanvasNode(nodeId) {
        try {
            if (!nodeId || typeof RED === 'undefined' || !RED.nodes) return;
            let node = RED.nodes.node(nodeId);
            if (!node) {
                Common.notify('Node no longer exists', 'warning');
                return;
            }

            let hasCanvasPos = typeof node.x === 'number' && typeof node.y === 'number';
            if (!hasCanvasPos) {
                if (RED.editor && typeof RED.editor.editConfig === 'function') {
                    try { RED.editor.editConfig('', node.type, node.id); return; } catch (e) {}
                }
                if (RED.editor && typeof RED.editor.edit === 'function') {
                    try { RED.editor.edit(node); return; } catch (e) {}
                }
                Common.notify('Cannot focus config "' + (node.name || node.id) + '"', 'warning');
                return;
            }

            if (node.z && RED.workspaces && typeof RED.workspaces.show === 'function') {
                try { RED.workspaces.show(node.z); } catch (e) {}
            }
            try { node.highlighted = true; node.dirty = true; } catch (e) {}

            if (RED.view && typeof RED.view.reveal === 'function') {
                try { RED.view.reveal(node.id); } catch (e) {}
            }
            if (RED.view && typeof RED.view.redraw === 'function') {
                try { RED.view.redraw(); } catch (e) {}
            }
            setTimeout(function() {
                try {
                    let live = RED.nodes.node(nodeId);
                    if (live) {
                        live.highlighted = false;
                        live.dirty = true;
                        if (RED.view && RED.view.redraw) RED.view.redraw();
                    }
                } catch (e) {}
            }, 2500);
        } catch (e) {
            // Swallow silently — focus is a best-effort UX affordance.
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

    // Make node references in an assistant message clickable.
    // Pass 1: inline <code> elements (outside <pre>) resolved via
    // buildFlowLookup. Pass 2: plain-text tokens that exactly match a
    // known alias (safety net when the LLM forgets to backtick-quote).
    //
    // Alias → ID determinism: toIntermediate numbers duplicate aliases by
    // iteration order, so `change_2` only resolves correctly if the alias
    // map is built from the SAME node list the LLM saw. With targetFlowIds
    // we therefore reuse UI.getFlowsByIds (the function that produced the
    // LLM context); unscoped messages fall back to scanning every node.
    function annotateNodeReferences(rootEl, targetFlowIds) {
        if (!rootEl) return;
        if (typeof RED === 'undefined' || !RED.nodes || typeof RED.nodes.eachNode !== 'function') return;
        if (!window.LLMPlugin || !LLMPlugin.LLMJsonParser ||
            typeof LLMPlugin.LLMJsonParser.buildFlowLookup !== 'function') return;

        let scoped = Array.isArray(targetFlowIds) && targetFlowIds.length > 0;
        let allNodes = null;
        if (scoped && typeof UI.getFlowsByIds === 'function') {
            try { allNodes = UI.getFlowsByIds(targetFlowIds); } catch (e) { allNodes = null; }
        }
        if (!Array.isArray(allNodes) || allNodes.length === 0) {
            allNodes = [];
            try {
                RED.nodes.eachNode(function(n) { if (n) allNodes.push(n); });
                if (typeof RED.nodes.eachConfig === 'function') {
                    RED.nodes.eachConfig(function(n) { if (n) allNodes.push(n); });
                }
            } catch (e) { return; }
        }
        if (allNodes.length === 0) return;

        let cfg = LLMPlugin.FlowConverterCore || null;
        let lookup;
        try {
            lookup = LLMPlugin.LLMJsonParser.buildFlowLookup(allNodes, cfg);
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

        let TreeWalker = window.NodeFilter && document.createTreeWalker;
        if (!TreeWalker) return;
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
        let btn = document.createElement('button');
        btn.className = 'restore-btn';
        btn.textContent = 'Restore Checkpoint';
        btn.dataset.checkpointId = checkpointId;
        btn.addEventListener('click', function() {
            let cpId = btn.dataset.checkpointId;
            if (!cpId || !LLMPlugin.Importer) return;
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
            let messageActions = document.createElement('div');
            messageActions.className = 'message-actions';
            let retryBtn = document.createElement('button');
            retryBtn.className = 'retry-btn';
            let retryIcon = document.createElement('i');
            // fa-refresh, not fa-redo: the editor bundles Font Awesome 4.7
            // (offline) and fa-redo only exists in FA 5.
            retryIcon.className = 'fa fa-refresh';
            retryIcon.setAttribute('aria-hidden', 'true');
            retryIcon.style.color = '#222';
            retryBtn.appendChild(retryIcon);
            retryBtn.title = 'Retry message';
            retryBtn.addEventListener('click', function() { UI.retryLastUserMessage(messageMeta); });
            messageActions.appendChild(retryBtn);
            message.appendChild(messageActions);
        }

        if (!isUser) {
            try {
                let flowNodes = LLMPlugin.Importer ? LLMPlugin.Importer.extractFlowNodes(content) : null;
                let hasDirectivesOnly = !flowNodes || flowNodes.length === 0
                    ? !!(LLMPlugin.Importer && LLMPlugin.Importer.hasFlowDirectives(content))
                    : false;
                if ((flowNodes && flowNodes.length > 0) || hasDirectivesOnly) {
                    let flowActions = document.createElement('div');
                    flowActions.className = 'flow-actions';
                    let importBtn = document.createElement('button');
                    importBtn.className = 'import-btn';
                    importBtn.textContent = 'Import Flow';
                    
                    let isAgent = messageMeta && messageMeta.meta && messageMeta.meta.mode === 'agent';
                    if (isAgent) importBtn.style.display = 'none';

                    importBtn.addEventListener('click', function() {
                        if (!LLMPlugin.Importer) return;
                        importBtn.disabled = true;
                        let chatId = LLMPlugin.ChatManager ? LLMPlugin.ChatManager.getCurrentChatId() : null;
                        let targetFlowIds = (messageMeta && messageMeta.meta && Array.isArray(messageMeta.meta.targetFlowIds))
                            ? messageMeta.meta.targetFlowIds
                            : null;

                        // Capture the checkpoint immediately before the
                        // import so the Restore button always points at the
                        // true pre-edit state. If the save fails we still
                        // run the import (just with no Restore button).
                        let checkpointPromise = (LLMPlugin.ChatManager && LLMPlugin.ChatManager.saveImportCheckpoint)
                            ? LLMPlugin.ChatManager.saveImportCheckpoint(chatId, targetFlowIds)
                            : Promise.resolve(null);

                        checkpointPromise.then(function(checkpointId) {
                            return LLMPlugin.Importer.importFlowFromMessage(content, {
                                chatId: chatId,
                                mode: (messageMeta && messageMeta.meta && messageMeta.meta.mode) ? messageMeta.meta.mode : 'ask'
                            }).then(function(result) {
                                return { result: result, checkpointId: checkpointId };
                            });
                        })
                        .then(function(combined) {
                            let result = combined.result;
                            let checkpointId = combined.checkpointId;
                            if (!result || !result.ok) return;
                            if (checkpointId) {
                                let preChatActions = message.querySelector('.pre-chat-actions');
                                if (!preChatActions) {
                                    preChatActions = document.createElement('div');
                                    preChatActions.className = 'flow-actions pre-chat-actions';
                                    preChatActions.style.marginTop = '0';
                                    preChatActions.style.marginBottom = '10px';
                                    message.insertBefore(preChatActions, message.firstChild);
                                }
                                preChatActions.querySelectorAll('.restore-btn').forEach(function(b) { b.remove(); });
                                preChatActions.appendChild(createRestoreCheckpointButton(checkpointId));
                                if (messageMeta && messageMeta.id && LLMPlugin.ChatManager) {
                                    LLMPlugin.ChatManager.updateMessageMeta(messageMeta.id, {
                                        pluginEdited: true,
                                        checkpointId: checkpointId
                                    });
                                }
                            }
                        })
                        .catch(function() { /* import errors already surfaced */ })
                        .finally(function() {
                            importBtn.disabled = false;
                        });
                    });
                    flowActions.appendChild(importBtn);

                    // Rebuild restore button for previously edited plugin messages.
                    let existingCheckpointId = messageMeta && messageMeta.meta && messageMeta.meta.pluginEdited
                        ? messageMeta.meta.checkpointId
                        : null;
                    if (existingCheckpointId) {
                        let preChatActions = document.createElement('div');
                        preChatActions.className = 'flow-actions pre-chat-actions';
                        preChatActions.style.marginTop = '0';
                        preChatActions.style.marginBottom = '10px';
                        preChatActions.appendChild(createRestoreCheckpointButton(existingCheckpointId));
                        message.insertBefore(preChatActions, message.firstChild);
                    }

                    message.appendChild(flowActions);
                }
            } catch (e) {}
        }

        chatArea.appendChild(message);
        chatArea.scrollTop = chatArea.scrollHeight;
        return message;
    };

    UI.formatMessage = formatMessage;
    UI.focusCanvasNode = focusCanvasNode;
    UI.annotateNodeReferences = annotateNodeReferences;
    UI.reannotateAllAssistantMessages = reannotateAllAssistantMessages;

    UI.retryLastUserMessage = function(messageMeta) {
        try {
            if (!LLMPlugin.ChatManager) return;
            let chatId = LLMPlugin.ChatManager.getCurrentChatId();
            let history = LLMPlugin.ChatManager.getChatHistory ? LLMPlugin.ChatManager.getChatHistory() : {};
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

            if (checkpointId && LLMPlugin.Importer && typeof LLMPlugin.Importer.restoreCheckpoint === 'function') {
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

    UI.getFlowsByIds = function(flowIds) {
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
            if (nodes.length === 0) return null;

            let configNodes = collectReferencedConfigs(nodes, seenIds);
            let allNodes = nodes.concat(configNodes);

            return RED.nodes.createExportableNodeSet(allNodes);
        } catch (error) {
            console.error('Error getting flows by ids:', error);
            return null;
        }
    };

    function collectReferencedConfigs(nodes, seenIds) {
        let configNodes = [];
        let referencedIds = {};

        // Find which config node IDs are actually referenced by the targeted canvas nodes
        nodes.forEach(function(n) {
            Object.keys(n).forEach(function(k) {
                if (k === 'id' || k === 'z' || k === 'type' || k === 'wires' || k === 'x' || k === 'y') return;
                if (typeof n[k] === 'string' && n[k].length > 5) {
                    referencedIds[n[k]] = true;
                }
            });
        });

        if (RED.nodes.eachConfig) {
            RED.nodes.eachConfig(function(cn) {
                // Include config nodes ONLY if they are explicitly referenced
                if (cn && (!seenIds || !seenIds[cn.id]) && referencedIds[cn.id]) {
                    configNodes.push(cn);
                    seenIds[cn.id] = true;
                }
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
    UI.getCurrentFlow = function(flowIds) {
        let active = UI.getActiveWorkspaceId();
        let targetIds = [];
        if (flowIds && Array.isArray(flowIds) && flowIds.length > 0) {
            targetIds = flowIds;
        } else if (typeof flowIds === 'string' && flowIds.trim() !== '') {
            targetIds = [flowIds];
        } else if (active) {
            targetIds = [active];
        }
        return targetIds.length > 0 ? UI.getFlowsByIds(targetIds) : null;
    };

    UI.createRestoreCheckpointButton = createRestoreCheckpointButton;

    window.LLMPlugin = window.LLMPlugin || {};
    window.LLMPlugin.UI = UI;
})();
