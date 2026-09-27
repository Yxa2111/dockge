import { createHash, randomBytes, randomUUID } from "node:crypto";
import { R } from "redbean-node";
import { ApiError, Permission, permissions } from "./errors";

export interface ApiKey {
    id: string;
    name: string;
    prefix: string;
    permission: Permission;
    created_at: number;
    expires_at: number | null;
    last_used_at: number | null;
    revoked_at: number | null;
}

const publicColumns = [ "id", "name", "prefix", "permission", "created_at", "expires_at", "last_used_at", "revoked_at" ];
const digest = (secret: string) => createHash("sha256").update(secret).digest("hex");

export class ApiKeys {
    static async create(name: unknown, permission: unknown, expiresAt: unknown) {
        if (typeof name !== "string" || !name.trim() || name.length > 100 || typeof permission !== "string" || !Object.hasOwn(permissions, permission)) {
            throw new ApiError(400, "invalid_key", "Provide a name (1–100 characters) and read, operate or manage permission.");
        }
        if (expiresAt !== null && expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now())) {
            throw new ApiError(400, "invalid_expiry", "Expiry must be a future Unix timestamp in milliseconds.");
        }
        const secret = "dg_" + randomBytes(32).toString("base64url");
        const key: ApiKey = {
            id: randomUUID(),
            name: name.trim(),
            prefix: secret.slice(0, 11),
            permission: permission as Permission,
            created_at: Date.now(),
            expires_at: expiresAt as number ?? null,
            last_used_at: null,
            revoked_at: null,
        };
        await R.knex("api_key").insert({ ...key,
            digest: digest(secret) });
        return { key,
            secret };
    }

    static async list(): Promise<ApiKey[]> {
        return R.knex("api_key").select(publicColumns).orderBy("created_at", "desc");
    }

    static async revoke(id: unknown) {
        if (typeof id !== "string") {
            throw new ApiError(400, "invalid_key", "Invalid Key ID.");
        }
        const count = await R.knex("api_key").where({ id }).update({ revoked_at: Date.now() });
        if (!count) {
            throw new ApiError(404, "key_not_found", "API Key not found.");
        }
    }

    static async authenticate(header: string | undefined): Promise<ApiKey> {
        if (!header || !/^Bearer dg_[A-Za-z0-9_-]{43}$/.test(header)) {
            throw new ApiError(401, "unauthorized", "A valid Bearer API Key is required.");
        }
        const key = await R.knex("api_key").select(publicColumns).where({ digest: digest(header.slice(7)) }).first() as ApiKey | undefined;
        if (!key || key.revoked_at !== null || (key.expires_at !== null && Number(key.expires_at) <= Date.now())) {
            throw new ApiError(401, "unauthorized", "API Key is invalid, expired or revoked.");
        }
        await R.knex("api_key").where({ id: key.id }).update({ last_used_at: Date.now() });
        return key;
    }
}
