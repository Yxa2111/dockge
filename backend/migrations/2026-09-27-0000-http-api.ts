import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("api_key", (table) => {
        table.string("id", 36).primary();
        table.string("name", 100).notNullable();
        table.string("prefix", 20).notNullable();
        table.string("digest", 64).notNullable().unique();
        table.string("permission", 16).notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("expires_at").nullable();
        table.bigInteger("last_used_at").nullable();
        table.bigInteger("revoked_at").nullable();
    });
    await knex.schema.createTable("api_operation", (table) => {
        table.string("id", 36).primary();
        table.string("stack", 200).notNullable().index();
        table.string("action", 16).notNullable();
        table.string("key_id", 36).notNullable();
        table.string("state", 16).notNullable();
        table.bigInteger("created_at").notNullable();
        table.bigInteger("finished_at").nullable().index();
        table.integer("exit_code").nullable();
        table.text("error").nullable();
        table.boolean("truncated").notNullable().defaultTo(false);
        table.string("idempotency_key", 200).nullable();
        table.unique([ "key_id", "idempotency_key" ]);
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("api_operation");
    await knex.schema.dropTable("api_key");
}
