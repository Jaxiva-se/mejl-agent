#!/usr/bin/env node
/*
  En körning av mejlagenten: nya mejl i inkorgen sparas i arkivet, och de som väntar på svar får
  ett utkast i utkastmappen, i samma tråd. Ingenting skickas.

  Första körningen börjar vid det som kommer från och med nu. Gamla mejl i inkorgen får inga
  utkast (de läses in med importera.mjs).

  Varje körning läser också nya mejl i skickat till arkivet och jämför kontorets svar med
  agentens utkast (lib/larande.js).

  Miljö: MEJL_IMAP_HOST, MEJL_IMAP_USER, MEJL_IMAP_PASSWORD, ANTHROPIC_API_KEY, och för databasen
  MEJL_D1_DATABASE_ID, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN. Valfritt: MEJL_UTKASTMAPP,
  MEJL_FRAN, MEJL_EGNA (våra egna adresser, kommaseparerade), MEJL_MAX (mejl per körning, 10),
  CLAUDE_MODEL.

  Skriver bara antal och kategorier, aldrig avsändare eller innehåll.
*/
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getState, hasDraft, maxUid, open, saveDraft, saveMail, setState, similarAnswered } from "./lib/db.js";
import { appendDraft, connect, ensureFolder, findFolder, flaggedIds, readFolder } from "./lib/imap.js";
import { knowledge } from "./lib/kunskap.js";
import { compareAll } from "./lib/larande.js";
import { appendRules, interpretReply } from "./lib/regelsvar.js";
import { ftsQuery, parseMail, skipReason } from "./lib/text.js";
import { anthropic, composeReply, writeDraft } from "./lib/utkast.js";

const RULES = path.join(path.dirname(fileURLToPath(import.meta.url)), "regler.md");

/** The stored weekly report a mail replies to, or null. */
async function reportFor(db, svarPa) {
  if (!svarPa) return null;
  const v = await getState(db, `rapport:${svarPa}`);
  return v === null ? null : { key: `rapport:${svarPa}`, ...JSON.parse(v) };
}

export async function run({ env = process.env, ai, log = console.log } = {}) {
  const model = env.CLAUDE_MODEL || "claude-sonnet-5-5";
  const max = Number(env.MEJL_MAX || 10);
  const fran = env.MEJL_FRAN || env.MEJL_IMAP_USER;
  const egna = [env.MEJL_IMAP_USER, ...(env.MEJL_EGNA || "").split(",")].map((s) => (s ?? "").trim().toLowerCase()).filter(Boolean);
  const stats = { nya: 0, utkast: 0, hoppade: 0, fel: 0, kategorier: {}, skal: {}, skickade: 0, jamforda: 0, grader: {}, larfel: 0, nyaRegler: [] };

  const db = await open(env);
  const client = connect(env);
  await client.connect();
  try {
    // What the office has sent since last time goes into the archive, so that it is there as an
    // earlier answer, and each answer is compared with the agent's draft to the same mail.
    const sent = env.MEJL_SKICKATMAPP || (await findFolder(client, "\\Sent"));
    if (sent) {
      const box = await readFolder(client, sent);
      const sentKey = `skickat:${box.uidValidity}`;
      let after = await getState(db, sentKey);
      // First time: start after what the import already read, or else at now.
      if (after === null) await setState(db, sentKey, (after = (await maxUid(db, sent)) ?? box.uidNext - 1));
      const batch = [];
      const replies = [];
      let last = Number(after);
      await readFolder(client, sent, { after: last, limit: 200 }, async ({ uid, raw }) => {
        try {
          const m = await parseMail(raw, { mapp: sent, uid, riktning: "ut" });
          // A reply to the weekly report chooses rules; it is not an answer to a customer.
          const rapport = await reportFor(db, m.svarPa);
          if (rapport) replies.push({ m, rapport });
          else batch.push(m);
        } catch {
          // An unreadable sent mail has nothing to teach; it is passed over.
        }
        last = uid;
      });
      if (batch.length) await saveMail(db, batch);
      for (const { m, rapport } of replies) {
        if (rapport.besvarad || !rapport.forslag?.length) continue;
        const { regler } = await interpretReply({ client: (ai ??= anthropic(env)), model, forslag: rapport.forslag, svar: m.text });
        const added = await appendRules(env.MEJL_REGLER || RULES, regler, { vecka: rapport.vecka });
        const tillagda = JSON.parse((await getState(db, "regler:tillagda")) || "[]");
        const datum = new Date().toISOString();
        await setState(db, "regler:tillagda", JSON.stringify([...tillagda, ...added.map((regel) => ({ regel, datum, vecka: rapport.vecka }))].slice(-200)));
        await setState(db, rapport.key, JSON.stringify({ ...rapport, key: undefined, besvarad: true }));
        stats.nyaRegler.push(...added);
      }
      if (last > Number(after)) await setState(db, sentKey, last);
      stats.skickade = batch.length;
      const learned = await compareAll(db, { ai: () => (ai ??= anthropic(env)), model, max });
      Object.assign(stats, { jamforda: learned.jamforda, grader: learned.grader, larfel: learned.fel });
    }

    // Where the inbox is right now. The key holds UIDVALIDITY: if the server renumbers the
    // folder, we start over from "now" instead of answering everything again.
    const info = await readFolder(client, "INBOX");
    const key = `inkorg:${info.uidValidity}`;
    let stored = await getState(db, key);
    if (stored === null) {
      // A trial (MEJL_PROV_SENASTE) starts a few mails back, so they get drafts at once.
      const back = Math.max(0, Number(env.MEJL_PROV_SENASTE || 0));
      stored = Math.max(0, info.uidNext - 1 - back);
      await setState(db, key, stored);
      if (!back) {
        log("Första körningen: agenten börjar med mejl som kommer från och med nu.");
        return stats;
      }
      log(`Prov: de senaste ${back} mejlen i inkorgen får utkast.`);
    }

    const incoming = [];
    await readFolder(client, "INBOX", { after: Number(stored), limit: max }, async (m) => incoming.push(m));
    if (!incoming.length) return stats;

    const drafts = env.MEJL_UTKASTMAPP ? await ensureFolder(client, env.MEJL_UTKASTMAPP) : await findFolder(client, "\\Drafts");
    if (!drafts) throw new Error("Hittar ingen utkastmapp. Sätt MEJL_UTKASTMAPP.");
    const kunskap = await knowledge(env);
    // Threads where a mail in the inbox is flagged are handled by a person: no drafts there.
    const flagged = await flaggedIds(client, "INBOX");

    for (const { uid, flags, raw } of incoming) {
      stats.nya++;
      let mejl;
      try {
        mejl = await parseMail(raw, { mapp: "INBOX", uid, riktning: "in" });
        // The agent's own weekly report is not a customer mail: keep it out of the archive.
        // Nor is a copy of the reply to it, which arrives here when it is sent to the mailbox itself.
        if (!mejl.huvuden["x-mejlagenten"] && !(await reportFor(db, mejl.svarPa))) await saveMail(db, [mejl]);
        const inFlaggedThread = flags.has("\\Flagged") || [mejl.svarPa, ...mejl.references].some((id) => id && flagged.has(id));
        const skip = flags.has("\\Answered") ? "redan besvarat" : inFlaggedThread ? "flaggad tråd" : skipReason(mejl, { egna });
        if (skip || (await hasDraft(db, mejl.messageId))) {
          stats.hoppade++;
          const why = skip || "har redan ett utkast";
          stats.skal[why] = (stats.skal[why] ?? 0) + 1;
        } else {
          const tidigare = await similarAnswered(db, ftsQuery(`${mejl.amne} ${mejl.text}`), { notMessageId: mejl.messageId });
          ai ??= anthropic(env);
          const svar = await writeDraft({ client: ai, model, kunskap, mejl, tidigare });
          if (svar.atgard === "utkast") {
            await appendDraft(client, drafts, await composeReply({ fran, mejl, svar: svar.svar }));
            stats.utkast++;
          } else {
            stats.hoppade++;
            stats.skal["modellen: inget svar väntas"] = (stats.skal["modellen: inget svar väntas"] ?? 0) + 1;
          }
          stats.kategorier[svar.kategori] = (stats.kategorier[svar.kategori] ?? 0) + 1;
          await saveDraft(db, { messageId: mejl.messageId, atgard: svar.atgard, kategori: svar.kategori, modell: model, text: svar.svar, skal: svar.skal, kallor: tidigare.map((t) => t.id) });
        }
      } catch (e) {
        // One broken mail must not stop the inbox. It is recorded so it can be found again.
        stats.fel++;
        log(`Mejl med UID ${uid} gick inte att behandla: ${e.message}`);
        if (mejl) await saveDraft(db, { messageId: mejl.messageId, atgard: "fel", kategori: "", modell: model, text: "", skal: String(e.message).slice(0, 300) }).catch(() => {});
      }
      await setState(db, key, uid);
    }
    return stats;
  } finally {
    await client.logout().catch(() => {});
    await db.close();
  }
}

export function summary(stats) {
  const list = (o) => Object.entries(o).map(([k, n]) => `- ${k}: ${n}`).join("\n");
  return [
    `### Mejlagenten: ${stats.nya} nya mejl, ${stats.utkast} utkast, ${stats.hoppade} hoppade över, ${stats.fel} fel`,
    Object.keys(stats.kategorier).length ? `Kategorier:\n${list(stats.kategorier)}` : "",
    Object.keys(stats.skal).length ? `Hoppade över:\n${list(stats.skal)}` : "",
    stats.skickade || stats.jamforda || stats.larfel
      ? `Lärande: ${stats.skickade ?? 0} skickade svar lästa, ${stats.jamforda ?? 0} jämförda med utkastet${stats.larfel ? `, ${stats.larfel} väntar till nästa körning` : ""}${Object.keys(stats.grader ?? {}).length ? `\n${list(stats.grader)}` : ""}`
      : "",
    stats.nyaRegler?.length ? `Nya regler från svar på veckorapporten:\n${stats.nyaRegler.map((r) => `- ${r}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run()
    .then(async (stats) => {
      const text = summary(stats);
      console.log(text);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
      if (stats.fel) process.exit(1);
    })
    .catch((e) => {
      console.error(`Körningen stannade: ${e.message}`);
      process.exit(1);
    });
}
