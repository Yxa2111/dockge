export class ApiError extends Error {
    constructor(public status: number, public code: string, message: string) {
        super(message);
    }
}

export const permissions = { read: 0,
    operate: 1,
    manage: 2 };
export type Permission = keyof typeof permissions;

export function requirePermission(actual: Permission, required: Permission) {
    if (!Object.hasOwn(permissions, actual) || permissions[actual] < permissions[required]) {
        throw new ApiError(403, "forbidden", `This operation requires ${required} permission.`);
    }
}

export function integer(value: unknown, fallback: number, max: number, min = 0): number {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max || Number(value) < min) {
        throw new ApiError(400, "invalid_parameter", `Expected an integer between ${min} and ${max}.`);
    }
    return Number(value);
}
