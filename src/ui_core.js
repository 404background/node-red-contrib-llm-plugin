// UI core module — vanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    // Boot marker so the user can verify in devtools that the *latest*
    // ui_core.js is actually loaded (the editor or a proxy may cache).
    try { console.log('[LLM Plugin] ui_core.js loaded - clickable node refs enabled'); } catch (e) {}
    let UI = {};

    // Escape HTML special characters to prevent XSS
    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
            return html.replace(/href\s*=\s*(["'])\s*javascript:/gi, 'href=$1#blocked:');
        }

        return escapeHtml(text);
    }

    // Focus on a node — mirrors Node-RED's Debug sidebar exactly
    // (editor-client/src/js/ui/debug.js → showMessageNode):
    //
    //   if (n.z)           { RED.workspaces.show(n.z); }
    //   n.highlighted = true; n.dirty = true;
    //   RED.view.reveal(n.id);
    //   ... clear highlighted after ~10 s
    //
    // Config nodes have no canvas position, so they open their edit
    // dialog (RED.editor.editConfig) instead. Logs to the console so
    // the user can diagnose unresponsive clicks from devtools.
    function focusCanvasNode(nodeId) {
        try {
            if (!nodeId) { console.warn('[LLM Plugin] focusCanvasNode called with empty id'); return; }
            if (typeof RED === 'undefined' || !RED.nodes) {
                console.warn('[LLM Plugin] RED.nodes not available'); return;
            }
            let node = RED.nodes.node(nodeId);
            if (!node) {
                console.warn('[LLM Plugin] node not found:', nodeId);
                if (RED.notify) RED.notify('Node no longer exists', 'warning');
                return;
            }
            console.log('[LLM Plugin] focusCanvasNode →', { id: node.id, type: node.type, name: node.name, z: node.z });

            let hasCanvasPos = typeof node.x === 'number' && typeof node.y === 'number';
            if (!hasCanvasPos) {
                // Config node — open its edit dialog.
                if (RED.editor && typeof RED.editor.editConfig === 'function') {
                    try { RED.editor.editConfig('', node.type, node.id); return; }
                    catch (e) { console.warn('[LLM Plugin] editConfig failed:', e); }
                }
                if (RED.editor && typeof RED.editor.edit === 'function') {
                    try { RED.editor.edit(node); return; }
                    catch (e) { console.warn('[LLM Plugin] edit failed:', e); }
                }
                if (RED.notify) RED.notify('Cannot focus config "' + (node.name || node.id) + '"', 'warning');
                return;
            }

            // Canvas node — exactly the Debug-sidebar sequence.
            if (node.z && RED.workspaces && typeof RED.workspaces.show === 'function') {
                try { RED.workspaces.show(node.z); }
                catch (e) { console.warn('[LLM Plugin] workspaces.show failed:', e); }
            }
            try { node.highlighted = true; node.dirty = true; } catch (e) { /* ignore */ }

            if (!RED.view || typeof RED.view.reveal !== 'function') {
                console.warn('[LLM Plugin] RED.view.reveal not available');
                if (RED.notify) RED.notify('Cannot reveal node (RED.view.reveal missing)', 'error');
                return;
            }
            try { RED.view.reveal(node.id); }
            catch (e) { console.warn('[LLM Plugin] RED.view.reveal threw:', e); }

            // Force a redraw so the highlight flash is visible.
            if (RED.view && typeof RED.view.redraw === 'function') {
                try { RED.view.redraw(); } catch (e) { /* ignore */ }
            }
            // Brief toast confirms the click registered even if the
            // viewport jump is subtle.
            if (RED.notify) {
                RED.notify('Focused: ' + (node.name || node.type) +
                           ' (' + node.id + ')',
                           { type: 'info', timeout: 1500 });
            }
            // Clear the flash after ~2.5s so repeated clicks re-trigger.
            setTimeout(function() {
                try {
                    let live = RED.nodes.node(nodeId);
                    if (live) {
                        live.highlighted = false;
                        live.dirty = true;
                        if (RED.view && RED.view.redraw) RED.view.redraw();
                    }
                } catch (e) { /* ignore */ }
            }, 2500);
        } catch (e) {
            console.error('[LLM Plugin] focusCanvasNode error:', e);
        }
    }

    // Wire a code-like element so clicking it focuses the named node.
    // Inline styles act as a defence against a stale CSS cache: the
    // browser may have cached an older llm-plugin_styles.css without
    // the .llm-node-ref rules, so we set the same look directly on the
    // element to make sure it ALWAYS looks like a button.
    function attachNodeRefHandler(el, nodeId) {
        el.classList.add('llm-node-ref');
        el.setAttribute('data-node-id', nodeId);
        el.title = 'Click to focus on this node (Ctrl+click to also reveal)';
        el.style.cursor = 'pointer';
        el.style.background = '#dceefb';
        el.style.color = '#0a5cab';
        el.style.border = '1px solid #b6d8f2';
        el.style.borderRadius = '3px';
        el.style.padding = '1px 6px';
        el.style.userSelect = 'none';
        el.addEventListener('click', function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            let id = this.getAttribute('data-node-id');
            focusCanvasNode(id);
        });
    }

    // Pass 1: walk inline <code> elements (skipping <pre>) and resolve
    // each one against the live canvas via buildFlowLookup. Catches
    // explicit references like `inject_sensor`.
    //
    // Pass 2: walk text nodes (skipping <code>, <pre>, <a>, <script>,
    // <style>) and replace any token that exactly matches a known node
    // alias with a clickable inline code. The token set is restricted
    // to aliases (`{type}_{name}`), which always contain at least one
    // underscore, so false positives on regular English words are
    // effectively zero. The system prompt also instructs the LLM to
    // backtick-quote node references; this scan is a safety net for
    // when it forgets.
    function annotateNodeReferences(rootEl) {
        if (!rootEl) return;
        if (typeof RED === 'undefined' || !RED.nodes || typeof RED.nodes.eachNode !== 'function') return;
        if (!window.LLMPlugin || !LLMPlugin.LlmJsonParser ||
            typeof LLMPlugin.LlmJsonParser.buildFlowLookup !== 'function') return;

        let allNodes = [];
        try {
            RED.nodes.eachNode(function(n) { if (n) allNodes.push(n); });
            if (typeof RED.nodes.eachConfig === 'function') {
                RED.nodes.eachConfig(function(n) { if (n) allNodes.push(n); });
            }
        } catch (e) { return; }
        if (allNodes.length === 0) return;

        let cfg = LLMPlugin.FlowConverterCore || null;
        let lookup;
        try {
            lookup = LLMPlugin.LlmJsonParser.buildFlowLookup(allNodes, cfg);
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
        // Any alias that maps to a focusable node is eligible. We sort
        // longest-first so compound aliases (`change_temperature_series`)
        // win over their bare-type prefix (`change`) when both would
        // match the same span. Aliases shorter than 3 chars are skipped
        // — they're nearly always noise. Single-word aliases like
        // `inject` are kept because users frequently leave inject /
        // debug / function nodes unnamed.
        let aliases = Object.keys(aliasToId).filter(function(a) {
            return a.length >= 3 && isFocusable(aliasToId[a]);
        });
        if (aliases.length === 0) return;
        aliases.sort(function(a, b) { return b.length - a.length; });
        function escapeRe(s) { return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'); }
        let pattern;
        try {
            pattern = new RegExp('\\b(' + aliases.map(escapeRe).join('|') + ')\\b', 'g');
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

        let hits = 0;
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
                hits++;
            }
            if (lastIdx === 0) return;
            if (lastIdx < text.length) {
                frag.appendChild(document.createTextNode(text.slice(lastIdx)));
            }
            textNode.parentNode.replaceChild(frag, textNode);
        });
        if (hits > 0) {
            console.log('[LLM Plugin] annotated', hits,
                'plain-text aliases (of', aliases.length, 'known)');
        }
    }

    // Re-annotate every assistant message in the chat panel. The chat
    // panel can render historical messages BEFORE Node-RED finishes
    // populating RED.nodes (the side panel initializes early in the
    // editor's bootstrap), in which case the initial
    // annotateNodeReferences call finds an empty alias map and skips
    // silently. Hooking RED.events lets us catch up once nodes arrive,
    // and keeps existing badges in sync when the user edits / deploys.
    let _reannotateDebounce = null;
    function reannotateAllAssistantMessages() {
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return;
        let contents = chatArea.querySelectorAll('.assistant-message .message-content');
        for (let i = 0; i < contents.length; i++) {
            try { annotateNodeReferences(contents[i]); } catch (e) { /* per-msg ignore */ }
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
                        if (window.RED && RED.notify) RED.notify('Checkpoint restored', 'success');
                    } else if (window.RED && RED.notify) {
                        RED.notify((result && result.error) || 'Failed to restore checkpoint', 'error');
                    }
                })
                .catch(function(err) {
                    if (window.RED && RED.notify) RED.notify((err && err.message) || 'Failed to restore checkpoint', 'error');
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

                    let isVibeSchema = parsed.nodes && parsed.connections;
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
            try { annotateNodeReferences(messageContent); }
            catch (e) { console.warn('[LLM Plugin] annotateNodeReferences failed:', e); }
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
            retryIcon.className = 'fa fa-redo';
            retryIcon.setAttribute('aria-hidden', 'true');
            retryIcon.style.color = '#222';
            retryBtn.appendChild(retryIcon);
            retryBtn.title = 'Retry message';
            retryBtn.addEventListener('click', function() { UI.retryLastUserMessage(); });
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

    UI.retryLastUserMessage = function() {
        try {
            if (LLMPlugin.ChatManager) {
                let chatId = LLMPlugin.ChatManager.getCurrentChatId();
                let history = LLMPlugin.ChatManager.getChatHistory ? LLMPlugin.ChatManager.getChatHistory() : {};
                let chat = history[chatId];
                if (chat && chat.messages) {
                    let userMessages = chat.messages.filter(function(msg) { return msg.isUser; });
                    if (userMessages.length > 0) {
                        let lastUserMsg = userMessages[userMessages.length - 1];
                        let promptInput = document.getElementById('llm-plugin-prompt');
                        let generateBtn = document.getElementById('llm-plugin-generate');
                        if (promptInput && generateBtn) {
                            promptInput.value = lastUserMsg.content;
                            generateBtn.click();
                        }
                    }
                }
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
