(function () {
    var HOTKEY_CODE = "Backquote";
    var API_BASE =
        window.BARRAHOME_TUTOR_API_BASE || window.location.origin + "/ai-proxy";

    function getArticleText() {
        var root = document.querySelector(".content");
        var text = root ? root.innerText.trim() : "";
        var maxChars = 120000;
        return text.length > maxChars ? text.slice(0, maxChars) : text;
    }

    function createUI() {
        if (document.getElementById("ai-tutor-window")) return;
        var sessionId = null;
        var articleContext = getArticleText();
        var headingEl = document.querySelector(
            ".content h1, .content h2, .content h3",
        );
        var articleTitle = headingEl
            ? headingEl.textContent.trim()
            : document.title;

        var style = document.createElement("style");
        style.textContent =
            "" +
            ".ai-tutor-window{position:fixed;top:84px;left:220px;width:min(860px,92vw);height:min(520px,75vh);z-index:9999;background:#aeb2c3;border-top:3px solid #d4d7e3;border-left:3px solid #d4d7e3;border-right:3px solid #6b6e7a;border-bottom:3px solid #6b6e7a;display:flex;flex-direction:column;}" +
            ".ai-tutor-window.hidden{display:none;}" +
            ".ai-tutor-titlebar{background:#b24d7a;color:#fff;padding:4px 8px;cursor:move;user-select:none;display:flex;justify-content:space-between;align-items:center;border-top:2px solid #d888a8;border-left:2px solid #d888a8;border-right:2px solid #6e2f4c;border-bottom:2px solid #6e2f4c;}" +
            ".ai-tutor-toolbar{display:flex;gap:8px;align-items:center;padding:6px;background:#9a9eae;color:#1a1a2e;font-size:12px;}" +
            ".ai-tutor-log{flex:1;background:#2f3a44;color:#e0e0e0;padding:10px;overflow:auto;font-family:monospace;font-size:13px;}" +
            ".ai-tutor-msg{margin:0 0 10px 0;white-space:pre-wrap;}" +
            ".ai-tutor-msg.user{color:#f0d080;}" +
            ".ai-tutor-msg.assistant{color:#d8e4ef;}" +
            ".ai-tutor-composer{padding:8px;background:#556573;border-top:2px solid #3d4a56;display:flex;gap:8px;}" +
            ".ai-tutor-input{flex:1;background:#d8dbe6;color:#111;border:1px solid #6b6e7a;font-family:monospace;font-size:13px;padding:6px;resize:none;}" +
            ".ai-tutor-btn{background:#b24d7a;color:#fff;border-top:2px solid #d888a8;border-left:2px solid #d888a8;border-right:2px solid #6e2f4c;border-bottom:2px solid #6e2f4c;padding:4px 10px;cursor:pointer;font-family:monospace;font-size:12px;}" +
            ".ai-tutor-status{padding:3px 8px;background:#4a5868;color:#d0d0d0;font-size:11px;}";
        document.head.appendChild(style);

        var win = document.createElement("section");
        win.id = "ai-tutor-window";
        win.className = "ai-tutor-window hidden";

        var titlebar = document.createElement("div");
        titlebar.className = "ai-tutor-titlebar";
        titlebar.innerHTML =
            '<span>Article Tutor Terminal</span><button type="button" id="ai-tutor-close" class="ai-tutor-btn">X</button>';

        var toolbar = document.createElement("div");
        toolbar.className = "ai-tutor-toolbar";
        toolbar.innerHTML =
            "" +
            "<span>Proxy: " +
            API_BASE +
            "</span>" +
            "<span>Hotkey: `</span>";

        var log = document.createElement("div");
        log.className = "ai-tutor-log";

        var composer = document.createElement("div");
        composer.className = "ai-tutor-composer";
        composer.innerHTML =
            "" +
            '<textarea id="ai-tutor-input" class="ai-tutor-input" rows="3" placeholder="Ask about this article..."></textarea>' +
            '<button type="button" id="ai-tutor-send" class="ai-tutor-btn">Send</button>';

        var status = document.createElement("div");
        status.className = "ai-tutor-status";
        status.textContent = articleContext
            ? "Ready. Session-based tutor via proxy."
            : "Warning: no article context detected on page.";

        win.appendChild(titlebar);
        win.appendChild(toolbar);
        win.appendChild(log);
        win.appendChild(composer);
        win.appendChild(status);
        document.body.appendChild(win);

        var promptInput = document.getElementById("ai-tutor-input");
        var sendBtn = document.getElementById("ai-tutor-send");
        var closeBtn = document.getElementById("ai-tutor-close");

        function setStatus(text) {
            status.textContent = text;
        }

        function addLog(role, content) {
            var row = document.createElement("div");
            row.className = "ai-tutor-msg " + role;
            row.textContent =
                (role === "user" ? "> " : "assistant> ") + content;
            log.appendChild(row);
            log.scrollTop = log.scrollHeight;
        }

        async function streamAssistant(content) {
            var row = document.createElement("div");
            row.className = "ai-tutor-msg assistant";
            row.textContent = "assistant> ";
            log.appendChild(row);

            var i = 0;
            var step = 3;
            while (i < content.length) {
                row.textContent += content.slice(i, i + step);
                i += step;
                log.scrollTop = log.scrollHeight;
                await new Promise(function (resolve) {
                    setTimeout(resolve, 12);
                });
            }
        }

        async function send() {
            var question = promptInput.value.trim();
            if (!question) return;
            sendBtn.disabled = true;

            addLog("user", question);
            promptInput.value = "";
            setStatus("Generating response ...");

            var payload = {
                model: "proxy-managed",
                temperature: 0.2,
                messages: [{ role: "user", content: question }],
                metadata: {
                    session_id: sessionId,
                    article_url: window.location.href,
                    article_title: articleTitle,
                    // Always send current article context so proxy can inject it every turn.
                    article_context: articleContext,
                },
            };

            try {
                var res = await fetch(API_BASE + "/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                });

                if (!res.ok) {
                    throw new Error("HTTP " + res.status);
                }

                var data = await res.json();
                if (data.session_id) {
                    sessionId = data.session_id;
                }
                var answer =
                    data.choices &&
                    data.choices[0] &&
                    data.choices[0].message &&
                    data.choices[0].message.content
                        ? data.choices[0].message.content
                        : "No assistant content in response.";

                await streamAssistant(answer);
                setStatus(
                    "Done. Session: " +
                        (sessionId ? sessionId.slice(0, 8) : "n/a"),
                );
            } catch (err) {
                addLog("assistant", "Request failed: " + err.message);
                setStatus("Error calling API.");
            } finally {
                sendBtn.disabled = false;
            }
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
            if (!win.classList.contains("hidden")) {
                promptInput.focus();
            }
        });

        addLog("assistant", "Tutor ready. Ask anything about this article.");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", createUI);
    } else {
        createUI();
    }
})();
