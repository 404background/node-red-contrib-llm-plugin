// UI core module — vanilla JS (no jQuery).
// Handles message rendering, flow context export, and retry logic.
(function(){
    let UI = {};
    // client.js loads these before this file.
    let Common = window.LLMPlugin.Common;
    let Converter = window.LLMPlugin.FlowConverterCore;
    let Parser = window.LLMPlugin.LLMJsonParser;
    let escapeHtml = Common.escapeHtml;

    // Messages render inside the editor, which holds admin privileges. URLs
    // are resolved through the DOM, not matched by regex — entity encoding
    // defeats a regex. See docs/{en,jp}/architecture.md — Security measures.
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

    // Raw HTML in a reply is text, not markup. Escaping it here rather than in
    // the source text is what keeps marked's own escaping of code off it: a
    // pre-escaped `&gt;` came back out of a code block as a visible `&gt;`.
    let _renderer = null;
    function markdownRenderer() {
        if (_renderer || typeof marked.Renderer !== 'function') return _renderer;
        _renderer = new marked.Renderer();
        _renderer.html = function(token) {
            return escapeHtml((token && token.text) || '');
        };
        return _renderer;
    }

    function formatMessage(text) {
        // Run with marked.js (assumed present in modern Node-RED environments)
        if (typeof marked !== 'undefined' && marked.parse) {
            let raw = String(text || '').trim();
            // A reply that is nothing but JSON: its indented lines are not
            // prose, so it goes to collapseJsonBlocks as one block instead.
            if (raw.charAt(0) === '{' || raw.charAt(0) === '[') {
                let read = Parser.parseJsonBlock(raw);
                if (read && read.value && typeof read.value === 'object') {
                    return '<pre><code class="language-json">' +
                        escapeHtml(raw) + '</code></pre>';
                }
            }

            let renderer = markdownRenderer();
            let html = renderer ? marked.parse(raw, { renderer: renderer })
                                : marked.parse(raw.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
            return sanitizeRenderedHtml(html);
        }

        return escapeHtml(text);
    }

    // Focus a node the way the Debug sidebar does; config nodes have no
    // position, so they open their dialog instead. Best effort throughout.
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

    // Node references -> clickable: pass 1 over inline <code>, pass 2 over
    // plain text. The alias map must come from the same node list the model
    // saw, or a numbered alias points at a different node.
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
                        // SUMMARY too: a node ref found in a fold's label would
                        // swallow the click that opens it.
                        if (tag === 'CODE' || tag === 'PRE' || tag === 'A' ||
                            tag === 'SUMMARY' || tag === 'SCRIPT' || tag === 'STYLE') {
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

    // Historical messages can render before RED.nodes is populated, so the
    // editor's events catch up and keep annotations in sync.
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
        // flows:loaded fires once; the rest keep annotations fresh as the
        // user edits, deploys and visits tabs.
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

    // A stored chat message keeps its per-turn facts under `.meta`; every
    // read has to survive a message saved before the field existed.
    function metaOf(messageMeta) {
        return (messageMeta && messageMeta.meta) ? messageMeta.meta : {};
    }

    function targetFlowIdsOf(messageMeta) {
        let ids = metaOf(messageMeta).targetFlowIds;
        return Array.isArray(ids) ? ids : null;
    }

    function jsonBlockSummary(parsed, repaired) {
        let label = 'JSON';
        if (Converter.isVibeSchema(parsed)) label = 'Vibe Schema JSON';
        else if (Array.isArray(parsed)) label = 'Flow JSON (' + parsed.length + ' nodes)';
        // Say so: the block below is then the repaired reading, not the text
        // the model sent, and that is what the import will use.
        return repaired ? label + ' (repaired)' : label;
    }

    // Fold a JSON block into <details> so the prose around it stays readable.
    // It folds on the same reading the importer uses, repairs included — a
    // block the model broke is the one a reader most needs to get out of the
    // way, so a `json` block that cannot be read at all folds too.
    function foldJsonBlock(pre) {
        let codeEl = pre.querySelector('code') || pre;
        let text = codeEl.textContent || '';
        let labelled = codeEl.classList && codeEl.classList.contains('language-json');
        if (!labelled && !/^\s*[[{]/.test(text)) return;

        let read = Parser.parseJsonBlock(text);
        let parsed = read && read.value;
        let summaryText;
        if (parsed && typeof parsed === 'object') {
            let display = parsed;
            // A description inside the JSON is prose, so lift it out of the
            // block the reader would have to expand to find it.
            if (Converter.isVibeSchema(parsed) && typeof parsed.description === 'string') {
                let descPara = document.createElement('p');
                descPara.textContent = parsed.description;
                pre.parentNode.insertBefore(descPara, pre);
                display = JSON.parse(JSON.stringify(parsed));
                delete display.description;
            }
            codeEl.textContent = JSON.stringify(display, null, 2);
            summaryText = jsonBlockSummary(parsed, read.repaired);
        } else {
            if (!labelled) return;
            summaryText = 'JSON (could not be read)';
        }

        let summary = document.createElement('summary');
        summary.textContent = summaryText;
        let details = document.createElement('details');
        details.className = 'json-collapsible';
        // The Apply Again button hangs off THIS block, so the control that
        // applies the proposal sits with the proposal itself.
        if (parsed && Converter.isVibeSchema(parsed)) details.dataset.vibeSchema = 'true';
        pre.parentNode.insertBefore(details, pre);
        details.appendChild(summary);
        details.appendChild(pre);
    }

    function collapseJsonBlocks(container) {
        let codeBlocks = container.querySelectorAll('pre');
        for (let i = 0; i < codeBlocks.length; i++) {
            if (codeBlocks[i].parentNode) foldJsonBlock(codeBlocks[i]);
        }
    }

    // `ask / gpt-4o / → Flow 1 / 1.5s` under an assistant reply. The mode and
    // model are worth keeping visible after a mid-conversation switch.
    function buildElapsedBadge(meta) {
        if (typeof meta.elapsedMs !== 'number' || !isFinite(meta.elapsedMs)) return null;

        let parts = [];
        if (meta.mode === 'ask' || meta.mode === 'agent') parts.push(meta.mode);
        if (meta.model && typeof meta.model === 'string') parts.push(meta.model);
        if (meta.targetFlowName && typeof meta.targetFlowName === 'string') {
            parts.push('→ ' + meta.targetFlowName);
        }
        parts.push((meta.elapsedMs / 1000).toFixed(1) + 's');

        let elapsed = document.createElement('div');
        elapsed.className = 'message-elapsed';
        elapsed.textContent = parts.join(' / ');
        return elapsed;
    }

    // The two halves of the same choice, each placed where it acts: Restore
    // goes above the PROMPT, so everything below it is what gets rewound, and
    // Apply Again rides on the schema block, so the control that applies a
    // proposal sits with the proposal. In Agent mode the Import button below
    // the message is hidden, which makes Apply Again the only way back to a
    // proposal once it has been rewound.
    function showPostImportActions(message, checkpointId, content, messageMeta) {
        placeRestoreAboveThePrompt(message, checkpointId, messageMeta);
        placeReapplyOnTheSchema(message, content, messageMeta);
    }

    // The prompt this reply answered — the first user message above it. Two
    // replies in a row (a retry) have no prompt between them, so the walk
    // stops at the previous reply rather than claiming an older prompt.
    function promptAbove(message) {
        let prev = message.previousElementSibling;
        while (prev && prev.classList) {
            if (prev.classList.contains('user-message')) return prev;
            if (prev.classList.contains('assistant-message')) return null;
            prev = prev.previousElementSibling;
        }
        return null;
    }

    function placeRestoreAboveThePrompt(message, checkpointId, messageMeta) {
        let messageId = (messageMeta && messageMeta.id) || '';
        let anchor = promptAbove(message) || message;
        let parent = anchor.parentNode;
        if (!parent) return;

        // One bar per reply, wherever it was last put.
        let selector = messageId
            ? '.pre-chat-actions[data-restore-for="' + messageId + '"]'
            : null;
        if (selector && parent.querySelectorAll) {
            parent.querySelectorAll(selector).forEach(function(b) { b.remove(); });
        }
        message.querySelectorAll('.pre-chat-actions').forEach(function(b) { b.remove(); });

        let bar = Common.cloneTemplate('llm-plugin-pre-chat-actions-template');
        if (messageId) bar.dataset.restoreFor = messageId;
        bar.appendChild(createRestoreCheckpointButton(checkpointId));
        parent.insertBefore(bar, anchor);
    }

    function placeReapplyOnTheSchema(message, content, messageMeta) {
        message.querySelectorAll('.reapply-btn').forEach(function(b) { b.remove(); });
        let summary = message.querySelector('.json-collapsible[data-vibe-schema] > summary');
        // No schema block to hang it on (a reply carrying only directives, or
        // one whose JSON could not be read): the actions row below keeps it
        // reachable.
        let host = summary || message.querySelector('.flow-actions:not(.pre-chat-actions)');
        if (!host) return;
        host.appendChild(createReapplyButton(message, content, messageMeta));
    }

    function createReapplyButton(message, content, messageMeta) {
        let btn = Common.cloneTemplate('llm-plugin-reapply-btn-template');
        btn.addEventListener('click', function(e) {
            // Inside a <summary>, a click is the disclosure toggle unless it
            // is stopped here.
            e.preventDefault();
            e.stopPropagation();
            btn.disabled = true;
            queueImport(message, content, messageMeta, 'Apply Again')
                .catch(reportImportFailure)
                .finally(function() { btn.disabled = false; });
        });
        return btn;
    }

    // One import turn, run as the queue's `apply`. The checkpoint is taken
    // here rather than at click time: earlier it would snapshot a flow the
    // apply ahead of this one is about to change.
    function applyImport(message, content, messageMeta, chatId) {
        let targetFlowIds = targetFlowIdsOf(messageMeta);
        return LLMPlugin.ChatManager.saveImportCheckpoint(chatId, targetFlowIds)
            .then(function(checkpointId) {
                return LLMPlugin.Importer.importFlowFromMessage(content, {
                    chatId: chatId,
                    mode: metaOf(messageMeta).mode || 'ask',
                    // The same set the checkpoint covers, so Restore can
                    // always undo what the import did.
                    allowedWorkspaceIds: targetFlowIds
                }).then(function(result) {
                    if (result && result.ok && checkpointId) {
                        showPostImportActions(message, checkpointId, content, messageMeta);
                        if (messageMeta && messageMeta.id) {
                            LLMPlugin.ChatManager.updateMessageMeta(messageMeta.id, {
                                pluginEdited: true,
                                checkpointId: checkpointId
                            });
                        }
                    }
                    // The importer's result: the queue reads `ok` off it.
                    return result;
                });
            });
    }

    // Every import goes through the queue: an undeployed edit on these flows
    // holds this one. See design.md §13. The chat id is read HERE, not inside
    // `apply`, because the turn may run after the user has moved to another
    // chat.
    function queueImport(message, content, messageMeta, label) {
        let chatId = LLMPlugin.ChatManager.getCurrentChatId();
        return LLMPlugin.ApplyQueue.enqueue({
            source: 'sidebar',
            label: label,
            targetFlowIds: targetFlowIdsOf(messageMeta),
            apply: function() {
                return applyImport(message, content, messageMeta, chatId);
            }
        });
    }

    // The importer reports its own errors. The queue's own outcomes have no
    // other reporter.
    function reportImportFailure(err) {
        if (err && /Cancelled/.test(err.message || '')) {
            Common.notify('Import cancelled', 'warning');
        } else if (err && err.queueError) {
            Common.notify('Import did not run: ' + (err.message || err), 'error');
        } else if (err && window.console) {
            // The apply itself reports its own failures, so anything else
            // here happened after it.
            console.error('[LLM Plugin] after the import:', err);
        }
    }

    function appendFlowActions(message, content, messageMeta) {
        let flowNodes = LLMPlugin.Importer.extractFlowNodes(content);
        let carriesFlow = (flowNodes && flowNodes.length > 0) ||
            LLMPlugin.Importer.hasFlowDirectives(content);
        if (!carriesFlow) return;

        let flowActions = Common.cloneTemplate('llm-plugin-flow-actions-template');
        let importBtn = flowActions.querySelector('.import-btn');
        // Agent mode clicks this button itself, so showing it would only
        // invite a second apply of the same reply.
        if (metaOf(messageMeta).mode === 'agent') importBtn.style.display = 'none';

        importBtn.addEventListener('click', function() {
            importBtn.disabled = true;
            queueImport(message, content, messageMeta, 'Import Flow')
                .catch(reportImportFailure)
                .finally(function() { importBtn.disabled = false; });
        });

        // A message whose import already ran keeps both: rewind, or apply it
        // again. Restored on reload from the stored meta, so the pair survives
        // a chat being re-opened.
        let meta = metaOf(messageMeta);
        if (meta.pluginEdited && meta.checkpointId) {
            showPostImportActions(message, meta.checkpointId, content, messageMeta);
        }
        message.appendChild(flowActions);
    }

    UI.addMessageToUI = function(content, isUser, messageMeta) {
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return null;

        let message = document.createElement('div');
        message.className = 'llm-plugin-message ' + (isUser ? 'user-message' : 'assistant-message');
        if (messageMeta && messageMeta.id) message.dataset.messageId = messageMeta.id;

        // Keep the flow IDs sent as LLM context with this message, so
        // reannotateAllAssistantMessages can rescope alias resolution after
        // later events (flows:loaded, deploy, etc.).
        let targetFlowIds = targetFlowIdsOf(messageMeta);
        if (targetFlowIds && targetFlowIds.length > 0) {
            try { message.dataset.targetFlowIds = JSON.stringify(targetFlowIds); } catch (e) {}
        }

        let messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.innerHTML = formatMessage(content);
        collapseJsonBlocks(messageContent);
        message.appendChild(messageContent);

        if (!isUser) {
            // The immediate call wins once RED.nodes is populated; the
            // flows-loaded hook covers the cold-start race.
            try { annotateNodeReferences(messageContent, targetFlowIds); } catch (e) {}

            let badge = buildElapsedBadge(metaOf(messageMeta));
            if (badge) message.appendChild(badge);
        }

        chatArea.appendChild(message);

        // After the message is in the chat, not before: the Restore bar goes
        // above the PROMPT, which means reaching the message's neighbours.
        if (!isUser) {
            try {
                appendFlowActions(message, content, messageMeta);
            } catch (e) {
                // A malformed reply may legitimately fail to parse, but a
                // missing template throws here too and must not vanish.
                if (window.console) console.error('[LLM Plugin] flow actions not rendered:', e);
            }
        }
        UI.refreshRetryButton();
        chatArea.scrollTop = chatArea.scrollHeight;
        return message;
    };

    function findChatMessage(messageId) {
        if (!messageId) return null;
        try {
            let history = LLMPlugin.ChatManager.getChatHistory();
            let chat = history[LLMPlugin.ChatManager.getCurrentChatId()];
            if (!chat || !chat.messages) return null;
            for (let i = chat.messages.length - 1; i >= 0; i--) {
                if (chat.messages[i].id === messageId) return chat.messages[i];
            }
        } catch (e) {}
        return null;
    }

    // Retry re-sends the last user prompt, so only the last message can
    // carry the button. Placed here rather than at render time so a
    // reloaded history, a failed turn and a cancelled one get it too.
    UI.refreshRetryButton = function() {
        let chatArea = document.getElementById('llm-plugin-chat');
        if (!chatArea) return;
        chatArea.querySelectorAll('.message-actions').forEach(function(el) { el.remove(); });

        let messages = chatArea.querySelectorAll('.llm-plugin-message');
        let last = messages.length > 0 ? messages[messages.length - 1] : null;
        if (!last || last.classList.contains('loading-message')) return;

        let messageMeta = findChatMessage(last.dataset.messageId);
        let messageActions = Common.cloneTemplate('llm-plugin-message-actions-template');
        messageActions.querySelector('.retry-btn')
            .addEventListener('click', function() { UI.retryLastUserMessage(messageMeta); });

        // Above the Import button, where it has always sat.
        let flowActions = last.querySelector('.flow-actions:not(.pre-chat-actions)');
        if (flowActions) last.insertBefore(messageActions, flowActions);
        else last.appendChild(messageActions);
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
            let checkpointId = metaOf(messageMeta).checkpointId;

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

            // filterNodes returns neither, so a caller has to opt in.
            // `includeCanvasExtras` (junctions AND groups) is for a caller that
            // will REBUILD the flow; `includeGroups` is the LLM-context path,
            // which needs to see the boxes it may extend but not junctions.
            // Groups leave node aliases alone either way — the converter gives
            // them a map of their own. See docs/{en,jp}/vibe-schema.md.
            if (opts && (opts.includeCanvasExtras || opts.includeGroups)) {
                let withJunctions = !!(opts && opts.includeCanvasExtras);
                ids.forEach(function(zid) {
                    let extras = withJunctions ? (RED.nodes.junctions(zid) || []) : [];
                    extras = extras.concat(RED.nodes.groups(zid) || []);
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
