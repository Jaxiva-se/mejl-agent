/*
  Databasen för mejlagenten: arkivet av alla mejl, utkasten och läget (var vi är i inkorgen).

  Två lägen, samma SQL:
  - Cloudflare D1 över REST när MEJL_D1_DATABASE_ID är satt (så körs det i GitHub Actions).
  - En lokal SQLite-fil (MEJL_DB, standard .mejl.sqlite) för test och utveckling.

  Mejlen innehåller personuppgifter. De ligger bara här, aldrig i repot och aldrig i loggar.
*/

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS mejl (
     id INTEGER PRIMARY KEY,
     message_id TEXT NOT NULL UNIQUE,
     svar_pa TEXT NOT NULL DEFAULT '',
     riktning TEXT NOT NULL,
     mapp TEXT NOT NULL,
     uid INTEGER NOT NULL,
     fran TEXT NOT NULL DEFAULT '',
     till TEXT NOT NULL DEFAULT '',
     amne TEXT NOT NULL DEFAULT '',
     datum TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS mejl_svar_pa ON mejl (svar_pa)`,
  // Swedish letters stay distinct (å is not a), so "får" and "far" are different words.
  `CREATE VIRTUAL TABLE IF NOT EXISTS mejl_fts USING fts5(amne, text, tokenize = 'unicode61 remove_diacritics 0')`,
  `CREATE TABLE IF NOT EXISTS utkast (
     id INTEGER PRIMARY KEY,
     message_id TEXT NOT NULL UNIQUE,
     skapad TEXT NOT NULL,
     atgard TEXT NOT NULL,
     kategori TEXT NOT NULL DEFAULT '',
     modell TEXT NOT NULL DEFAULT '',
     text TEXT NOT NULL DEFAULT '',
     skal TEXT NOT NULL DEFAULT '',
     kallor TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE TABLE IF NOT EXISTS lage (nyckel TEXT PRIMARY KEY, varde TEXT NOT NULL)`,
  // One row per answered mail that had a draft: how alike draft and sent answer were, and the lesson.
  `CREATE TABLE IF NOT EXISTS larande (
     id INTEGER PRIMARY KEY,
     message_id TEXT NOT NULL UNIQUE,
     skickat_id TEXT NOT NULL,
     skapad TEXT NOT NULL,
     kategori TEXT NOT NULL DEFAULT '',
     likhet REAL NOT NULL,
     grad TEXT NOT NULL,
     typ TEXT NOT NULL DEFAULT '',
     lardom TEXT NOT NULL DEFAULT '',
     regelforslag TEXT NOT NULL DEFAULT '',
     modell TEXT NOT NULL DEFAULT ''
   )`,
];

/** D1 takes parameters as strings; SQLite's column affinity turns them back into numbers. */
const asParams = (params = []) => params.map((p) => (p === null || p === undefined ? "" : String(p)));

function d1({ accountId, databaseId, token, fetchImpl = fetch }) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  async function call(body) {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      // Cloudflare's own message only: it never contains the rows we sent.
      const why = (data.errors ?? []).map((e) => e.message).join("; ") || `HTTP ${res.status}`;
      throw new Error(`D1: ${why}`);
    }
    return data.result ?? [];
  }
  return {
    namn: "d1",
    async query(sql, params) {
      const [first] = await call({ sql, params: asParams(params) });
      return first?.results ?? [];
    },
    async batch(statements) {
      if (!statements.length) return;
      await call({ batch: statements.map((s) => ({ sql: s.sql, params: asParams(s.params) })) });
    },
    async close() {},
  };
}

async function local(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  const run = (sql, params) => {
    const stmt = db.prepare(sql);
    return /^\s*(select|with)/i.test(sql) ? stmt.all(...asParams(params)) : (stmt.run(...asParams(params)), []);
  };
  return {
    namn: "lokal",
    async query(sql, params) {
      return run(sql, params);
    },
    async batch(statements) {
      db.exec("BEGIN");
      try {
        for (const s of statements) run(s.sql, s.params);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async close() {
      db.close();
    },
  };
}

/** Opens the database the environment points at and makes sure the tables exist. */
export async function open(env = process.env, { fetchImpl } = {}) {
  let db;
  if (env.MEJL_D1_DATABASE_ID) {
    for (const k of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) if (!env[k]) throw new Error(`${k} saknas`);
    db = d1({ accountId: env.CLOUDFLARE_ACCOUNT_ID, databaseId: env.MEJL_D1_DATABASE_ID, token: env.CLOUDFLARE_API_TOKEN, fetchImpl });
  } else {
    db = await local(env.MEJL_DB || ".mejl.sqlite");
  }
  for (const sql of SCHEMA) await db.query(sql);
  return db;
}

/** The folder name of questions taken from the quote in our answer, when the original is gone. */
export const CITAT = "(citat)";

const insertMail = (m) => [
  {
    sql: `INSERT OR IGNORE INTO mejl (message_id, svar_pa, riktning, mapp, uid, fran, till, amne, datum, text)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [m.messageId, m.svarPa, m.riktning, m.mapp, m.uid, m.fran, m.till, m.amne, m.datum, m.text],
  },
  // The search row is looked up by rowid, so storing a mail costs the same however big the archive is.
  {
    sql: `INSERT INTO mejl_fts (rowid, amne, text)
          SELECT m.id, m.amne, m.text FROM mejl m
           WHERE m.message_id = ? AND NOT EXISTS (SELECT 1 FROM mejl_fts WHERE rowid = m.id)`,
    params: [m.messageId],
  },
];

const subject = (s) => String(s ?? "").replace(/^\s*((re|sv|vb|fw|fwd)\s*:\s*)+/i, "").trim();

/**
  The statements that store one mail and make it searchable. Safe to run twice.

  - An incoming mail replaces a question that was only known from a quote.
  - An answer whose question is not in the archive stores the quoted question in its place
    (folder CITAT, the Message-ID the answer points at), so the pair still counts.
*/
export function saveStatements(m) {
  const out = [];
  if (m.riktning === "in") {
    out.push(
      { sql: `DELETE FROM mejl_fts WHERE rowid IN (SELECT id FROM mejl WHERE message_id = ? AND mapp = ?)`, params: [m.messageId, CITAT] },
      { sql: `DELETE FROM mejl WHERE message_id = ? AND mapp = ?`, params: [m.messageId, CITAT] },
    );
  }
  out.push(...insertMail(m));
  if (m.riktning === "ut" && m.svarPa && m.citat) {
    out.push(...insertMail({ messageId: m.svarPa, svarPa: "", riktning: "in", mapp: CITAT, uid: 0, fran: (m.till ?? "").split(",")[0].trim(), till: m.fran, amne: subject(m.amne), datum: "", text: m.citat }));
  }
  return out;
}

export async function saveMail(db, mails) {
  await db.batch(mails.flatMap(saveStatements));
}

export async function getState(db, key) {
  const [row] = await db.query(`SELECT varde FROM lage WHERE nyckel = ?`, [key]);
  return row?.varde ?? null;
}

export async function setState(db, key, value) {
  await db.query(`INSERT INTO lage (nyckel, varde) VALUES (?, ?) ON CONFLICT (nyckel) DO UPDATE SET varde = excluded.varde`, [key, value]);
}

/** The UIDs already archived from a folder. */
export async function archivedUids(db, mapp) {
  return new Set((await db.query(`SELECT uid FROM mejl WHERE mapp = ?`, [mapp])).map((r) => Number(r.uid)));
}

/** The highest UID already archived from a folder, or null. */
export async function maxUid(db, mapp) {
  const [row] = await db.query(`SELECT MAX(uid) AS n FROM mejl WHERE mapp = ?`, [mapp]);
  return row?.n === null || row?.n === undefined || row?.n === "" ? null : Number(row.n);
}

export async function hasDraft(db, messageId) {
  const [row] = await db.query(`SELECT 1 AS finns FROM utkast WHERE message_id = ?`, [messageId]);
  return Boolean(row);
}

export async function saveDraft(db, d) {
  await db.query(
    `INSERT OR IGNORE INTO utkast (message_id, skapad, atgard, kategori, modell, text, skal, kallor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.messageId, new Date().toISOString(), d.atgard, d.kategori, d.modell, d.text, d.skal, JSON.stringify(d.kallor ?? [])],
  );
}

/**
  Earlier questions that look like this one and that we answered, best match first.
  `match` is an FTS5 expression from text.js (ftsQuery); empty means nothing to search for.
*/
export async function similarAnswered(db, match, { limit = 5, notMessageId = "" } = {}) {
  if (!match) return [];
  // The ranking runs in the inner query: bm25 cannot be used once rows are joined and grouped.
  return db.query(
    `SELECT f.id AS id, f.amne AS amne, f.datum AS datum, f.text AS fraga,
            (SELECT s.text FROM mejl s WHERE s.svar_pa = f.message_id AND s.riktning = 'ut' ORDER BY s.datum LIMIT 1) AS svar
       FROM (SELECT rowid AS rid, rank AS r FROM mejl_fts WHERE mejl_fts MATCH ? ORDER BY rank LIMIT 60) t
       JOIN mejl f ON f.id = t.rid
      WHERE f.riktning = 'in' AND f.message_id <> ?
        AND EXISTS (SELECT 1 FROM mejl s WHERE s.svar_pa = f.message_id AND s.riktning = 'ut')
      ORDER BY t.r
      LIMIT ?`,
    [match, notMessageId, limit],
  );
}
