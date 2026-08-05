// CRUD capability v1 — platform infrastructure, do not edit.
//
// The one supported way generated app code talks to entities. Wraps the backend SDK's
// db.entity() with a stable, minimal surface; records come back flat as { id, ...fields }
// so screens never touch row internals. Persistence NEVER lives in components — components
// import a store made here (usually via a src/data/ module that names the entity once).

import { db } from "../backend";

function flatten(row) {
  if (!row) return null;
  return { id: row.id, createdAt: row.created_at, ...(row.data || {}) };
}

export function makeEntityStore(type) {
  const entity = () => db.entity(type);
  return {
    async list(options = {}) {
      return (await entity().list(options)).map(flatten);
    },
    async get(id) {
      return flatten(await entity().get(id));
    },
    async create(values) {
      return flatten(await entity().create(values));
    },
    async update(id, values) {
      // The SDK's update REPLACES row.data wholesale; this surface keeps the read-modify-write
      // recipe in ONE place so no screen ever loses fields by "updating" with a partial object.
      const current = await entity().get(id);
      return flatten(await entity().update(id, { ...(current?.data || {}), ...values }));
    },
    async remove(id) {
      await entity().delete(id);
    },
    async count(filters = {}) {
      return entity().count(filters);
    },
    subscribe(callback) {
      return entity().subscribe(callback);
    },
  };
}
