import { test } from "node:test";
import assert from "node:assert/strict";
import { grad, lardom, likhet, words } from "../lib/larande.js";

test("likheten räknas på ord i ordning, utan frågemarkeringar", () => {
  assert.deepEqual(words("Hej Kim! [[FRÅGA: pris?]] Det går bra."), ["hej", "kim", "det", "går", "bra"]);
  assert.equal(likhet("Det går bra att byta.", "det går bra att byta"), 1);
  assert.equal(likhet("", ""), 1);
  assert.equal(likhet("Hej", ""), 0);
  assert.equal(likhet("ett två tre fyra", "fem sex sju åtta"), 0);
  // One word changed out of ten: still almost the same.
  assert.ok(likhet("a b c d e f g h i j", "a b c d e f g h i x") >= 0.9);
  // The same words in another order are not the same answer.
  assert.ok(likhet("a b c d", "d c b a") < 0.5);
});

test("graden säger vad som hände med utkastet", () => {
  assert.equal(grad({ atgard: "utkast", likhet: 0.95 }), "skickat nästan som det var");
  assert.equal(grad({ atgard: "utkast", likhet: 0.6 }), "ändrat");
  assert.equal(grad({ atgard: "utkast", likhet: 0.2 }), "omskrivet");
  assert.equal(grad({ atgard: "hoppa_over", likhet: 0 }), "missat svar");
});

test("lärdomen kommer genom verktyget, och ett trasigt svar blir ett fel", async () => {
  const calls = [];
  const reply = (res) => ({ beta: { messages: { async create(req) { calls.push(req); return res; } } } });
  const client = (input) => reply({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(input) }] });
  const out = await lardom({ client: client({ typ: "regel", lardom: " Byte går i mån av plats. ", regelforslag: "Byte av kurs går i mån av plats." }), model: "m", fraga: "F", utkast: "", skickat: "S" });
  assert.deepEqual(out, { typ: "regel", lardom: "Byte går i mån av plats.", regelforslag: "Byte av kurs går i mån av plats." });
  assert.equal(calls[0].output_config.format.type, "json_schema");
  assert.equal(calls[0].output_config.format.schema.additionalProperties, false);
  assert.match(calls[0].messages[0].content, /<utkast>\nAgenten skrev inget utkast/);
  await assert.rejects(lardom({ client: client({ typ: "påhittat" }), model: "m", fraga: "F", utkast: "U", skickat: "S" }), /ingen lärdom/);
  // A refusal, a cut-off answer and broken JSON become errors for that mail, not a crash.
  await assert.rejects(lardom({ client: reply({ stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }), model: "m", fraga: "F", utkast: "U", skickat: "S" }), /^Error: Modellen avböjde \(cyber\)$/);
  await assert.rejects(lardom({ client: reply({ stop_reason: "max_tokens", content: [{ type: "text", text: "{" }] }), model: "m", fraga: "F", utkast: "U", skickat: "S" }), /för långt/);
  await assert.rejects(lardom({ client: reply({ stop_reason: "end_turn", content: [{ type: "text", text: "inte json" }] }), model: "m", fraga: "F", utkast: "U", skickat: "S" }), /inget giltigt svar/);
});

test("veckonumret följer ISO, och en vecka utan lärdomar säger det", async () => {
  const { isoWeek, reportText } = await import("../lib/rapport.js");
  assert.equal(isoWeek(new Date("2026-11-30T06:00:00Z")), 49);
  assert.equal(isoWeek(new Date("2027-01-01T06:00:00Z")), 53);
  assert.equal(isoWeek(new Date("2027-01-04T06:00:00Z")), 1);
  const text = reportText({ utkast: 0, hoppade: 2, fel: 0, kategorier: [], grader: [], lardomar: [] }, undefined, { vecka: 1 });
  assert.match(text, /Inga utkast har jämförts med skickade svar än/);
  assert.doesNotMatch(text, /FÖRSLAG/);
});
