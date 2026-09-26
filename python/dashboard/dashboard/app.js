// Knightly Swarm Dashboard - Real-time WebSocket Client
// Streams all values via WebSocket at <500ms for the most beautiful trading dashboard ever

class KnightlyDashboard {
    constructor() {
        this.ws = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectDelay = 10000;
        this.heartbeatInterval = null;
        this.equityChart = null;
        this.equityData = [];
        this.maxDataPoints = 100;
        this.particlePool = [];
        this.init();
    }

    init() {
        this.setupWebSocket();
        this.setupEventListeners();
        this.initChart();
        this.initParticleSystem();
        this.startHeartbeat();
        this.initializeLucideIcons();
        this.animateBackground();
        this.updateUptime();
        this.startUptimeTicker();
    }

    setupWebSocket() {
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = protocol + "//" + window.location.host + "/ws";
        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            this.updateConnectionStatus("Connected", true);
            this.log("WebSocket connected to Knightly Swarm");
        };

        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                this.updateDashboard(data);
            } catch (error) {
                console.error("Parse error:", error);
            }
        };

        this.ws.onclose = () => {
            this.isConnected = false;
            this.updateConnectionStatus("Disconnected", false);
            this.log("WebSocket disconnected");
            this.reconnectAttempts++;
            const delay = Math.min(1000 * this.reconnectAttempts, this.maxReconnectDelay);
            setTimeout(() => this.setupWebSocket(), delay);
        };

        this.ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            this.updateConnectionStatus("Error", false);
        };
    }

    setupEventListeners() {
        const toggleBtn = document.getElementById("toggleTrading");
        const stopBtn = document.getElementById("emergencyStop");
        const refreshBtn = document.getElementById("refreshAssets");
        const assetSearch = document.getElementById("assetSearch");
        const clearLogs = document.getElementById("clearLogs");
        const clearTrades = document.getElementById("clearTrades");

        if (toggleBtn) {
            toggleBtn.addEventListener("click", () => this.toggleTrading());
        }
        if (stopBtn) {
            stopBtn.addEventListener("click", () => this.emergencyStop());
        }
        if (refreshBtn) {
            refreshBtn.addEventListener("click", () => this.triggerScan());
        }
        if (clearLogs) {
            clearLogs.addEventListener("click", () => this.clearLogs());
        }
        if (clearTrades) {
            clearTrades.addEventListener("click", () => this.clearTrades());
        }
        if (assetSearch) {
            assetSearch.addEventListener("input", (e) => this.filterAssets(e.target.value));
        }
    }

    updateDashboard(data) {
        if (data.agents) this.updateAgentStates(data.agents);
        if (data.pipeline) this.updatePipelineStatus(data.pipeline);
        if (data.assets) this.updateAssetTable(data.assets);
        if (data.account) this.updateMetrics(data.account);
        if (data.trades) this.updateTradeHistory(data.trades);
        if (data.logs) this.updateLogs(data.logs);
        if (data.system) this.updateSystemStatus(data.system);
        this.updateEquityChart(data.account);
        this.animateFlow();
    }

    updateAgentStates(agents) {
        Object.keys(agents).forEach(key => {
            const agent = agents[key];
            if (!agent) return;
            const node = document.querySelector(".node[data-agent='" + key + "']");
            if (node) {
                node.className = "node " + agent.status;
                const statusEl = document.getElementById(key + "Status");
                if (statusEl) statusEl.textContent = agent.status;
            }
        });
        // Update active agent count
        const activeCount = Object.values(agents).filter(a =>
            a.status === "thinking" || a.status === "analyzing" || a.status === "executing"
        ).length;
        const el = document.getElementById("activeAgents");
        if (el) el.textContent = String(activeCount);
    }

    updatePipelineStatus(pipeline) {
        // Animate flows between pipeline stages
        const connections = document.querySelectorAll("#connections path");
        connections.forEach(p => p.classList.remove("active"));
        if (pipeline.length > 0 && pipeline[0].status === "running") {
            const activeConn = connections[0];
            if (activeConn) activeConn.classList.add("active");
        }
    }

    updateMetrics(account) {
        const eqEl = document.getElementById("equity");
        const balEl = document.getElementById("balance");
        const pnlEl = document.getElementById("pnl");
        const posEl = document.getElementById("positions");
        const tradesEl = document.getElementById("dailyTrades");
        const wrEl = document.getElementById("winRate");

        if (eqEl) {
            eqEl.textContent = "$" + this.formatNumber(account.equity || 0);
            const changeEl = document.getElementById("equityChange");
            if (changeEl) {
                const chg = account.pnlPercent || 0;
                changeEl.textContent = (chg >= 0 ? "+" : "") + this.formatNumber(chg, 2) + "%";
                changeEl.className = "metric-change " + (chg >= 0 ? "positive" : "negative");
            }
        }
        if (balEl) balEl.textContent = "$" + this.formatNumber(account.balance || 0);
        if (pnlEl) {
            pnlEl.textContent = "$" + this.formatNumber(account.pnl || 0);
        }
        if (posEl) posEl.textContent = String(account.positions ? account.positions.length : 0);
        if (tradesEl) tradesEl.textContent = String(account.dailyTrades || 0);
        if (wrEl) wrEl.textContent = this.formatNumber(account.winRate || 0, 0) + "%";
    }

    updateAssetTable(assets) {
        const tbody = document.getElementById("assetsTableBody");
        if (!tbody || !assets) return;
        const fragment = document.createDocumentFragment();
        const display = assets.slice(0, 500);
        display.forEach(asset => {
            const row = document.createElement("tr");
            const signalClass = this.getSignalClass(asset.signal);
            const priceChange = asset.change24h || 0;
            const changeClass = priceChange >= 0 ? "positive" : "negative";
            row.innerHTML =
                "<td class='symbol-cell'>" + this.escapeHtml(asset.symbol) + "</td>" +
                "<td>" + this.formatNumber(asset.price, 2) + "</td>" +
                "<td class='" + changeClass + "'>" + (priceChange >= 0 ? "+" : "") + this.formatNumber(priceChange, 2) + "%</td>" +
                "<td><span class='signal-badge " + signalClass + "'>" + (asset.signal || "none") + "</span></td>" +
                "<td>" + this.formatVolume(asset.volume24h || 0) + "</td>" +
                "<td>" + (asset.inPipeline ? "<span class='in-pipeline'>Analyzing</span>" : "") + "</td>";
            fragment.appendChild(row);
        });
        tbody.innerHTML = "";
        tbody.appendChild(fragment);
        const countEl = document.getElementById("assetCount");
        if (countEl) countEl.textContent = String(assets.length);
    }

    filterAssets(query) {
        const rows = document.querySelectorAll("#assetsTableBody tr");
        const lower = query.toLowerCase();
        rows.forEach(row => {
            const symbol = row.cells[0].textContent.toLowerCase();
            row.style.display = symbol.includes(lower) ? "" : "none";
        });
    }

    updateTradeHistory(trades) {
        const tbody = document.getElementById("tradesTableBody");
        if (!tbody) return;
        const fragment = document.createDocumentFragment();
        trades.slice(0, 50).forEach(trade => {
            const row = document.createElement("tr");
            const sideClass = trade.side === "buy" ? "trade-side-buy" : "trade-side-sell";
            const statusClass = "trade-status-" + (trade.status || "pending");
            const timeStr = new Date(trade.timestamp * 1000).toLocaleTimeString();
            row.innerHTML =
                "<td>" + timeStr + "</td>" +
                "<td>" + this.escapeHtml(trade.symbol) + "</td>" +
                "<td class='" + sideClass + "'>" + trade.side + "</td>" +
                "<td>" + this.formatNumber(trade.size, 4) + "</td>" +
                "<td>" + this.formatNumber(trade.price, 2) + "</td>" +
                "<td>" + this.formatNumber(trade.pnl || 0, 2) + "</td>" +
                "<td class='" + statusClass + "'>" + (trade.status || "pending") + "</td>";
            fragment.appendChild(row);
        });
        tbody.innerHTML = "";
        tbody.appendChild(fragment);
    }

    updateLogs(logs) {
        const container = document.getElementById("logsContainer");
        if (!container) return;
        let html = "";
        logs.slice(0, 100).forEach(log => {
            const timeStr = new Date(log.ts * 1000).toLocaleTimeString();
            html += "<div class='log-entry " + this.escapeHtml(log.agent || "swarm") + "'>";
            html += "<span class='log-time'>[" + timeStr + "]</span>";
            html += "<span class='log-agent'>" + this.escapeHtml(log.agent || "swarm") + ":</span> ";
            html += this.escapeHtml(log.message || "");
            html += "</div>";
        });
        container.innerHTML = html;
        container.scrollTop = 0;
    }

    clearLogs() {
        const container = document.getElementById("logsContainer");
        if (container) container.innerHTML = "";
        this.sendCommand("clear_logs");
    }

    clearTrades() {
        const tbody = document.getElementById("tradesTableBody");
        if (tbody) tbody.innerHTML = "";
        this.sendCommand("clear_trades");
    }

    updateSystemStatus(system) {
        const toggles = document.querySelectorAll(".status-item, .status-instance");
        toggles.forEach(el => {
            const label = el.querySelector("span").textContent;
            let isActive = false;
            if (label === "Trading") isActive = system.trading_enabled || false;
            if (label === "Connected") isActive = system.blofin_connected || false;
            if (label === "Router") isActive = system.router_status || false;
            el.setAttribute("data-status", isActive ? "true" : "false");
        });

        const toggleBtn = document.getElementById("toggleTrading");
        if (toggleBtn) {
            const span = toggleBtn.querySelector("span");
            if (span) {
                span.textContent = system.trading_enabled ? "Stop Trading" : "Start Trading";
            }
            toggleBtn.className = system.trading_enabled
                ? "control-btn danger" : "control-btn primary";
        }
    }

    initChart() {
        const ctx = document.getElementById("equityChart");
        if (!ctx || !window.Chart) return;
        this.equityChart = new Chart(ctx, {
            type: "line",
            data: {
                labels: [],
                datasets: [{
                    label: "Equity",
                    data: [],
                    borderColor: "rgba(0, 245, 255, 0.8)",
                    backgroundColor: "rgba(0, 245, 255, 0.1)",
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                    tension: 0.3,
                }],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                scales: {
                    x: { display: false, grid: { display: false } },
                    y: {
                        grid: { color: "rgba(255,255,255,0.05)" },
                        ticks: { color: "#94a3b8" },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: "rgba(0,0,0,0.7)",
                        borderColor: "rgba(0,245,255,0.3)",
                        titleColor: "#fff",
                        bodyColor: "#94a3b8",
                    },
                },
            },
        });
    }

    updateEquityChart(account) {
        if (!this.equityChart || !account) return;
        const equity = account.equity || 0;
        this.equityData.push({ x: Date.now(), y: equity });
        if (this.equityData.length > this.maxDataPoints) {
            this.equityData.shift();
        }
        this.equityChart.data.labels = this.equityData.map(d => "");
        this.equityChart.data.datasets[0].data = this.equityData.map(d => d.y);
        this.equityChart.update("none");
    }

    initParticleSystem() {
        const graph = document.querySelector(".pipeline-graph");
        if (!graph) return;
        for (let i = 0; i < 20; i++) {
            const p = document.createElement("div");
            p.className = "data-particle";
            p.style.left = Math.random() * 100 + "%";
            p.style.animationDelay = Math.random() * 3 + "s";
            p.style.animationDuration = (2 + Math.random()) + "s";
            graph.appendChild(p);
        }
    }

    animateFlow() {
        const connections = document.querySelectorAll("#connections path");
        connections.forEach((p, i) => {
            p.style.transition = "stroke 0.3s ease";
        });
    }

    animateBackground() {
        // Subtle floating gradient animation
        const style = document.createElement("style");
        style.textContent = "@keyframes gradientShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } } body { background-size: 200% 200%; animation: gradientShift 12s ease infinite; }";
        document.head.appendChild(style);
    }

    updateUptime() {
        const uptimeEl = document.getElementById("uptime");
        if (uptimeEl) uptimeEl.textContent = "00:00:00";
    }

    startUptimeTicker() {
        setInterval(() => {
            const uptimeEl = document.getElementById("uptime");
            if (uptimeEl && this.isConnected) {
                const parts = uptimeEl.textContent.split(":").map(Number);
                let sec = parts[0] * 3600 + parts[1] * 60 + parts[2] + 1;
                const h = Math.floor(sec / 3600);
                const m = Math.floor((sec % 3600) / 60);
                const s = sec % 60;
                uptimeEl.textContent =
                    String(h).padStart(2, "0") + ":" +
                    String(m).padStart(2, "0") + ":" +
                    String(s).padStart(2, "0");
            }
        }, 1000);
    }

    updateConnectionStatus(status, connected) {
        const el = document.getElementById("connectionStatus");
        if (el) {
            el.textContent = status;
            el.style.color = connected ? "var(--accent-green)" : "var(--accent-red)";
            el.style.fontWeight = "600";
        }
    }

    toggleTrading() {
        this.sendCommand("toggle_trading");
        const btn = document.getElementById("toggleTrading");
        const span = btn.querySelector("span");
        if (span.textContent.includes("Start")) {
            span.textContent = "Stop Trading";
            btn.className = "control-btn danger";
        } else {
            span.textContent = "Start Trading";
            btn.className = "control-btn primary";
        }
    }

    emergencyStop() {
        if (confirm("Emergency stop — are you sure?")) {
            this.sendCommand("emergency_stop");
            const btn = document.getElementById("toggleTrading");
            if (btn) {
                btn.className = "control-btn primary";
                const span = btn.querySelector("span");
                if (span) span.textContent = "Start Trading";
            }
        }
    }

    triggerScan() {
        this.sendCommand("scan");
    }

    sendCommand(cmd) {
        fetch("/api/" + cmd, { method: "POST" })
            .then(r => r.json())
            .then(data => {
                console.log("Command '" + cmd + "' sent:", data);
                if (data.status === "ok") {
                    this.log("swarm", "Command sent: " + cmd);
                }
            })
            .catch(err => {
                console.error("Command error:", err);
                this.log("swarm", "Command failed: " + cmd);
            });
    }

    log(agent, message) {
        const container = document.getElementById("logsContainer");
        if (!container) return;
        const timeStr = new Date().toLocaleTimeString();
        const entry = document.createElement("div");
        entry.className = "log-entry " + agent;
        entry.innerHTML =
            "<span class='log-time'>[" + timeStr + "]</span>" +
            "<span class='log-agent'>" + agent + ":</span> " +
            message;
        container.insertBefore(entry, container.firstChild);
        while (container.children.length > 100) {
            container.removeChild(container.lastChild);
        }
        container.scrollTop = 0;
    }

    getSignalClass(signal) {
        if (!signal || signal === "none") return "signal-none";
        if (signal.includes("breakout") || signal.includes("bullish") || signal === "long") return "signal-long";
        if (signal.includes("breakdown") || signal.includes("bearish") || signal === "short") return "signal-short";
        return "signal-watch";
    }

    formatNumber(num, decimals) {
        decimals = decimals || 2;
        if (!num || isNaN(num)) return "0.00";
        const abs = Math.abs(num);
        if (abs >= 1e9) return (num / 1e9).toFixed(decimals) + "B";
        if (abs >= 1e6) return (num / 1e6).toFixed(decimals) + "M";
        if (abs >= 1e3) return (num / 1e3).toFixed(decimals) + "K";
        return num.toFixed(decimals);
    }

    formatVolume(vol) {
        if (!vol || isNaN(vol)) return "0";
        if (vol >= 1e9) return (vol / 1e9).toFixed(2) + "B";
        if (vol >= 1e6) return (vol / 1e6).toFixed(2) + "M";
        if (vol >= 1e3) return (vol / 1e3).toFixed(1) + "K";
        return String(Math.round(vol));
    }

    escapeHtml(text) {
        if (text === null || text === undefined) return "";
        const div = document.createElement("div");
        div.textContent = String(text);
        return div.innerHTML;
    }

    initializeLucideIcons() {
        if (window.lucide) {
            lucide.createIcons();
        }
    }

    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "ping" }));
            }
        }, 10000);
    }
}

// Initialize the dashboard when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    window.knightly = new KnightlyDashboard();
});
