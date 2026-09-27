<template>
    <div class="api-keys my-4">
        <p class="text-secondary">{{ $t("apiKeysIntro") }}</p>
        <a class="btn btn-outline-primary mb-4" href="/api/docs/" target="_blank" rel="noopener noreferrer">{{ $t("apiDocumentation") }} ↗</a>
        <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>
        <form v-if="authDisabled && !unlocked" class="mb-4" @submit.prevent="unlock">
            <label class="form-label" for="api-admin-password">{{ $t("apiAdminPassword") }}</label>
            <p class="small text-secondary">{{ $t("apiPasswordExplanation") }}</p>
            <input id="api-admin-password" v-model="password" type="password" autocomplete="current-password" class="form-control mb-3" required>
            <button class="btn btn-primary" :disabled="busy">{{ $t("apiUnlock") }}</button>
        </form>
        <template v-else>
            <section v-if="secret" class="alert alert-success" aria-live="polite">
                <h6>{{ $t("apiCopyNow") }}</h6>
                <p class="small">{{ $t("apiShownOnce") }}</p>
                <textarea ref="secretField" :value="secret" class="form-control font-monospace mb-3" rows="2" readonly :aria-label="$t('apiNewKey')"></textarea>
                <button type="button" class="btn btn-success me-2" @click="copy">{{ copied ? $t("apiCopied") : $t("apiCopy") }}</button>
                <button type="button" class="btn btn-outline-secondary" @click="secret = ''">{{ $t("apiDismiss") }}</button>
            </section>
            <form class="key-form mb-5" @submit.prevent="create">
                <h6 class="mb-3">{{ $t("apiCreateKey") }}</h6>
                <div class="mb-3">
                    <label for="api-key-name" class="form-label">{{ $t("apiKeyName") }}</label>
                    <input id="api-key-name" v-model="name" class="form-control" maxlength="100" required :placeholder="$t('apiNamePlaceholder')">
                </div>
                <fieldset class="mb-3">
                    <legend class="fs-6">{{ $t("apiPermission") }}</legend>
                    <label v-for="level in levels" :key="level" class="permission-choice" :class="{ selected: permission === level }">
                        <input v-model="permission" class="form-check-input mt-1" type="radio" name="api-permission" :value="level">
                        <span><strong>{{ $t('apiPermission_' + level) }}</strong><small class="d-block text-secondary">{{ $t('apiPermissionDescription_' + level) }}</small></span>
                    </label>
                </fieldset>
                <div class="mb-3">
                    <label for="api-key-expiry" class="form-label">{{ $t("apiExpiry") }}</label>
                    <input id="api-key-expiry" v-model="expiry" class="form-control" type="datetime-local">
                    <div class="form-text">{{ $t("apiExpiryHint") }}</div>
                </div>
                <button class="btn btn-primary" :disabled="busy || !!secret">{{ busy ? $t("apiWorking") : $t("apiCreateKey") }}</button>
            </form>
            <div class="d-flex align-items-center justify-content-between mb-3">
                <h6 class="mb-0">{{ $t("apiExistingKeys") }}</h6>
                <button class="btn btn-sm btn-outline-secondary" :disabled="busy" @click="refresh">{{ $t("apiRefresh") }}</button>
            </div>
            <p v-if="loading" role="status" class="text-secondary">{{ $t("apiLoading") }}</p>
            <p v-else-if="!keys.length" class="empty-keys text-secondary">{{ $t("apiNoKeys") }}</p>
            <article v-for="key in keys" :key="key.id" class="key-row">
                <div class="d-flex justify-content-between align-items-start gap-3">
                    <div class="key-identity">
                        <strong>{{ key.name }}</strong>
                        <span class="badge rounded-pill ms-2" :class="isActive(key) ? 'bg-success' : 'bg-secondary'">{{ status(key) }}</span>
                        <code class="d-block mt-1">{{ key.prefix }}…</code>
                    </div>
                    <button v-if="!key.revoked_at" class="btn btn-sm btn-outline-danger" :disabled="busy" @click="confirmRevoke(key)">{{ $t("apiRevoke") }}</button>
                </div>
                <div class="small text-secondary mt-2">
                    {{ $t('apiPermission_' + key.permission) }} · {{ $t("apiCreated") }} {{ date(key.created_at) }}<br>
                    {{ $t("apiLastUsed") }} {{ date(key.last_used_at) }} · {{ $t("apiExpires") }} {{ key.expires_at ? date(key.expires_at) : $t("apiNeverExpires") }}
                </div>
            </article>
        </template>
        <Confirm ref="revokeDialog" btn-style="btn-danger" :yes-text="$t('apiRevoke')" :no-text="$t('Cancel')" @yes="revoke">
            {{ $t("apiRevokeConfirm", { name: pendingKey?.name || '' }) }}
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../Confirm.vue";

export default {
    components: { Confirm },
    data: () => ({
        keys: [],
        levels: [ "read", "operate", "manage" ],
        name: "",
        permission: "read",
        expiry: "",
        password: "",
        unlocked: false,
        secret: "",
        copied: false,
        busy: false,
        loading: false,
        error: "",
        pendingKey: null,
    }),
    computed: {
        authDisabled() {
            return this.$root.socketIO.token === "autoLogin";
        },
    },
    mounted() {
        if (!this.authDisabled) {
            this.refresh();
        }
    },
    beforeUnmount() {
        this.secret = "";
        this.password = "";
    },
    methods: {
        request(event, data = {}) {
            return new Promise((resolve, reject) => {
                this.$root.getSocket().timeout(15000).emit(event, { ...data,
                    password: this.password }, (error, result) => {
                    if (error) {
                        reject(new Error(this.$t("apiRequestTimeout")));
                    } else if (!result?.ok) {
                        reject(new Error(result?.msg || this.$t("apiRequestFailed")));
                    } else {
                        resolve(result);
                    }
                });
            });
        },
        async run(work) {
            this.busy = true;
            this.error = "";
            try {
                await work();
            } catch (error) {
                this.error = error.message;
            } finally {
                this.busy = false;
            }
        },
        async load() {
            this.loading = true;
            try {
                this.keys = (await this.request("listApiKeys")).keys;
            } finally {
                this.loading = false;
            }
        },
        refresh() {
            return this.run(() => this.load());
        },
        unlock() {
            return this.run(async () => {
                await this.load();
                this.unlocked = true;
            });
        },
        create() {
            return this.run(async () => {
                const expiresAt = this.expiry ? new Date(this.expiry).getTime() : null;
                if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
                    throw new Error(this.$t("apiInvalidExpiry"));
                }
                const result = await this.request("createApiKey", { name: this.name,
                    permission: this.permission,
                    expires_at: expiresAt });
                this.secret = result.secret;
                this.copied = false;
                this.name = "";
                await this.load();
            });
        },
        confirmRevoke(key) {
            this.pendingKey = key;
            this.$refs.revokeDialog.show();
        },
        revoke() {
            return this.run(async () => {
                await this.request("revokeApiKey", { id: this.pendingKey.id });
                if (this.secret.startsWith(this.pendingKey.prefix)) {
                    this.secret = "";
                }
                this.pendingKey = null;
                await this.load();
            });
        },
        async copy() {
            try {
                await navigator.clipboard.writeText(this.secret);
                this.copied = true;
            } catch {
                this.$refs.secretField.focus();
                this.$refs.secretField.select();
            }
        },
        date(value) {
            return value ? new Date(Number(value)).toLocaleString() : this.$t("apiNeverUsed");
        },
        isActive(key) {
            return !key.revoked_at && (!key.expires_at || Number(key.expires_at) > Date.now());
        },
        status(key) {
            return this.$t(key.revoked_at ? "apiRevoked" : this.isActive(key) ? "apiActive" : "apiExpired");
        },
    },
};
</script>

<style scoped lang="scss">
.permission-choice {
    display: flex;
    gap: 0.85rem;
    padding: 0.85rem 1rem;
    margin-bottom: 0.5rem;
    border: 1px solid var(--bs-border-color);
    border-radius: 0.65rem;
    cursor: pointer;
    &.selected {
        border-color: var(--bs-primary);
        background: rgba(92, 221, 139, 0.06);
    }
}
.key-row {
    padding: 1rem 0;
    border-bottom: 1px solid var(--bs-border-color);
}
.key-identity {
    min-width: 0;
    overflow-wrap: anywhere;
}
.empty-keys {
    padding: 1.5rem;
    text-align: center;
    border: 1px dashed var(--bs-border-color);
    border-radius: 0.65rem;
}
</style>
