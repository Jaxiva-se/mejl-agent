#!/usr/bin/env node
/*
  Veckorapporten: lägger ett mejl i inkorgen med veckans siffror, vad agenten lärt sig och
  förslag på nya regler. Körs varje måndag morgon från .github/workflows/mejl.yml.

  Miljö som kor.mjs. Valfritt: MEJL_RAPPORT_SVAR, adressen som svar på rapporten ska gå till
  (annars brevlådan själv). Svarar man från brevlådan läser nästa körning svaret i skickat
  och lägger in de valda förslagen i regler.md (lib/regelsvar.js).

  Skriver bara antal, aldrig avsändare eller innehåll.
*/
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getState, open, setState } from "./lib/db.js";
import { connect } from "./lib/imap.js";
import { anthropic } from "./lib/claude.js";
import { collect, composeReport, isoWeek, reportText, summarize } from "./lib/rapport.js";

const RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "regler.md");

export async function report({ env = process.env, ai, now = new Date(), log = console.log } = {}) {
  const model = env.CLAUDE_MODEL || "claude-sonnet-5-5";
  const db = await open(env);
  try {
    const stats = await collect(db, { now });
    let summary;
    if (stats.lardomar.length) {
      const regler = await readFile(env.MEJL_REGLER || RULES, "utf8").catch(() => "");
      summary = await summarize({ client: ai ?? anthropic(env), model, lardomar: stats.lardomar, regler });
    }
    const vecka = isoWeek(now);
    // Rules added from replies since the last report: each is listed once.
    const tillagda = JSON.parse((await getState(db, "regler:tillagda")) || "[]");
    const nyaRegler = tillagda.filter((r) => !r.rapporterad).map((r) => r.regel);
    const text = reportText(stats, summary, { vecka, nyaRegler });
    const brevlada = env.MEJL_IMAP_USER;
    // The id lets the run recognise a reply to this report in the sent folder.
    const messageId = `rapport-${vecka}-${now.getTime()}@mejlagenten`;
    const raw = await composeReport({ till: brevlada, fran: env.MEJL_FRAN || brevlada, svarTill: env.MEJL_RAPPORT_SVAR, vecka, text, messageId });

    const client = connect(env);
    await client.connect();
    try {
      await client.append("INBOX", raw);
    } finally {
      await client.logout().catch(() => {});
    }
    await setState(db, "rapport:senast", now.toISOString());
    if (nyaRegler.length) await setState(db, "regler:tillagda", JSON.stringify(tillagda.map((r) => ({ ...r, rapporterad: true }))));
    await setState(db, `rapport:${messageId}`, JSON.stringify({ vecka, forslag: summary?.forslag ?? [], besvarad: false }));
    log(`Veckorapport vecka ${vecka}: ${stats.utkast} utkast, ${stats.lardomar.length} lärdomar, ${summary?.forslag.length ?? 0} förslag på regler`);
    return { vecka, stats, summary, text, messageId };
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  report().catch((e) => {
    console.error(`Rapporten stannade: ${e.message}`);
    process.exit(1);
  });
}
