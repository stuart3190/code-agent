import assert from "node:assert/strict";
import { cleanTemplateText } from "../shell/server/lib/templates.mjs";

assert.equal(cleanTemplateText("  Premium\n  SaaS   starter  ", 100), "Premium SaaS starter");
assert.equal(cleanTemplateText("x".repeat(120), 20).length, 20);
assert.equal(cleanTemplateText(null, 20), "");

console.log("Template tests passed");
