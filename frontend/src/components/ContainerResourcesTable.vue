<template>
    <section class="resource-panel shadow-box mb-4" :aria-label="$t('containerResources')">
        <header class="resource-header">
            <h4>{{ $tc("container", 2) }} <span class="resource-count">{{ rows.length }}</span></h4>
            <span class="sample-status" :class="{ live: live }" role="status">
                <span class="status-dot"></span>{{ statusText }}
            </span>
        </header>
        <div v-if="snapshot.error || subscriptionError" class="resource-notice" role="alert">
            {{ subscriptionError || $t('resourcesUnavailable') }}
        </div>
        <div class="resource-scroll" tabindex="0" :aria-label="$t('resourceTableScroll')">
            <table class="resource-table">
                <thead>
                    <tr>
                        <th scope="col">{{ $t("containerResourceIdentity") }}</th>
                        <th scope="col" :title="$t('resourceCpuHint')">CPU</th>
                        <th scope="col">{{ $t("resourceMemory") }}</th>
                        <th scope="col">{{ $t("resourceNetwork") }}</th>
                        <th scope="col">{{ $t("resourceBlockIO") }}</th>
                        <th scope="col">PIDs</th>
                        <th scope="col"><span class="visually-hidden">{{ $t("terminal") }}</span></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in rows" :key="row.id" :class="{ inactive: row.state !== 'running' }">
                        <th scope="row" class="identity-cell">
                            <div class="container-heading">
                                <span class="container-name" :title="row.name">{{ row.name }}</span>
                                <span class="state-pill" :class="{ running: row.state === 'running', unhealthy: row.health === 'unhealthy', starting: row.health === 'starting' }">{{ row.health || row.state }}</span>
                            </div>
                            <span class="container-image" :title="row.image">{{ row.image }}</span>
                            <span v-if="row.name !== row.service" class="service-name">{{ row.service }}</span>
                            <div v-if="services[row.service]?.ports?.length" class="container-ports">
                                <a v-for="(port, index) in services[row.service].ports" :key="index" :href="portLink(port).url" target="_blank" rel="noopener noreferrer">{{ portLink(port).display }}</a>
                            </div>
                        </th>
                        <td class="cpu-cell">
                            <span class="metric-value">{{ percentage(values(row)?.cpu_percent) }}</span>
                            <div class="metric-track" aria-hidden="true"><span :style="{ width: bar(values(row)?.cpu_percent) }"></span></div>
                        </td>
                        <td class="memory-cell">
                            <span class="metric-value">{{ bytes(values(row)?.memory_working_set_bytes) }}</span>
                            <span class="metric-secondary">/ {{ bytes(values(row)?.memory_limit_bytes) }}</span>
                            <div class="metric-track memory-track" aria-hidden="true"><span :style="{ width: bar(values(row)?.memory_percent) }"></span></div>
                        </td>
                        <td>
                            <div class="io-line" :title="totalTitle('resourceReceive', values(row)?.network_receive_bytes_total)"><span class="io-direction">↓</span>{{ speed(values(row)?.network_receive_bytes_per_second) }}</div>
                            <div class="io-line" :title="totalTitle('resourceTransmit', values(row)?.network_transmit_bytes_total)"><span class="io-direction">↑</span>{{ speed(values(row)?.network_transmit_bytes_per_second) }}</div>
                        </td>
                        <td>
                            <div class="io-line" :title="totalTitle('resourceRead', values(row)?.block_read_bytes_total)"><span class="io-direction">R</span>{{ speed(values(row)?.block_read_bytes_per_second) }}</div>
                            <div class="io-line" :title="totalTitle('resourceWrite', values(row)?.block_write_bytes_total)"><span class="io-direction">W</span>{{ speed(values(row)?.block_write_bytes_per_second) }}</div>
                        </td>
                        <td class="metric-value">{{ values(row)?.pids ?? '—' }}</td>
                        <td class="terminal-cell">
                            <router-link v-if="terminalAvailable(row)" class="btn btn-sm btn-normal" :to="terminalRoute(row.service)" :title="$t('resourceOpenTerminal')">
                                <font-awesome-icon icon="terminal" /><span class="visually-hidden">{{ $t('resourceOpenTerminal') }}</span>
                            </router-link>
                        </td>
                    </tr>
                    <tr v-if="!rows.length"><td colspan="7" class="empty-resources">{{ $t("resourcesNoContainers") }}</td></tr>
                </tbody>
            </table>
        </div>
        <footer class="resource-footer">
            <span>{{ $t("resourcesRefreshHint") }}</span>
            <span>{{ $t("resourceIOHint") }}</span>
        </footer>
    </section>
</template>

<script>
import { parseDockerPort } from "../../../common/util-common";

export default {
    props: {
        stackName: { type: String,
            required: true },
        services: { type: Object,
            default: () => ({}) },
        serviceStatus: { type: Object,
            default: () => ({}) },
    },
    data: () => ({
        snapshot: { containers: [],
            sampled_at: null,
            stale: false,
            status: "starting",
            error: null },
        connected: false,
        subscriptionError: "",
        clock: Date.now(),
    }),
    computed: {
        live() {
            return this.connected && this.snapshot.status === "ready" && !this.stale;
        },
        stale() {
            return this.snapshot.stale || (this.snapshot.sampled_at !== null && this.clock - this.snapshot.sampled_at > 10000);
        },
        statusText() {
            if (!this.connected) {
                return this.$t("resourcesDisconnected");
            }
            if (this.snapshot.status === "starting") {
                return this.$t("resourcesLoading");
            }
            if (!this.live) {
                return this.$t("resourcesUnavailable");
            }
            return this.$t("resourcesLive");
        },
        rows() {
            const containers = this.snapshot.containers.filter(row => row.stack === this.stackName);
            const names = new Set(containers.map(row => row.service));
            const placeholders = Object.entries(this.services).filter(([ name ]) => !names.has(name)).map(([ name, service ]) => ({
                id: "service:" + name,
                name,
                service: name,
                image: service.image || "",
                state: this.serviceStatus[name] || (this.snapshot.status === "starting" ? this.$t("resourcesLoading") : this.$t("resourceNotStarted")),
                values: null,
                available: false,
            }));
            return [ ...containers, ...placeholders ].sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
        },
    },
    watch: {
        stackName() {
            this.snapshot = { containers: [],
                sampled_at: null,
                stale: false,
                status: "starting",
                error: null };
            this.subscribe();
        },
        "$root.loggedIn"(loggedIn) {
            if (loggedIn && this.connected) {
                this.subscribe();
            }
        },
    },
    mounted() {
        const socket = this.$root.getSocket();
        this.receiveSnapshot = snapshot => {
            if (snapshot.stack === this.stackName) {
                this.snapshot = snapshot;
                this.subscriptionError = "";
                this.clock = Date.now();
            }
        };
        this.connectHandler = () => {
            this.connected = true;
            this.snapshot = { containers: [],
                sampled_at: null,
                stale: false,
                status: "starting",
                error: null };
            // afterLogin is asynchronous on reconnect; let the root finish authentication.
            this.subscribe();
        };
        this.disconnectHandler = () => {
            this.connected = false;
        };
        socket.on("containerResources", this.receiveSnapshot);
        socket.on("connect", this.connectHandler);
        socket.on("disconnect", this.disconnectHandler);
        this.clockTimer = setInterval(() => {
            this.clock = Date.now();
        }, 1000);
        this.connected = socket.connected;
        if (this.connected) {
            this.subscribe();
        }
    },
    beforeUnmount() {
        this.disposed = true;
        clearInterval(this.clockTimer);
        clearTimeout(this.retryTimer);
        const socket = this.$root.getSocket();
        socket.off("containerResources", this.receiveSnapshot);
        socket.off("connect", this.connectHandler);
        socket.off("disconnect", this.disconnectHandler);
        if (socket.connected) {
            socket.emit("unsubscribeContainerResources", () => {});
        }
    },
    methods: {
        portLink(port) {
            const hostname = this.$root.info.primaryHostname || location.hostname;
            if (port && typeof port === "object") {
                const protocol = port.protocol || "tcp";
                const display = String(port.published ?? port.target) + "/" + protocol;
                if (port.published == null) {
                    return { display };
                }
                const host = port.host_ip && ![ "0.0.0.0", "::" ].includes(port.host_ip) ? port.host_ip : hostname;
                const bracketed = host.includes(":") && !host.startsWith("[") ? "[" + host + "]" : host;
                const scheme = String(port.published) === "443" ? "https" : protocol === "tcp" ? "http" : protocol;
                return { display,
                    url: scheme + "://" + bracketed + ":" + String(port.published).split("-")[0] };
            }
            return parseDockerPort(String(port), hostname);
        },
        subscribe() {
            clearTimeout(this.retryTimer);
            if (this.disposed || !this.connected || !this.stackName) {
                return;
            }
            const requested = this.stackName;
            this.$root.getSocket().timeout(5000).emit("subscribeContainerResources", { stack: requested }, (error, response) => {
                if (this.disposed || requested !== this.stackName) {
                    return;
                }
                if (error || !response?.ok) {
                    this.subscriptionError = this.$t("resourcesUnavailable");
                    this.retryTimer = setTimeout(() => this.subscribe(), 3000);
                } else {
                    this.receiveSnapshot(response.snapshot);
                }
            });
        },
        values(row) {
            return this.connected && !this.stale && row.available ? row.values : null;
        },
        bytes(value) {
            if (value == null || !Number.isFinite(value)) {
                return "—";
            }
            const units = [ "B", "KiB", "MiB", "GiB", "TiB" ];
            let index = 0;
            while (value >= 1024 && index < units.length - 1) {
                value /= 1024;
                index++;
            }
            return value.toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 }) + " " + units[index];
        },
        speed(value) {
            return value == null ? "—" : this.bytes(value) + "/s";
        },
        percentage(value) {
            return value == null ? "—" : value.toLocaleString(undefined, { minimumFractionDigits: 1,
                maximumFractionDigits: 1 }) + "%";
        },
        bar(value) {
            return Math.min(100, Math.max(0, value || 0)) + "%";
        },
        totalTitle(label, value) {
            return this.$t(label) + " · " + this.$t("resourceTotal") + " " + this.bytes(value);
        },
        terminalAvailable(row) {
            // Existing compose exec selects a service. Avoid pointing replica rows at the wrong container.
            return row.state === "running" && this.snapshot.containers.filter(item => item.service === row.service && item.state === "running").length === 1;
        },
        terminalRoute(serviceName) {
            return { name: "containerTerminal",
                params: { stackName: this.stackName,
                    serviceName,
                    type: "bash" } };
        },
    },
};
</script>

<style scoped lang="scss">
@import "../styles/vars";
.resource-panel {
    --resource-surface: #fff;
    --resource-muted: #6d7887;
    --resource-border: rgba(100, 120, 145, 0.15);
    padding: 0;
    border-radius: 14px;
    overflow: hidden;
    border: 1px solid var(--resource-border);
}
.resource-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 18px 22px;
    h4 { margin: 0; font-size: 1rem; font-weight: 650; }
}
.resource-count {
    color: var(--resource-muted);
    margin-left: 6px;
    font-size: 0.8rem;
    font-weight: 400;
}
.sample-status { display: flex; align-items: center; gap: 7px; color: var(--resource-muted); font-size: 0.75rem; }
.status-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--resource-muted); }
.sample-status.live .status-dot { background: #42b883; box-shadow: 0 0 0 4px rgba(66, 184, 131, 0.12); }
.resource-scroll { overflow-x: auto; scrollbar-width: thin; }
.resource-table {
    width: 100%;
    min-width: 850px;
    border-collapse: collapse;
    font-size: 0.8rem;
    th, td { padding: 16px 18px; text-align: left; vertical-align: middle; border-top: 1px solid var(--resource-border); }
    thead th { padding-block: 10px; color: var(--resource-muted); font-size: 0.68rem; letter-spacing: 0.045em; text-transform: uppercase; font-weight: 600; background: rgba(116, 194, 255, 0.045); }
    thead th:first-child, .identity-cell { position: sticky; left: 0; background: var(--resource-surface); z-index: 1; }
    tbody tr:hover td, tbody tr:hover .identity-cell { background: color-mix(in srgb, var(--resource-surface) 96%, #74c2ff); }
}
.identity-cell { min-width: 220px; max-width: 320px; font-weight: 400; }
.container-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.container-name { font-weight: 650; overflow-wrap: anywhere; }
.container-image { display: block; color: var(--resource-muted); font-size: 0.72rem; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; max-width: 270px; white-space: nowrap; }
.container-ports { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 5px; a { font-size: 0.65rem; color: #4b9cc6; text-decoration: none; } a:hover { text-decoration: underline; } }
.service-name { display: block; color: var(--resource-muted); font-size: 0.65rem; margin-top: 3px; }
.state-pill { border-radius: 5px; padding: 2px 6px; background: rgba(100, 120, 145, 0.12); color: var(--resource-muted); font-size: 0.6rem; font-weight: 500; }
.state-pill.running { color: #288861; background: rgba(66, 184, 131, 0.12); }
.state-pill.unhealthy { color: #dc3545; background: rgba(220, 53, 69, 0.12); }
.state-pill.starting { color: #ba882b; background: rgba(186, 136, 43, 0.12); }
.metric-value, .io-line { font-variant-numeric: tabular-nums; font-family: "JetBrains Mono", monospace; white-space: nowrap; }
.cpu-cell { min-width: 100px; }
.memory-cell { min-width: 165px; }
.metric-secondary { display: block; color: var(--resource-muted); font-size: 0.65rem; white-space: nowrap; margin-top: 2px; }
.metric-track { height: 3px; width: 84px; background: rgba(116, 194, 255, 0.12); border-radius: 4px; overflow: hidden; margin-top: 8px; }
.metric-track span { display: block; height: 100%; background: $primary; transition: width 0.5s ease; }
.memory-track { width: 120px; }
.memory-track span { background: #65cba3; }
.io-line { display: flex; gap: 8px; font-size: 0.73rem; line-height: 1.85; }
.io-direction { color: var(--resource-muted); font-size: 0.65rem; width: 10px; }
.terminal-cell { width: 54px; }
.resource-footer { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; border-top: 1px solid var(--resource-border); padding: 10px 22px; font-size: 0.65rem; color: var(--resource-muted); }
.resource-notice { color: #bb822d; padding: 0 22px 12px; font-size: 0.75rem; }
.empty-resources { text-align: center !important; padding: 28px !important; color: var(--resource-muted); }
.dark .resource-panel { --resource-surface: #0d1117; --resource-muted: #8493a6; --resource-border: #1d2634; }
.dark .state-pill.running { color: #83d9b5; }
.dark .state-pill.unhealthy { color: #f0808b; }
.dark .state-pill.starting { color: #e7b55a; }
@media (max-width: 600px) {
    .resource-header { padding: 16px; }
    .resource-table th, .resource-table td { padding-inline: 12px; }
    .identity-cell { min-width: 155px; max-width: 155px; }
    .container-image { max-width: 135px; }
    .resource-footer { padding-inline: 16px; }
}
</style>
