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
            ".barrahome-terminal-status{padding:3px 8px;background:#4a5868;color:#d0d0d0;font-size:11px;}";
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

        function appendDelta(text) {
            if (!streamingRow) {
                streamingRow = document.createElement("div");
                streamingRow.className = "barrahome-terminal-msg system";
                streamingRow.textContent = "system> ";
                log.appendChild(streamingRow);
            }
            streamingRow.textContent += text;
            log.scrollTop = log.scrollHeight;
        }

        function handleEvent(name, data) {
            if (name === "text") {
                appendDelta(data.text || "");
                return;
            }
            if (name === "tool_start") {
                status.textContent = "Reading: " + (data.text || "");
                return;
            }
            if (name === "tool_result") {
                status.textContent = "Thinking...";
                return;
            }
            if (name === "error") {
                streamingRow = null;
                addLog("system", data.message || "The agent hit an error.");
                return;
            }
            if (name === "done") {
                streamingRow = null;
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

        function send() {
            if (busy) return;
            var question = promptInput.value.trim();
            if (!question) return;

            addLog("user", question);
            promptInput.value = "";
            streamingRow = null;
            busy = true;
            sendBtn.disabled = true;
            status.textContent = "Thinking...";

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
                                return;
                            }
                            buffer += decoder.decode(result.value, {
                                stream: true,
                            });
                            buffer = consumeFrames(buffer);
                            return pump();
                        });
                    }
                    return pump();
                })
                .catch(function (err) {
                    streamingRow = null;
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
