(function () {
    var HOTKEY_CODE = "Backquote";

    function createUI() {
        if (document.getElementById("barrahome-terminal-window")) return;

        var style = document.createElement("style");
        style.textContent =
            "" +
            ".barrahome-terminal-window{position:fixed;top:84px;left:220px;width:min(860px,92vw);height:min(520px,75vh);z-index:9999;background:#aeb2c3;border-top:3px solid #d4d7e3;border-left:3px solid #d4d7e3;border-right:3px solid #6b6e7a;border-bottom:3px solid #6b6e7a;display:flex;flex-direction:column;}" +
            ".barrahome-terminal-window.hidden{display:none;}" +
            ".barrahome-terminal-titlebar{background:#b24d7a;color:#fff;padding:4px 8px;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;border-top:2px solid #d888a8;border-left:2px solid #d888a8;border-right:2px solid #6e2f4c;border-bottom:2px solid #6e2f4c;}" +
            ".barrahome-terminal-toolbar{display:flex;gap:8px;align-items:center;padding:6px;background:#9a9eae;color:#1a1a2e;font-size:12px;}" +
            ".barrahome-terminal-log{flex:1;background:#2f3a44;color:#e0e0e0;padding:10px;overflow:auto;font-family:monospace;font-size:13px;}" +
            ".barrahome-terminal-msg{margin:0 0 10px 0;white-space:pre-wrap;}" +
            ".barrahome-terminal-msg.user{color:#f0d080;}" +
            ".barrahome-terminal-msg.system{color:#d8e4ef;}" +
            ".barrahome-terminal-composer{padding:8px;background:#556573;border-top:2px solid #3d4a56;display:flex;gap:8px;}" +
            ".barrahome-terminal-input{flex:1;background:#d8dbe6;color:#111;border:1px solid #6b6e7a;font-family:monospace;font-size:13px;padding:6px;resize:none;}" +
            ".barrahome-terminal-btn{background:#b24d7a;color:#fff;border-top:2px solid #d888a8;border-left:2px solid #d888a8;border-right:2px solid #6e2f4c;border-bottom:2px solid #6e2f4c;padding:4px 10px;cursor:pointer;font-family:monospace;font-size:12px;}" +
            ".barrahome-terminal-status{padding:3px 8px;background:#4a5868;color:#d0d0d0;font-size:11px;font-family:monospace;}" +
            ".barrahome-terminal-cursor{display:inline-block;margin-left:1px;color:#f0d080;animation:barrahome-blink 1s steps(1) infinite;}" +
            "@keyframes barrahome-blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}" +
            ".barrahome-terminal-log p{margin:0 0 8px 0;}" +
            ".barrahome-terminal-log h1,.barrahome-terminal-log h2,.barrahome-terminal-log h3,.barrahome-terminal-log h4,.barrahome-terminal-log h5,.barrahome-terminal-log h6{margin:6px 0;font-weight:bold;color:#f0d080;white-space:normal;}" +
            ".barrahome-terminal-log h1{font-size:15px;}" +
            ".barrahome-terminal-log h2{font-size:14px;}" +
            ".barrahome-terminal-log h3,.barrahome-terminal-log h4,.barrahome-terminal-log h5,.barrahome-terminal-log h6{font-size:13px;}" +
            ".barrahome-terminal-log ul,.barrahome-terminal-log ol{margin:2px 0 8px 20px;padding:0;white-space:normal;}" +
            ".barrahome-terminal-log li{margin:2px 0;}" +
            ".barrahome-terminal-log code{background:#232b33;color:#e0e0e0;border-top:1px solid #171d23;border-left:1px solid #171d23;border-right:1px solid #3d4a56;border-bottom:1px solid #3d4a56;padding:0 3px;font-family:monospace;white-space:pre-wrap;}" +
            ".barrahome-terminal-log pre{background:#232b33;color:#e0e0e0;border-top:2px solid #171d23;border-left:2px solid #171d23;border-right:2px solid #3d4a56;border-bottom:2px solid #3d4a56;padding:6px 8px;margin:2px 0 8px 0;overflow:auto;white-space:pre;font-family:monospace;}" +
            ".barrahome-terminal-log pre code{background:none;border:none;padding:0;white-space:pre;}" +
            ".barrahome-terminal-log table{border-collapse:collapse;margin:2px 0 8px 0;background:#2f3a44;white-space:normal;}" +
            ".barrahome-terminal-log th,.barrahome-terminal-log td{border:1px solid #55606c;padding:3px 6px;text-align:left;font-size:12px;vertical-align:top;}" +
            ".barrahome-terminal-log th{background:#455363;color:#f4f4f4;}" +
            ".barrahome-terminal-log a{color:#7ec8e3;text-decoration:underline;}" +
            ".barrahome-terminal-log a:hover{color:#b24d7a;}" +
            ".barrahome-terminal-chip{display:inline-block;margin:0 2px;padding:1px 8px;background:#b24d7a;color:#fff;font-family:monospace;font-size:12px;cursor:pointer;border-top:2px solid #d888a8;border-left:2px solid #d888a8;border-right:2px solid #6e2f4c;border-bottom:2px solid #6e2f4c;}" +
            ".barrahome-terminal-chip:hover:not(:disabled){background:#c25f8c;}" +
            ".barrahome-terminal-chip:disabled,.barrahome-terminal-chip.used{cursor:default;background:#6e5560;color:#cbb7c0;border-top:2px solid #5a4550;border-left:2px solid #5a4550;border-right:2px solid #8a6d78;border-bottom:2px solid #8a6d78;}";
        document.head.appendChild(style);

        var win = document.createElement("section");
        win.id = "barrahome-terminal-window";
        win.className = "barrahome-terminal-window hidden";

        var titlebar = document.createElement("div");
        titlebar.className = "barrahome-terminal-titlebar";
        titlebar.innerHTML =
            '<span>barrahome Terminal</span><button type="button" id="barrahome-terminal-close" class="barrahome-terminal-btn">X</button>';

        var toolbar = document.createElement("div");
        toolbar.className = "barrahome-terminal-toolbar";
        toolbar.innerHTML = "<span>Mode: Agent</span><span>Hotkey: `</span>";

        var log = document.createElement("div");
        log.className = "barrahome-terminal-log";

        var composer = document.createElement("div");
        composer.className = "barrahome-terminal-composer";
        composer.innerHTML =
            '<textarea id="barrahome-terminal-input" class="barrahome-terminal-input" rows="3" placeholder="Type here..."></textarea>' +
            '<button type="button" id="barrahome-terminal-send" class="barrahome-terminal-btn">Send</button>';

        var status = document.createElement("div");
        status.className = "barrahome-terminal-status";
        status.textContent = "Ready.";

        win.appendChild(titlebar);
        win.appendChild(toolbar);
        win.appendChild(log);
        win.appendChild(composer);
        win.appendChild(status);
        document.body.appendChild(win);

        var promptInput = document.getElementById("barrahome-terminal-input");
        var sendBtn = document.getElementById("barrahome-terminal-send");
        var closeBtn = document.getElementById("barrahome-terminal-close");

        function addLog(role, content) {
            var row = document.createElement("div");
            row.className = "barrahome-terminal-msg " + role;
            row.textContent = (role === "user" ? "> " : "system> ") + content;
            log.appendChild(row);
            log.scrollTop = log.scrollHeight;
        }

        // ---------------------------------------------------------------
        // Markdown rendering.
        //
        // Model output and tool output (which includes blog post content)
        // are both untrusted. The safety property this code relies on is
        // ordering: escapeHtml() runs first, over the raw text, before any
        // markdown transform touches it. Every transform after that point
        // only wraps already-escaped text in literal tags we author
        // ourselves - it never re-escapes or unescapes anything, so a
        // hostile "<script>" or "onerror=" in the source can never become
        // a live tag or attribute. Raw model/tool text must never reach
        // innerHTML directly; it only gets there through this pipeline.
        // ---------------------------------------------------------------

        function escapeHtml(s) {
            return String(s)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        }

        function isTableSeparator(line) {
            var t = line.trim();
            if (!t || !/^[|\s:-]+$/.test(t)) return false;
            return t.indexOf("-") !== -1;
        }

        function splitTableRow(row) {
            var t = row.trim();
            if (t.charAt(0) === "|") t = t.slice(1);
            if (t.charAt(t.length - 1) === "|") t = t.slice(0, -1);
            return t.split("|").map(function (c) {
                return c.trim();
            });
        }

        // Workspace-relative post references: YYYY/MM/DD/slug.md, with an
        // optional leading slash. Matched on the path shape only (never on
        // titles, which are unreliable and easy to false-positive on). The
        // allowed character class deliberately excludes quotes and angle
        // brackets, so nothing this regex can capture is able to break out
        // of the attribute the chip below places it in - a crafted string
        // like '2026/02/01/x.md" onclick="alert(1)' simply fails to match
        // past ".md" (the quote isn't in the slug's allowed charset), and
        // whatever follows stays inert escaped text.
        var POST_PATH_RE =
            /(^|[^\w/])(\/?\d{4}\/\d{2}\/\d{2}\/[A-Za-z0-9_.-]+\.md)(?![A-Za-z0-9_])/g;

        function renderPostChip(postPath) {
            return (
                '<button type="button" class="barrahome-terminal-chip" data-post-path="' +
                postPath +
                '">' +
                postPath +
                "</button>"
            );
        }

        // Turns bare post-path references into clickable chips. Called
        // from renderInline() on already-escaped, already-code-protected
        // text fragments (table cells, list items, paragraph text) - never
        // as a blind pass over finished HTML, so it can't reach inside a
        // <code>/<pre> span that was rendered elsewhere.
        function linkifyPostPaths(text) {
            return text.replace(POST_PATH_RE, function (m, pre, postPath) {
                return pre + renderPostChip(postPath);
            });
        }

        // Inline markdown: inline code, post-path chips, links, then
        // bold/italic. Operates on already-escaped text and only ever
        // emits tags it constructs itself around that text.
        function renderInline(text) {
            var codes = [];
            text = text.replace(/`([^`]+)`/g, function (m, c) {
                codes.push(c);
                return " IC" + (codes.length - 1) + " ";
            });

            text = linkifyPostPaths(text);

            text = text.replace(
                /\[([^\]]+)\]\(([^)\s]+)\)/g,
                function (m, label, url) {
                    if (/^https?:\/\//i.test(url)) {
                        return (
                            '<a href="' +
                            url +
                            '" target="_blank" rel="noopener noreferrer">' +
                            label +
                            "</a>"
                        );
                    }
                    // Non-http(s) targets (javascript:, data:, protocol-
                    // relative, etc.) are rejected: fall back to plain text.
                    return label;
                },
            );

            text = text.replace(
                /\*\*\*([\s\S]+?)\*\*\*/g,
                "<strong><em>$1</em></strong>",
            );
            text = text.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
            text = text.replace(/\*([\s\S]+?)\*/g, "<em>$1</em>");

            text = text.replace(/ IC(\d+) /g, function (m, idx) {
                return "<code>" + codes[Number(idx)] + "</code>";
            });
            return text;
        }

        function renderTable(node) {
            var html = '<table class="barrahome-terminal-table"><thead><tr>';
            node.header.forEach(function (c) {
                html += "<th>" + renderInline(c) + "</th>";
            });
            html += "</tr></thead><tbody>";
            node.rows.forEach(function (r) {
                html += "<tr>";
                r.forEach(function (c) {
                    html += "<td>" + renderInline(c) + "</td>";
                });
                html += "</tr>";
            });
            html += "</tbody></table>";
            return html;
        }

        function renderList(tag, items) {
            var html = "<" + tag + ">";
            items.forEach(function (it) {
                html += "<li>" + renderInline(it) + "</li>";
            });
            html += "</" + tag + ">";
            return html;
        }

        // Parses one block of text (already HTML-escaped) into a small
        // set of block nodes, then serializes those nodes to HTML. Plain
        // single-paragraph text (the common case while tokens are still
        // streaming in) is left un-wrapped so it stays inline - that is
        // what lets the blinking cursor sit right after the last
        // character instead of dropping to its own line.
        function renderMarkdown(raw, forceBlock) {
            var escaped = escapeHtml(raw);

            var codeBlocks = [];
            escaped = escaped.replace(
                /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g,
                function (m, code) {
                    codeBlocks.push(code.replace(/\n$/, ""));
                    return " CB" + (codeBlocks.length - 1) + " ";
                },
            );

            var lines = escaped.split("\n");
            var nodes = [];
            var paragraphLines = [];

            function flushParagraph() {
                if (paragraphLines.length) {
                    nodes.push({ type: "p", text: paragraphLines.join("\n") });
                    paragraphLines = [];
                }
            }

            var i = 0;
            while (i < lines.length) {
                var line = lines[i];

                var cb = line.match(/^ CB(\d+) $/);
                if (cb) {
                    flushParagraph();
                    nodes.push({ type: "code", text: codeBlocks[Number(cb[1])] });
                    i++;
                    continue;
                }

                if (/^\s*$/.test(line)) {
                    flushParagraph();
                    i++;
                    continue;
                }

                var h = line.match(/^(#{1,6})\s+(.*)$/);
                if (h) {
                    flushParagraph();
                    nodes.push({ type: "h", level: h[1].length, text: h[2] });
                    i++;
                    continue;
                }

                if (
                    /^\s*\|.*\|\s*$/.test(line) &&
                    i + 1 < lines.length &&
                    isTableSeparator(lines[i + 1])
                ) {
                    flushParagraph();
                    var header = splitTableRow(line);
                    i += 2;
                    var rows = [];
                    while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
                        rows.push(splitTableRow(lines[i]));
                        i++;
                    }
                    nodes.push({ type: "table", header: header, rows: rows });
                    continue;
                }

                if (/^\s*[-*+]\s+/.test(line)) {
                    flushParagraph();
                    var uitems = [];
                    while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
                        uitems.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
                        i++;
                    }
                    nodes.push({ type: "ul", items: uitems });
                    continue;
                }

                if (/^\s*\d+\.\s+/.test(line)) {
                    flushParagraph();
                    var oitems = [];
                    while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
                        oitems.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
                        i++;
                    }
                    nodes.push({ type: "ol", items: oitems });
                    continue;
                }

                paragraphLines.push(line);
                i++;
            }
            flushParagraph();

            // Bare single-paragraph text stays un-wrapped (see comment
            // above) UNLESS the caller is stitching multiple segments
            // together (forceBlock): once a tool call has split the reply
            // into segments, every segment must become its own block so
            // the text before and after the tool call cannot silently
            // run together again.
            var plainMode =
                !forceBlock &&
                (nodes.length === 0 ||
                    (nodes.length === 1 && nodes[0].type === "p"));

            var html = "";
            for (var n = 0; n < nodes.length; n++) {
                var node = nodes[n];
                if (node.type === "p") {
                    html += plainMode
                        ? renderInline(node.text)
                        : "<p>" + renderInline(node.text) + "</p>";
                } else if (node.type === "code") {
                    html += "<pre><code>" + node.text + "</code></pre>";
                } else if (node.type === "h") {
                    html +=
                        "<h" +
                        node.level +
                        ">" +
                        renderInline(node.text) +
                        "</h" +
                        node.level +
                        ">";
                } else if (node.type === "table") {
                    html += renderTable(node);
                } else if (node.type === "ul") {
                    html += renderList("ul", node.items);
                } else if (node.type === "ol") {
                    html += renderList("ol", node.items);
                }
            }
            return html;
        }

        var API_BASE = window.BARRAHOME_AGENT_BASE || "/ai-proxy";

        function sessionId() {
            var key = "barrahome-terminal-session";
            var id = sessionStorage.getItem(key);
            if (!id) {
                id =
                    window.crypto && window.crypto.randomUUID
                        ? window.crypto.randomUUID()
                        : String(Date.now()) + Math.random().toString(16).slice(2);
                sessionStorage.setItem(key, id);
            }
            return id;
        }

        // Appends to the last assistant row so streamed deltas read as one
        // message instead of one row per token.
        var streamingRow = null;
        var streamingContent = null;
        var streamingCursor = null;

        // Raw (unescaped) text collected so far, split into segments. A
        // tool call between two text runs starts a new segment instead of
        // appending to the last one, so the text before and after the
        // tool call render as separate blocks rather than jamming
        // together - a structural break, not synthetic whitespace.
        var streamingSegments = [];
        var pendingBreak = false;

        // Set once a "done" or "error" frame lands, so a stream that just
        // closes without either doesn't leave the status bar stuck.
        var terminated = false;

        // A single legitimate frame is small; if the backend never sends a
        // blank-line terminator the buffer would otherwise grow forever.
        var MAX_BUFFER = 64 * 1024;

        function renderStreamingContent() {
            var html = "";
            var forceBlock = streamingSegments.length > 1;
            for (var s = 0; s < streamingSegments.length; s++) {
                html += renderMarkdown(streamingSegments[s], forceBlock);
            }
            streamingContent.innerHTML = html;
        }

        function appendDelta(text) {
            if (!streamingRow) {
                streamingRow = document.createElement("div");
                streamingRow.className = "barrahome-terminal-msg system";

                var prefixSpan = document.createElement("span");
                prefixSpan.textContent = "system> ";

                streamingContent = document.createElement("span");
                streamingCursor = document.createElement("span");
                streamingCursor.className = "barrahome-terminal-cursor";
                streamingCursor.textContent = "▌";

                streamingRow.appendChild(prefixSpan);
                streamingRow.appendChild(streamingContent);
                streamingRow.appendChild(streamingCursor);
                log.appendChild(streamingRow);

                streamingSegments = [""];
                pendingBreak = false;
            }

            if (pendingBreak) {
                streamingSegments.push("");
                pendingBreak = false;
            }

            streamingSegments[streamingSegments.length - 1] += text;
            renderStreamingContent();
            log.scrollTop = log.scrollHeight;
        }

        // Removes the blinking cursor and drops the streaming references.
        // Called on every path that ends a turn (done, error, or the
        // stream just closing) so nothing is ever left mid-blink.
        function finalizeStreamingRow() {
            if (streamingCursor && streamingCursor.parentNode) {
                streamingCursor.parentNode.removeChild(streamingCursor);
            }
            streamingRow = null;
            streamingContent = null;
            streamingCursor = null;
            streamingSegments = [];
            pendingBreak = false;
        }

        // ---------------------------------------------------------------
        // Status bar activity indicator: an ASCII spinner with elapsed
        // time while "thinking", and a visually distinct marker while a
        // tool is running.
        // ---------------------------------------------------------------

        var SPINNER_FRAMES = ["|", "/", "-", "\\"];
        var spinnerTimer = null;
        var spinnerStart = 0;
        var spinnerFrame = 0;

        function stopSpinner() {
            if (spinnerTimer) {
                clearInterval(spinnerTimer);
                spinnerTimer = null;
            }
        }

        function startThinkingStatus() {
            stopSpinner();
            spinnerStart = Date.now();
            spinnerFrame = 0;
            var tick = function () {
                var elapsed = Math.floor((Date.now() - spinnerStart) / 1000);
                var glyph = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
                spinnerFrame++;
                status.textContent = "[" + glyph + "] thinking… " + elapsed + "s";
            };
            tick();
            spinnerTimer = setInterval(tick, 180);
        }

        // Extracts a short human label from a "toolname {json args}" blob
        // instead of dumping the raw arguments JSON into the status bar.
        function describeTool(raw) {
            raw = raw || "";
            var spaceIdx = raw.indexOf(" ");
            var name = spaceIdx === -1 ? raw : raw.slice(0, spaceIdx);
            var rest = spaceIdx === -1 ? "" : raw.slice(spaceIdx + 1).trim();
            var detail = "";
            if (rest) {
                try {
                    var args = JSON.parse(rest);
                    if (
                        args &&
                        typeof args === "object" &&
                        !(args instanceof Array)
                    ) {
                        var keys = Object.keys(args);
                        if (keys.length) {
                            var val = args[keys[0]];
                            detail =
                                typeof val === "string" ? val : JSON.stringify(val);
                        }
                    } else {
                        detail = String(args);
                    }
                } catch (e) {
                    detail = rest;
                }
            }

            var verb;
            if (/read/i.test(name)) verb = "reading";
            else if (/search/i.test(name)) verb = "searching";
            else if (/list/i.test(name)) verb = "listing";
            else if (/write|save/i.test(name)) verb = "writing";
            else if (/fetch|get|http/i.test(name)) verb = "fetching";
            else if (/run|exec/i.test(name)) verb = "running";
            else verb = name ? name.replace(/_/g, " ") : "using tool";

            if (detail.length > 40) detail = detail.slice(0, 37) + "...";
            return detail ? verb + " " + detail : verb;
        }

        function startToolStatus(raw) {
            stopSpinner();
            spinnerStart = Date.now();
            var label = describeTool(raw);
            var tick = function () {
                var elapsed = Math.floor((Date.now() - spinnerStart) / 1000);
                status.textContent = "[▶] " + label + " " + elapsed + "s";
            };
            tick();
            spinnerTimer = setInterval(tick, 500);
        }

        function handleEvent(name, data) {
            if (name === "text") {
                appendDelta(data.text || "");
                return;
            }
            if (name === "tool_start") {
                // A tool call between two text runs: break the next run of
                // text into a new block instead of appending to the one
                // that was streaming before this call.
                if (streamingRow) pendingBreak = true;
                startToolStatus(data.text || "");
                return;
            }
            if (name === "tool_result") {
                startThinkingStatus();
                return;
            }
            if (name === "error") {
                finalizeStreamingRow();
                terminated = true;
                stopSpinner();
                status.textContent = "Ready.";
                addLog("system", data.message || "The agent hit an error.");
                return;
            }
            if (name === "done") {
                finalizeStreamingRow();
                terminated = true;
                stopSpinner();
                var left = data.turns_left;
                status.textContent =
                    typeof left === "number"
                        ? "Ready. " + left + " turns left this session."
                        : "Ready.";
            }
        }

        // Minimal SSE parser: frames are separated by a blank line, and we only
        // need the "event:" and "data:" fields the backend sends.
        function consumeFrames(buffer) {
            var frames = buffer.split("\n\n");
            var remainder = frames.pop();
            frames.forEach(function (frame) {
                var name = "message";
                var payload = "";
                frame.split("\n").forEach(function (line) {
                    if (line.indexOf("event:") === 0) {
                        name = line.slice(6).trim();
                    } else if (line.indexOf("data:") === 0) {
                        payload += line.slice(5).trim();
                    }
                });
                if (!payload) return;
                try {
                    handleEvent(name, JSON.parse(payload));
                } catch (e) {
                    /* ignore malformed frames */
                }
            });
            return remainder;
        }

        var busy = false;

        // The visitor's last typed message, used only as a cheap language
        // signal for the prefilled "explain this post" prompt below. Not
        // sent anywhere and not used for anything else.
        var lastUserText = "";

        // Cheap, non-NLP language guess from the visitor's own words:
        // Spanish diacritics/punctuation win outright, a few common
        // English stopwords are the fallback signal, and anything
        // ambiguous (including "no message yet", e.g. a chip clicked
        // before the visitor has typed anything) defaults to Spanish,
        // which is right for this blog.
        function detectLanguage(text) {
            text = text || "";
            if (/[ñáéíóúüÑÁÉÍÓÚÜ¿¡]/.test(text)) return "es";
            if (/\b(the|what|how|does|explain|please|you|your)\b/i.test(text)) {
                return "en";
            }
            return "es";
        }

        function buildPostPrompt(postPath) {
            if (detectLanguage(lastUserText) === "en") {
                return "Read " + postPath + " and explain what it's about.";
            }
            return "Lee " + postPath + " y explícame de qué trata.";
        }

        function send() {
            if (busy) return;
            var question = promptInput.value.trim();
            if (!question) return;

            lastUserText = question;
            addLog("user", question);
            promptInput.value = "";
            finalizeStreamingRow();
            terminated = false;
            busy = true;
            sendBtn.disabled = true;
            startThinkingStatus();

            fetch(API_BASE + "/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    session_id: sessionId(),
                    message: question,
                }),
            })
                .then(function (response) {
                    if (!response.ok) {
                        return response.text().then(function (text) {
                            throw new Error(
                                text || "HTTP " + response.status,
                            );
                        });
                    }
                    var reader = response.body.getReader();
                    var decoder = new TextDecoder();
                    var buffer = "";

                    function pump() {
                        return reader.read().then(function (result) {
                            if (result.done) {
                                // The backend always ends with "done" or
                                // "error"; if the connection just closed
                                // without either, don't leave the status
                                // bar stuck on "thinking"/"reading" or the
                                // cursor blinking forever.
                                if (!terminated) {
                                    finalizeStreamingRow();
                                    stopSpinner();
                                    status.textContent = "Ready.";
                                }
                                return;
                            }
                            buffer += decoder.decode(result.value, {
                                stream: true,
                            });
                            if (buffer.length > MAX_BUFFER) {
                                reader.cancel();
                                throw new Error(
                                    "stream exceeded the buffer limit without a terminator",
                                );
                            }
                            buffer = consumeFrames(buffer);
                            return pump();
                        });
                    }
                    return pump();
                })
                .catch(function (err) {
                    finalizeStreamingRow();
                    stopSpinner();
                    addLog("system", "Error: " + err.message);
                    status.textContent = "Ready.";
                })
                .finally(function () {
                    busy = false;
                    sendBtn.disabled = false;
                });
        }

        sendBtn.addEventListener("click", send);
        promptInput.addEventListener("keydown", function (e) {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });

        // Post-reference chips are rendered as inert markup (see
        // renderPostChip) with no inline handler; a single delegated
        // listener on the log is what actually makes them clickable. A
        // click just prefills the composer and drives the existing send()
        // path - same turn, same busy guard, no separate protocol and no
        // direct tool call from the client.
        log.addEventListener("click", function (e) {
            var target = e.target;
            while (target && target !== log && target.tagName !== "BUTTON") {
                target = target.parentNode;
            }
            if (!target || target === log) return;
            if (!target.classList.contains("barrahome-terminal-chip")) return;
            if (target.disabled) return;
            if (busy) return;

            var postPath = target.getAttribute("data-post-path");
            if (!postPath) return;

            target.disabled = true;
            target.classList.add("used");
            target.textContent = target.textContent + " ✓";

            promptInput.value = buildPostPrompt(postPath);
            send();
        });

        closeBtn.addEventListener("click", function () {
            win.classList.add("hidden");
        });

        var dragging = false;
        var dx = 0;
        var dy = 0;

        titlebar.addEventListener("mousedown", function (e) {
            if (e.target === closeBtn) return;
            if (e.button !== 0) return;
            dragging = true;
            dx = e.clientX - win.offsetLeft;
            dy = e.clientY - win.offsetTop;
            e.preventDefault();
        });

        document.addEventListener("mousemove", function (e) {
            if (!dragging) return;
            var left = Math.max(
                8,
                Math.min(
                    window.innerWidth - win.offsetWidth - 8,
                    e.clientX - dx,
                ),
            );
            var top = Math.max(
                8,
                Math.min(
                    window.innerHeight - win.offsetHeight - 8,
                    e.clientY - dy,
                ),
            );
            win.style.left = left + "px";
            win.style.top = top + "px";
        });

        document.addEventListener("mouseup", function () {
            dragging = false;
        });

        document.addEventListener("keydown", function (e) {
            if (e.code !== HOTKEY_CODE) return;
            e.preventDefault();
            win.classList.toggle("hidden");
            if (!win.classList.contains("hidden")) promptInput.focus();
        });

        addLog("system", "Terminal ready. Ask me about this site.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", createUI);
    } else {
        createUI();
    }
})();
