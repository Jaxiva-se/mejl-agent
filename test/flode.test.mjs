/*
  Hela flödet mot en riktig IMAP-server i minnet (hoodiecrow), en SQLite-fil och en påhittad
  modell: import av historiken, första körningen, nya mejl, utkast i tråden och omkörning.
  Mapparna ligger under "INBOX." som hos cPanel (Oderland).
*/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { CITAT, open, similarAnswered } from "../lib/db.js";
import { connect, ensureFolder, findFolder, readFolder } from "../lib/imap.js";
import { parseMail } from "../lib/text.js";
import { importAll, listFolders } from "../importera.mjs";
import { run, summary } from "../kor.mjs";

const hoodiecrow = createRequire(import.meta.url)("hoodiecrow-imap");

const msg = (headers, body) => ({ raw: `${headers.join("\r\n")}\r\n\r\n${body}` });
const storage = () => ({
  INBOX: {
    messages: [
      msg(["From: Anna Berg <anna@example.com>", "To: info@exempel.se", "Subject: Byta kurs", "Message-ID: <q1@example.com>", "Date: Mon, 5 Oct 2026 09:00:00 +0200"], "Hej! Kan jag byta från balett till salsa mitt i terminen?"),
      msg(["From: Bo Ek <bo@example.com>", "To: info@exempel.se", "Subject: Parkering", "Message-ID: <q2@example.com>", "Date: Tue, 6 Oct 2026 09:00:00 +0200"], "Finns det parkering vid Storgatan?"),
      msg(["From: Cia Dal <cia@example.com>", "To: info@exempel.se", "Subject: Obesvarat", "Message-ID: <q3@example.com>", "Date: Wed, 7 Oct 2026 09:00:00 +0200"], "Har ni salsa för seniorer?"),
    ],
  },
  "INBOX.": {
    separator: ".",
    folders: {
      Sent: {
        messages: [
          msg(["From: info@exempel.se", "To: anna@example.com", "Subject: Re: Byta kurs", "Message-ID: <s1@exempel.se>", "In-Reply-To: <q1@example.com>", "Date: Mon, 5 Oct 2026 11:00:00 +0200"], "Hej Anna,\n\nDet går bra att byta kurs i mån av plats. Svara med vilken kurs du vill gå.\n\nVänliga hälsningar\nExempelbolaget\n\nDen 5 okt. 2026 kl. 09:00 skrev Anna Berg <anna@example.com>:\n> Hej! Kan jag byta"),
          msg(["From: info@exempel.se", "To: bo@example.com", "Subject: Re: Parkering", "Message-ID: <s2@exempel.se>", "References: <q2@example.com>", "Date: Tue, 6 Oct 2026 11:00:00 +0200"], "Hej Bo,\n\nDet finns parkeringshus i närheten.\n\nVänliga hälsningar\nExempelbolaget"),
        ],
      },
      Drafts: {},
    },
  },
});

async function setup(t, store = storage()) {
  const server = hoodiecrow({ plugins: ["UIDPLUS", "NAMESPACE", "ID"], storage: store });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const dir = await mkdtemp(path.join(tmpdir(), "mejl-agent-"));
  await mkdir(path.join(dir, "kunskap"));
  await writeFile(path.join(dir, "kunskap", "verksamhet.md"), "# Exempelbolaget\nVi har kurser i dans.");
  await writeFile(path.join(dir, "regler.md"), "## Ton\n- Hälsa med Hej.");
  const env = { MEJL_IMAP_HOST: "127.0.0.1", MEJL_IMAP_PORT: String(server.server.address().port), MEJL_IMAP_USER: "testuser", MEJL_IMAP_PASSWORD: "testpass", MEJL_FRAN: "info@exempel.se", MEJL_EGNA: "info@exempel.se", MEJL_DB: path.join(dir, "test.sqlite"), MEJL_KUNSKAP: path.join(dir, "kunskap"), MEJL_REGLER: path.join(dir, "regler.md") };
  const client = new ImapFlow({ host: env.MEJL_IMAP_HOST, port: Number(env.MEJL_IMAP_PORT), secure: false, auth: { user: "testuser", pass: "testpass" }, logger: false });
  await client.connect();
  t.after(async () => {
    await client.logout().catch(() => {});
    await new Promise((ok) => server.close(ok));
    await rm(dir, { recursive: true, force: true });
  });
  return { env, client };
}

/** Which form a request asks for: a lesson or a draft. */
const kind = (req) => (req.output_config?.format?.schema?.properties?.lardom ? "lardom" : "svar");

/** A stand-in for Claude that records what it was asked and answers with JSON, as structured outputs do. */
function fakeAi(answer) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        async create(req) {
          calls.push(req);
          const out = typeof answer === "function" ? answer(req) : answer;
          return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(out) }] };
        },
      },
    },
  };
}

const drafts = async (client, folder = "INBOX.Drafts") => {
  const out = [];
  const lock = await client.getMailboxLock(folder);
  try {
    // The folder may already be selected on this connection: ask the server what has arrived since.
    await client.noop();
    if (client.mailbox.exists) for await (const m of client.fetch("1:*", { source: true, flags: true })) out.push({ flags: m.flags, mail: await parseMail(m.source, { mapp: folder, uid: m.uid, riktning: "ut" }), raw: m.source.toString() });
  } finally {
    lock.release();
  }
  return out;
};

test("importen läser inkorg och skickat, och parar ihop fråga och svar", async (t) => {
  const { env } = await setup(t);
  const log = [];
  const result = await importAll({ env, log: (l) => log.push(l) });
  assert.deepEqual(result, { in: { lasta: 3, olasbara: 0 }, ut: { lasta: 2, olasbara: 0 }, besvarade: 2, franCitat: 0 });
  assert.ok(!log.join("\n").includes("@"), "loggen får inte innehålla adresser");

  // Running it again fetches nothing: what is archived is skipped.
  const again = [];
  assert.deepEqual(await importAll({ env, log: (l) => again.push(l) }), { in: { lasta: 0, olasbara: 0 }, ut: { lasta: 0, olasbara: 0 }, besvarade: 2, franCitat: 0 });
  assert.equal(again[0], "Inkorgen: 0 mejl lästa, 3 fanns redan");

  // If the server renumbers the folder, everything is read again, and nothing is stored twice.
  const db0 = await open(env);
  await db0.query("UPDATE lage SET varde = 'annan' WHERE nyckel = 'import:INBOX'");
  await db0.close();
  assert.equal((await importAll({ env, log: () => {} })).in.lasta, 3);
  const db = await open(env);
  t.after(() => db.close());
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM mejl"))[0].n, 5);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM mejl_fts"))[0].n, 5);

  const hits = await similarAnswered(db, '"byta" OR "kurs" OR "salsa"');
  assert.equal(hits.length, 1, "bara frågor som fått svar, inte den obesvarade om salsa");
  assert.equal(hits[0].amne, "Byta kurs");
  assert.match(hits[0].svar, /^Hej Anna,\n\nDet går bra att byta kurs/);
  assert.doesNotMatch(hits[0].svar, /skrev Anna Berg/, "det citerade ska vara borta");
  assert.deepEqual(await similarAnswered(db, ""), []);
});

test("körningen: börjar från nu, skriver utkast i tråden och gör inget två gånger", async (t) => {
  const { env, client } = await setup(t);
  await importAll({ env, log: () => {} });

  // First run: nothing is drafted for the three mails already in the inbox.
  const ai = fakeAi({ atgard: "utkast", kategori: "byte av kurs", svar: "Hej Dan,\n\nDet går bra att byta i mån av plats. [[FRÅGA: finns det plats i Salsa 1?]]\n\nVänliga hälsningar\nExempelbolaget", skal: "Bygger på ett tidigare svar om kursbyte." });
  const log = [];
  let stats = await run({ env, ai, log: (l) => log.push(l) });
  assert.equal(stats.nya, 0);
  assert.equal(ai.calls.length, 0);
  assert.match(log[0], /Första körningen/);
  assert.equal((await drafts(client)).length, 0);

  // Three mails arrive: a question, a newsletter and an automatic reply.
  await client.append("INBOX", "From: Dan Fors <dan@example.com>\r\nTo: info@exempel.se\r\nSubject: Byta kurs?\r\nMessage-ID: <n1@example.com>\r\nDate: Tue, 24 Nov 2026 10:00:00 +0100\r\n\r\nHej, jag vill byta kurs till salsa. Går det?\r\n");
  await client.append("INBOX", "From: Butiken <nyheter@butik.se>\r\nTo: info@exempel.se\r\nSubject: Rea\r\nMessage-ID: <n2@butik.se>\r\nList-Unsubscribe: <mailto:av@butik.se>\r\n\r\nAllt ska bort\r\n");
  await client.append("INBOX", "From: Eva <eva@example.com>\r\nTo: info@exempel.se\r\nSubject: Autosvar\r\nMessage-ID: <n3@example.com>\r\nAuto-Submitted: auto-replied\r\n\r\nJag är på semester\r\n");

  stats = await run({ env, ai, log: (l) => log.push(l) });
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast, hoppade: stats.hoppade, fel: stats.fel }, { nya: 3, utkast: 1, hoppade: 2, fel: 0 });
  assert.deepEqual(stats.skal, { massutskick: 1, "automatiskt svar": 1 });
  assert.deepEqual(stats.kategorier, { "byte av kurs": 1 });

  // The model was asked once, with the earlier answer about changing course and the site as cached knowledge.
  assert.equal(ai.calls.length, 1);
  const [req] = ai.calls;
  assert.equal(req.model, "claude-sonnet-5-5");
  assert.equal(req.tool_choice, undefined, "nyare modeller tar inte emot ett tvingat verktyg");
  assert.equal(req.output_config.format.type, "json_schema");
  assert.deepEqual(req.output_config.format.schema.required, ["atgard", "kategori", "svar", "skal"]);
  assert.equal(req.fallbacks, "default");
  assert.match(req.messages[0].content, /Vi svarade:\nHej Anna,\n\nDet går bra att byta kurs/);
  assert.match(req.messages[0].content, /<mejl>\nFrån: Dan Fors\nÄmne: Byta kurs\?/);
  assert.match(req.system[1].text, /# Exempelbolaget/);
  assert.deepEqual(req.system[1].cache_control, { type: "ephemeral" });

  // The draft is in the drafts folder, in the thread, addressed to the customer, and not sent.
  const [d, ...rest] = await drafts(client);
  assert.equal(rest.length, 0);
  assert.ok(d.flags.has("\\Draft"));
  assert.equal(d.mail.svarPa, "n1@example.com");
  assert.equal(d.mail.till, "dan@example.com");
  assert.equal(d.mail.fran, "info@exempel.se");
  assert.equal(d.mail.amne, "Re: Byta kurs?");
  assert.match(d.mail.text, /^Hej Dan,\n\nDet går bra att byta i mån av plats\. \[\[FRÅGA: finns det plats i Salsa 1\?\]\]/);
  assert.match(d.raw, /> Hej, jag vill byta kurs till salsa/);

  // The archive has the new mails, and the draft is recorded for the comparison in step 3.
  const db = await open(env);
  t.after(() => db.close());
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM mejl WHERE riktning = 'in'"))[0].n, 6);
  const [saved] = await db.query("SELECT * FROM utkast");
  assert.equal(saved.message_id, "n1@example.com");
  assert.equal(saved.atgard, "utkast");
  assert.equal(saved.modell, "claude-sonnet-5-5");
  assert.match(saved.text, /^Hej Dan/);
  assert.equal(JSON.parse(saved.kallor).length, 1);

  // Nothing printed gives away who wrote or what.
  const printed = `${log.join("\n")}\n${summary(stats)}`;
  for (const secret of ["dan@", "Dan Fors", "salsa", "butik"]) assert.ok(!printed.includes(secret), `loggen innehåller "${secret}"`);
  assert.match(summary(stats), /### Mejlagenten: 3 nya mejl, 1 utkast, 2 hoppade över, 0 fel/);

  // A second run with nothing new does nothing.
  stats = await run({ env, ai, log: () => {} });
  assert.equal(stats.nya, 0);
  assert.equal(ai.calls.length, 1);
  assert.equal((await drafts(client)).length, 1);
});

test("körningen: fel i ett mejl stoppar inte nästa, modellen kan avstå, och egen mapp skapas", async (t) => {
  const { env, client } = await setup(t);
  env.MEJL_UTKASTMAPP = "Agentutkast";
  env.MEJL_MAX = "2";
  await run({ env, ai: fakeAi({}), log: () => {} });

  await client.append("INBOX", "From: A <a@example.com>\r\nSubject: Ett\r\nMessage-ID: <e1@example.com>\r\n\r\nFörsta frågan om parkering\r\n");
  await client.append("INBOX", "From: B <b@example.com>\r\nSubject: Två\r\nMessage-ID: <e2@example.com>\r\n\r\nAndra frågan om parkering\r\n");
  await client.append("INBOX", "From: C <c@example.com>\r\nSubject: Tre\r\nMessage-ID: <e3@example.com>\r\n\r\nSälj era produkter med vår SEO\r\n");

  let n = 0;
  const ai = fakeAi((req) => {
    n++;
    if (n === 1) throw new Error("överbelastad");
    if (/SEO/.test(req.messages[0].content)) return { atgard: "hoppa_over", kategori: "säljmejl", svar: "", skal: "Oombett säljmejl." };
    return { atgard: "utkast", kategori: "parkering", svar: "Hej,\n\nDet finns parkeringshus i närheten.", skal: "Tidigare svar." };
  });
  const log = [];
  let stats = await run({ env, ai, log: (l) => log.push(l) });
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast, fel: stats.fel }, { nya: 2, utkast: 1, fel: 1 }, "högst MEJL_MAX per körning");
  assert.match(log[0], /^Mejl med UID \d+ gick inte att behandla: överbelastad$/);

  stats = await run({ env, ai, log: () => {} });
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast, hoppade: stats.hoppade }, { nya: 1, utkast: 0, hoppade: 1 });

  const made = await drafts(client, "INBOX.Agentutkast");
  assert.equal(made.length, 1);
  assert.equal(made[0].mail.svarPa, "e2@example.com");
  assert.equal((await drafts(client)).length, 0, "den vanliga utkastmappen är orörd");
  assert.equal(await ensureFolder(client, "Agentutkast"), "INBOX.Agentutkast");
  assert.equal(await findFolder(client, "\\Sent"), "INBOX.Sent");

  const db = await open(env);
  t.after(() => db.close());
  const rows = await db.query("SELECT message_id, atgard FROM utkast ORDER BY id");
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { message_id: "e1@example.com", atgard: "fel" },
    { message_id: "e2@example.com", atgard: "utkast" },
    { message_id: "e3@example.com", atgard: "hoppa_over" },
  ]);
});

test("D1: frågor går som batch över REST, och fel blir begripliga", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, auth: init.headers.Authorization, body });
    if (body.sql?.includes("trasig")) return { ok: false, status: 400, json: async () => ({ success: false, errors: [{ message: "near trasig: syntax error" }] }) };
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ results: [{ varde: "41" }] }] }) };
  };
  const env = { MEJL_D1_DATABASE_ID: "db-1", CLOUDFLARE_ACCOUNT_ID: "acc-1", CLOUDFLARE_API_TOKEN: "hemlig" };
  const db = await open(env, { fetchImpl });
  assert.equal(db.namn, "d1");
  assert.equal(sent[0].url, "https://api.cloudflare.com/client/v4/accounts/acc-1/d1/database/db-1/query");
  assert.equal(sent[0].auth, "Bearer hemlig");
  assert.match(sent[0].body.sql, /CREATE TABLE IF NOT EXISTS mejl/);

  sent.length = 0;
  assert.deepEqual(await db.query("SELECT varde FROM lage WHERE nyckel = ?", ["inkorg:1"]), [{ varde: "41" }]);
  await db.batch([{ sql: "INSERT INTO lage VALUES (?, ?)", params: ["a", 7] }, { sql: "DELETE FROM lage WHERE nyckel = ?", params: [null] }]);
  assert.deepEqual(sent[0].body, { sql: "SELECT varde FROM lage WHERE nyckel = ?", params: ["inkorg:1"] });
  assert.deepEqual(sent[1].body, { batch: [{ sql: "INSERT INTO lage VALUES (?, ?)", params: ["a", "7"] }, { sql: "DELETE FROM lage WHERE nyckel = ?", params: [""] }] });
  await assert.rejects(db.query("trasig"), /^Error: D1: near trasig: syntax error$/);
  await assert.rejects(open({ MEJL_D1_DATABASE_ID: "x" }), /CLOUDFLARE_ACCOUNT_ID saknas/);
});

test("lärandet: skickade svar läses in och jämförs med utkasten", async (t) => {
  const { env, client } = await setup(t);
  await importAll({ env, log: () => {} });
  await run({ env, ai: fakeAi({}), log: () => {} });

  await client.append("INBOX", "From: Gus <gus@example.com>\r\nSubject: Parkering\r\nMessage-ID: <l1@example.com>\r\n\r\nFinns det parkering?\r\n");
  await client.append("INBOX", "From: Hel <hel@example.com>\r\nSubject: Pengar tillbaka\r\nMessage-ID: <l2@example.com>\r\n\r\nKan jag få pengarna tillbaka för kursen?\r\n");
  await client.append("INBOX", "From: Ida <ida@example.com>\r\nSubject: Tack\r\nMessage-ID: <l3@example.com>\r\n\r\nTack för senast, men när börjar vårterminen?\r\n");

  const DRAFT_1 = "Hej Gus,\n\nDet finns ett parkeringshus i närheten av studion.\n\nVänliga hälsningar\nExempelbolaget";
  const ai = fakeAi((req) => {
    if (kind(req) === "lardom") return { typ: "regel", lardom: "Återbetalning ges bara före kursstart.", regelforslag: "Återbetalning ges bara före kursstart." };
    const c = req.messages[0].content;
    if (/Tack för senast/.test(c)) return { atgard: "hoppa_over", kategori: "tack", svar: "", skal: "Ett tack." };
    if (/Pengar tillbaka/.test(c)) return { atgard: "utkast", kategori: "återbetalning", svar: "Hej Hel,\n\n[[FRÅGA: gäller återbetalning?]]\n\nVänliga hälsningar", skal: "Okänd regel." };
    return { atgard: "utkast", kategori: "parkering", svar: DRAFT_1, skal: "Tidigare svar." };
  });
  let stats = await run({ env, ai, log: () => {} });
  assert.deepEqual({ utkast: stats.utkast, hoppade: stats.hoppade, skickade: stats.skickade }, { utkast: 2, hoppade: 1, skickade: 0 });

  // The office answers all three: the first draft almost as it was, the second rewritten, and the skipped one.
  const sent = (to, id, replyTo, body) => client.append("INBOX.Sent", `From: info@exempel.se\r\nTo: ${to}\r\nSubject: Re\r\nMessage-ID: <${id}>\r\nIn-Reply-To: <${replyTo}>\r\nDate: Tue, 24 Nov 2026 15:00:00 +0100\r\n\r\n${body}\r\n`);
  await sent("gus@example.com", "u1@exempel.se", "l1@example.com", `${DRAFT_1.replace("ett parkeringshus", "parkeringshus")}\r\n\r\nDen 24 nov. 2026 skrev Gus:\r\n> Finns det parkering?`);
  await sent("hel@example.com", "u2@exempel.se", "l2@example.com", "Hej Hel,\r\n\r\nPengarna betalas tillbaka om du avbokar innan kursen startat. Efter start går det inte.\r\n\r\nHälsningar\r\nKontoret");
  await sent("ida@example.com", "u3@exempel.se", "l3@example.com", "Hej Ida! Vårterminen börjar i januari.");

  const log = [];
  const before = ai.calls.length;
  stats = await run({ env, ai, log: (l) => log.push(l) });
  assert.equal(stats.skickade, 3);
  assert.equal(stats.jamforda, 3);
  assert.deepEqual(stats.grader, { "skickat nästan som det var": 1, omskrivet: 1, "missat svar": 1 });
  assert.equal(ai.calls.length - before, 2, "modellen frågas bara när svaret ändrats");
  const asked = ai.calls.slice(before).map((r) => r.messages[0].content);
  assert.match(asked[0], /<utkast>\nHej Hel,/);
  assert.match(asked[0], /<skickat>\nHej Hel,\n\nPengarna betalas tillbaka/);
  assert.doesNotMatch(asked[0], /skrev Gus/);

  const db = await open(env);
  t.after(() => db.close());
  const rows = (await db.query("SELECT message_id, skickat_id, grad, typ, lardom, likhet FROM larande ORDER BY message_id")).map((r) => ({ ...r }));
  assert.deepEqual(rows.map((r) => [r.message_id, r.skickat_id, r.grad, r.typ]), [
    ["l1@example.com", "u1@exempel.se", "skickat nästan som det var", "inget"],
    ["l2@example.com", "u2@exempel.se", "omskrivet", "regel"],
    ["l3@example.com", "u3@exempel.se", "missat svar", "regel"],
  ]);
  assert.ok(rows[0].likhet >= 0.9);
  assert.equal(rows[1].lardom, "Återbetalning ges bara före kursstart.");

  // The new answer is now in the archive, so the next question about refunds finds it.
  const [hit] = await similarAnswered(db, '"pengarna" OR "tillbaka"');
  assert.equal(hit.amne, "Pengar tillbaka");
  assert.match(hit.svar, /avbokar innan kursen startat/);

  const printed = `${log.join("\n")}\n${summary(stats)}`;
  assert.match(summary(stats), /Lärande: 3 skickade svar lästa, 3 jämförda med utkastet/);
  for (const secret of ["Gus", "Hel", "pengar", "Återbetalning"]) assert.ok(!printed.includes(secret), `loggen innehåller "${secret}"`);

  // Nothing new: nothing read, nothing compared twice.
  stats = await run({ env, ai, log: () => {} });
  assert.deepEqual({ skickade: stats.skickade, jamforda: stats.jamforda }, { skickade: 0, jamforda: 0 });
  assert.equal(ai.calls.length - before, 2);
});

test("mappen hämtas i omgångar, i UID-ordning, och hoppar över det som redan finns", async (t) => {
  const { client } = await setup(t);
  const seen = [];
  const info = await readFolder(client, "INBOX", { chunk: 2, skip: new Set([2]) }, async ({ uid }, p) => seen.push([uid, p.klara, p.totalt]));
  assert.equal(info.antal, 2);
  assert.deepEqual(seen, [[1, 2, 2], [3, 2, 2]]);
  const all = [];
  await readFolder(client, "INBOX", { chunk: 2 }, async ({ uid }, p) => all.push([uid, p.klara]));
  assert.deepEqual(all, [[1, 2], [2, 2], [3, 3]]);
});

test("importen: frågor i andra mappar räknas, och raderade frågor tas ur citatet", async (t) => {
  // Like a real mailbox: the inbox is almost empty, questions were moved to an archive folder
  // or deleted, and the trash is not read.
  const { env } = await setup(t, {
    INBOX: { messages: [] },
    "INBOX.": {
      separator: ".",
      folders: {
        Arkiv: {
          messages: [
            msg(["From: Anna <anna@example.com>", "Subject: Byta kurs", "Message-ID: <a1@example.com>", "Date: Mon, 5 Oct 2026 09:00:00 +0200"], "Kan jag byta från balett till salsa?"),
            // A copy of our own mail filed here counts as ours.
            msg(["From: info@exempel.se", "To: x@example.com", "Subject: Info", "Message-ID: <own@exempel.se>", "Date: Mon, 5 Oct 2026 10:00:00 +0200"], "Hej, här kommer schemat."),
          ],
        },
        Trash: {
          messages: [msg(["From: Spam <s@example.com>", "Subject: Köp", "Message-ID: <t1@example.com>"], "Köp nu")],
          folders: { Gammalt: { messages: [msg(["From: G <g@example.com>", "Subject: G", "Message-ID: <x5@example.com>"], "Gammalt")] } },
        },
        // Never read: listed in MEJL_UTESLUT (with what is inside it), deleted, private, inside the trash.
        Loner: {
          messages: [msg(["From: Lärare <l@example.com>", "Subject: Lön", "Message-ID: <x1@example.com>"], "Min lön")],
          folders: { Gamla: { messages: [msg(["From: Lärare <l@example.com>", "Subject: Lön", "Message-ID: <x2@example.com>"], "Gammal lön")] } },
        },
        Raderat: { messages: [msg(["From: R <r@example.com>", "Subject: R", "Message-ID: <x3@example.com>"], "Raderat")] },
        Privat: { messages: [msg(["From: P <p@example.com>", "Subject: P", "Message-ID: <x4@example.com>"], "Privat")] },
        // An old sent folder from another mail program counts as ours.
        "Sent Items": { messages: [msg(["From: Kontoret <kontor@exempel.se>", "To: dan@example.com", "Subject: Re: Parkering", "Message-ID: <s4@exempel.se>", "In-Reply-To: <p9@example.com>"], "Hej Dan,\n\nParkera på gatan.\n\nDen 1 okt. 2026 kl. 09:00 skrev Dan <dan@example.com>:\n> Var parkerar man?")] },
        Sent: {
          messages: [
            msg(["From: info@exempel.se", "To: anna@example.com", "Subject: Re: Byta kurs", "Message-ID: <s1@exempel.se>", "In-Reply-To: <a1@example.com>", "Date: Mon, 5 Oct 2026 11:00:00 +0200"], "Hej Anna,\n\nDet går bra i mån av plats.\n\nDen 5 okt. 2026 kl. 09:00 skrev Anna <anna@example.com>:\n> Kan jag byta från balett till salsa?"),
            msg(["From: info@exempel.se", "To: bo@example.com", "Subject: SV: Återbetalning", "Message-ID: <s2@exempel.se>", "In-Reply-To: <gone@example.com>", "Date: Tue, 6 Oct 2026 11:00:00 +0200"], "Hej Bo,\n\nPengarna betalas tillbaka före kursstart.\n\nFrån: Bo <bo@example.com>\nSkickat: den 6 oktober 2026 09:00\nTill: info@exempel.se\nÄmne: Återbetalning\n\nKan jag få pengarna tillbaka för vårens kurs?"),
            msg(["From: info@exempel.se", "To: c@example.com", "Subject: Hej", "Message-ID: <s3@exempel.se>"], "Ett mejl vi skrev själva, utan citat."),
          ],
        },
        Drafts: {},
      },
    },
  });
  env.MEJL_UTESLUT = "Loner, INBOX.Finns inte";
  // The folder list reads no mail and needs no database.
  const shown = [];
  const rows = await listFolders({ env: { ...env, MEJL_DB: "/finns/inte" }, log: (l) => shown.push(l) });
  const lage = Object.fromEntries(rows.map((r) => [r.mapp, `${r.lage} ${r.antal}`]));
  assert.equal(lage["INBOX.Arkiv"], "läses 2");
  assert.equal(lage["INBOX.Loner"], "läses aldrig 1");
  assert.equal(lage["INBOX.Loner.Gamla"], "läses aldrig 1");
  assert.equal(lage["INBOX.Privat"], "läses aldrig 1");
  assert.equal(lage["INBOX.Sent Items"], "skickat 1");
  assert.equal(shown.at(-1), "Läses: 2 mejl, skickat: 4, läses aldrig: 6");
  assert.ok(!shown.join("\n").includes("@"), "inga adresser i listan");

  const log = [];
  const result = await importAll({ env, log: (l) => log.push(l) });
  assert.deepEqual(result, { in: { lasta: 1, olasbara: 0 }, ut: { lasta: 5, olasbara: 0 }, besvarade: 3, franCitat: 2 });
  assert.deepEqual(log, [
    "Läses aldrig: Loner, INBOX.Finns inte",
    "Inkorgen: 0 mejl lästa",
    "INBOX.Arkiv: 2 mejl lästa",
    "Skickat: 3 mejl lästa",
    "INBOX.Sent Items: 1 mejl lästa",
    "Frågor med svar i arkivet: 3, varav 2 hämtade ur citatet i svaret",
  ]);
  const never = await (await open(env)).query("SELECT COUNT(*) AS n FROM mejl WHERE message_id LIKE 'x%'");
  assert.equal(never[0].n, 0, "löner, raderat, privat och papperskorgen läses aldrig");

  const db = await open(env);
  t.after(() => db.close());
  const [q] = await db.query("SELECT * FROM mejl WHERE mapp = ?", [CITAT]);
  assert.deepEqual({ id: q.message_id, fran: q.fran, amne: q.amne, text: q.text, riktning: q.riktning }, { id: "gone@example.com", fran: "bo@example.com", amne: "Återbetalning", text: "Kan jag få pengarna tillbaka för vårens kurs?", riktning: "in" });
  const [hit] = await similarAnswered(db, '"pengarna" OR "tillbaka"');
  assert.match(hit.fraga, /^Kan jag få pengarna/);
  assert.match(hit.svar, /^Hej Bo,\n\nPengarna betalas tillbaka före kursstart\.$/);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM mejl WHERE message_id = 't1@example.com'"))[0].n, 0, "papperskorgen läses inte");
  assert.equal((await db.query("SELECT riktning FROM mejl WHERE message_id = 'own@exempel.se'"))[0].riktning, "ut");

  // If the real question turns up later, it takes the quote's place, searchable once.
  const { saveMail } = await import("../lib/db.js");
  await saveMail(db, [{ messageId: "gone@example.com", svarPa: "", riktning: "in", mapp: "INBOX", uid: 9, fran: "bo@example.com", till: "info@exempel.se", amne: "Återbetalning", datum: "2026-10-06T07:00:00.000Z", text: "Kan jag få pengarna tillbaka för vårens kurs? Mvh Bo" }]);
  assert.deepEqual((await db.query("SELECT mapp FROM mejl WHERE message_id = 'gone@example.com'")).map((r) => r.mapp), ["INBOX"]);
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM mejl_fts WHERE mejl_fts MATCH '\"pengarna\"'"))[0].n, 2, "frågan och svaret, inte citatet också");
});

test("prov: de senaste mejlen i inkorgen får utkast direkt", async (t) => {
  const { env, client } = await setup(t);
  await importAll({ env, log: () => {} });
  env.MEJL_PROV_SENASTE = "2";
  const ai = fakeAi({ atgard: "utkast", kategori: "fråga", svar: "Hej,\n\nTack för frågan.", skal: "Prov." });
  const log = [];
  const stats = await run({ env, ai, log: (l) => log.push(l) });
  assert.equal(log[0], "Prov: de senaste 2 mejlen i inkorgen får utkast.");
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast }, { nya: 2, utkast: 2 });
  assert.deepEqual((await drafts(client)).map((d) => d.mail.svarPa).sort(), ["q2@example.com", "q3@example.com"]);
});

test("importen: bryts anslutningen kopplar den upp igen och fortsätter, och en ny körning tar vid", async (t) => {
  const { env } = await setup(t);
  env.MEJL_VANTA_MS = "0";
  // The first connection is closed by the "server" while the inbox is being fetched.
  let made = 0;
  const flaky = (e) => {
    const c = connect(e);
    if (++made === 1) {
      const fetch = c.fetch.bind(c);
      c.fetch = async function* (...args) {
        let n = 0;
        for await (const m of fetch(...args)) {
          if (++n === 2) c.close();
          yield m;
        }
      };
    }
    return c;
  };
  const log = [];
  const result = await importAll({ env, log: (l) => log.push(l), connectTo: flaky });
  assert.equal(made, 2, "en ny anslutning");
  assert.ok(log.includes("Inkorgen: anslutningen bröts, kopplar upp igen (1 av 5)"));
  assert.deepEqual(result, { in: { lasta: 3, olasbara: 0 }, ut: { lasta: 2, olasbara: 0 }, besvarade: 2, franCitat: 0 });

  // A run that stopped halfway is picked up by the next: the mark is set before reading.
  const db = await open(env);
  await db.query("DELETE FROM mejl_fts WHERE rowid IN (SELECT id FROM mejl WHERE message_id = 'q3@example.com')");
  await db.query("DELETE FROM mejl WHERE message_id = 'q3@example.com'");
  await db.close();
  const again = [];
  await importAll({ env, log: (l) => again.push(l) });
  assert.equal(again[0], "Inkorgen: 1 mejl lästa, 2 fanns redan");
});

test("körningen: ett mejl i en tråd som är flaggad i inkorgen får inget utkast", async (t) => {
  const { env, client } = await setup(t);
  await run({ env, ai: fakeAi({}), log: () => {} });

  // The person who handles the mail flags a thread she handles herself.
  await client.append("INBOX", "From: Nation <nation@example.com>\r\nSubject: Samarbete\r\nMessage-ID: <f1@example.com>\r\n\r\nHej, ska vi ses om hösten?\r\n", ["\\Flagged"]);
  await run({ env, ai: fakeAi({ atgard: "hoppa_over", kategori: "x", svar: "", skal: "x" }), log: () => {} });

  // The answer in that thread, and an unrelated mail.
  await client.append("INBOX", "From: Nation <nation@example.com>\r\nSubject: Re: Samarbete\r\nMessage-ID: <f2@example.com>\r\nIn-Reply-To: <x9@exempel.se>\r\nReferences: <f1@example.com> <x9@exempel.se>\r\n\r\nTisdag passar bra.\r\n");
  await client.append("INBOX", "From: Kund <kund@example.com>\r\nSubject: Kurs\r\nMessage-ID: <f3@example.com>\r\n\r\nNär börjar salsan?\r\n");
  const ai = fakeAi({ atgard: "utkast", kategori: "kursstart", svar: "Hej :)\n\nSnart!", skal: "Kurslistan." });
  const stats = await run({ env, ai, log: () => {} });
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast, hoppade: stats.hoppade }, { nya: 2, utkast: 1, hoppade: 1 });
  assert.deepEqual(stats.skal, { "flaggad tråd": 1 });
  assert.equal(ai.calls.length, 1, "modellen frågas inte om den flaggade tråden");
});

test("veckorapporten: siffror, lärdomar och förslag hamnar som ett mejl i inkorgen, och får inget utkast", async (t) => {
  const { env, client } = await setup(t);
  env.MEJL_FRAN = "Exempelbolaget <info@exempel.se>";
  env.MEJL_IMAP_USER = "info@exempel.se";
  env.MEJL_RAPPORT_SVAR = "agare@example.com";
  const { report } = await import("../rapport.mjs");
  const { saveDraft } = await import("../lib/db.js");
  const { saveLesson } = await import("../lib/larande.js");
  // kor needs the same login as the test server, so it gets its own copy of env.
  const korEnv = { ...env, MEJL_IMAP_USER: "testuser" };
  await run({ env: korEnv, ai: fakeAi({}), log: () => {} });

  const db = await open(env);
  for (const [id, atgard, kategori] of [["r1", "utkast", "friskvård"], ["r2", "utkast", "friskvård"], ["r3", "utkast", "byte av kurs"], ["r4", "hoppa_over", "reklam"]]) {
    await saveDraft(db, { messageId: `${id}@example.com`, atgard, kategori, modell: "m", text: "", skal: "" });
  }
  await saveLesson(db, { messageId: "r1@example.com", skickatId: "s1", kategori: "friskvård", likhet: 0.95, grad: "skickat nästan som det var", typ: "inget", lardom: "", regelforslag: "", modell: "" });
  await saveLesson(db, { messageId: "r3@example.com", skickatId: "s3", kategori: "byte av kurs", likhet: 0.3, grad: "omskrivet", typ: "regel", lardom: "Byte ska bekräftas med vilken grupp kunden flyttas till.", regelforslag: "Skriv alltid vilken grupp kunden flyttas till.", modell: "m" });
  await db.close();

  const ai = fakeAi({ sammanfattning: "Friskvårdssvaren skickades nästan som de var. Byten skrevs om.", forslag: [{ regel: "Skriv alltid vilken grupp kunden flyttas till vid byte.", varfor: "Ett byte skrevs om för att gruppen saknades.", antal: 1 }] });
  const log = [];
  const out = await report({ env: { ...env, MEJL_IMAP_USER: "testuser" }, ai, now: new Date("2026-11-30T06:23:00Z"), log: (l) => log.push(l) });
  assert.equal(out.vecka, 49);
  assert.equal(log[0], "Veckorapport vecka 49: 3 utkast, 1 lärdomar, 1 förslag på regler");
  assert.match(ai.calls[0].messages[0].content, /<regler>\n[\s\S]*Hälsa med Hej[\s\S]*<lardomar>\n1\. \[regel, byte av kurs\] Byte ska bekräftas/);

  // The report is in the inbox, unread, from the agent, with replies going to the chosen address.
  const lock = await client.getMailboxLock("INBOX");
  let mail;
  try {
    await client.noop();
    const last = await client.fetchOne("*", { source: true, flags: true });
    assert.ok(!last.flags.has("\\Seen"));
    mail = await parseMail(last.source, { mapp: "INBOX", uid: last.uid, riktning: "in" });
  } finally {
    lock.release();
  }
  assert.equal(mail.amne, "Mejlagenten: veckorapport vecka 49");
  assert.equal(mail.svaraTill, "agare@example.com");
  for (const line of ["- Utkast: 3", "- Hoppade över (reklam, autosvar, sådant reglerna undantar): 1", "- Skickat nästan som det var: 1", "- Omskrivet: 1", "- friskvård: 2", "1. Skriv alltid vilken grupp kunden flyttas till vid byte.", "   Varför: Ett byte skrevs om för att gruppen saknades. (1 gång)"]) {
    assert.ok(mail.text.includes(line), `saknar: ${line}`);
  }
  assert.ok(!log.join("\n").includes("@"));

  // The next run does not draft a reply to the report.
  const stats = await run({ env: korEnv, ai: fakeAi({ atgard: "utkast", kategori: "x", svar: "Hej", skal: "x" }), log: () => {} });
  assert.deepEqual({ nya: stats.nya, utkast: stats.utkast, skal: stats.skal }, { nya: 1, utkast: 0, skal: { "automatiskt svar": 1 } });
  const db2 = await open(env);
  t.after(() => db2.close());
  assert.equal((await db2.query("SELECT COUNT(*) AS n FROM mejl WHERE amne LIKE 'Mejlagenten:%'"))[0].n, 0, "rapporten arkiveras inte");
});

test("svar på veckorapporten: valda förslag blir regler, en gång, och syns i nästa rapport", async (t) => {
  const { env, client } = await setup(t);
  const { report } = await import("../rapport.mjs");
  const { saveLesson } = await import("../lib/larande.js");
  const { readFile, writeFile } = await import("node:fs/promises");
  env.MEJL_REGLER = path.join(path.dirname(env.MEJL_DB), "regler.md");
  await writeFile(env.MEJL_REGLER, "## Ton\n\n- Hälsa med Hej :)\n");
  await run({ env, ai: fakeAi({}), log: () => {} });

  const db = await open(env);
  await saveLesson(db, { messageId: "x@example.com", skickatId: "s", kategori: "byte", likhet: 0.2, grad: "omskrivet", typ: "regel", lardom: "Skriv vilken grupp.", regelforslag: "", modell: "m" });
  await db.close();
  const forslag = [
    { regel: "Skriv alltid vilken grupp kunden flyttas till vid byte.", varfor: "x", antal: 2 },
    { regel: "Svara alltid inom en dag.", varfor: "y", antal: 1 },
  ];
  const { messageId } = await report({ env, ai: fakeAi({ sammanfattning: "S", forslag }), now: new Date("2026-11-30T06:23:00Z"), log: () => {} });

  // The person who handles the mail answers from the mailbox: the reply is in the sent folder.
  await client.append("INBOX.Sent", `From: info@exempel.se\r\nTo: info@exempel.se\r\nSubject: Re: Mejlagenten: veckorapport vecka 49\r\nMessage-ID: <svar1@exempel.se>\r\nIn-Reply-To: <${messageId}>\r\n\r\nNummer 1 men inte 2. Lägg också till att vi har stängt under jullovet.\r\n\r\nDen 30 nov. 2026 kl. 07:23 skrev Exempelbolaget <info@exempel.se>:\r\n> 1. Skriv alltid vilken grupp\r\n`);
  const asked = [];
  const ai = fakeAi((req) => {
    asked.push(req.messages[0].content);
    return { regler: ["Skriv alltid vilken grupp kunden flyttas till vid byte.", "Vi har stängt under jullovet."], skal: "Valde 1 och en egen regel." };
  });
  let stats = await run({ env, ai, log: () => {} });
  assert.deepEqual(stats.nyaRegler, ["Skriv alltid vilken grupp kunden flyttas till vid byte.", "Vi har stängt under jullovet."]);
  assert.match(asked[0], /<forslag>\n1\. Skriv alltid vilken grupp kunden flyttas till vid byte\.\n2\. Svara alltid inom en dag\.\n<\/forslag>/);
  assert.match(asked[0], /<svar>\nNummer 1 men inte 2\. Lägg också till att vi har stängt under jullovet\.\n<\/svar>/, "bara svaret, inte det citerade");
  const rules = await readFile(env.MEJL_REGLER, "utf8");
  assert.match(rules, /^## Ton\n\n- Hälsa med Hej :\)\n\n## Från veckorapporterna\n/);
  assert.match(rules, /<!-- vecka 49 -->\n- Skriv alltid vilken grupp kunden flyttas till vid byte\.\n- Vi har stängt under jullovet\.\n$/);
  assert.match(summary(stats), /Nya regler från svar på veckorapporten:\n- Skriv alltid vilken grupp/);

  // The reply is not an answer to a customer: it is not in the archive.
  const db2 = await open(env);
  t.after(() => db2.close());
  assert.equal((await db2.query("SELECT COUNT(*) AS n FROM mejl WHERE message_id IN ('svar1@exempel.se', ?)", [messageId]))[0].n, 0);

  // The same reply is never read twice, and the next report lists the new rules.
  stats = await run({ env, ai, log: () => {} });
  assert.deepEqual(stats.nyaRegler, []);
  assert.equal(asked.length, 1);
  const next = await report({ env, ai: fakeAi({ sammanfattning: "", forslag: [] }), now: new Date("2026-12-07T06:23:00Z"), log: () => {} });
  assert.match(next.text, /NYA REGLER SEDAN FÖRRA RAPPORTEN\n- Skriv alltid vilken grupp kunden flyttas till vid byte\.\n- Vi har stängt under jullovet\./);
  const third = await report({ env, ai: fakeAi({ sammanfattning: "", forslag: [] }), now: new Date("2026-12-14T06:23:00Z"), log: () => {} });
  assert.doesNotMatch(third.text, /NYA REGLER/, "varje ny regel nämns en gång");
});
