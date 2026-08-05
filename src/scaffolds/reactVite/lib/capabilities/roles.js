// Roles/ownership capability v1 — platform infrastructure, do not edit.
//
// RLS already ENFORCES ownership server-side; these helpers let screens make honest
// decisions client-side (show an edit button, hide a delete) without inventing their own
// ownership logic per component.

export function isOwner(row, user) {
  if (!row || !user) return false;
  return row.owner === user.id;
}

export function requireOwner(row, user) {
  if (!isOwner(row, user)) {
    throw new Error("You do not have permission to change this record.");
  }
  return row;
}
