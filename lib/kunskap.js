/*
  Det agenten vet om verksamheten, som text till modellen: alla Markdown-filer i kunskap/
  (utom README.md), i namnordning, och reglerna i regler.md. Läses från repot vid varje
  körning, så en ändrad fil gäller från nästa körning.

  Miljö (valfritt, mest för test): MEJL_KUNSKAP (mappen), MEJL_REGLER (regelfilen),
  MEJL_NAMN (verksamhetens namn; annars första rubriken i kunskapen).
*/
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = (file) => readFile(file, "utf8").catch(() => "");

/** The knowledge files, as { fil, text }, in name order. */
export async function knowledgeFiles(dir) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md").sort();
  const out = [];
  for (const n of names) {
    const text = (await read(path.join(dir, n))).trim();
    if (text) out.push({ fil: n, text });
  }
  return out;
}

/** { namn, text }: everything the model may state as fact, apart from earlier answers. */
export async function knowledge(env = process.env) {
  const files = await knowledgeFiles(env.MEJL_KUNSKAP || path.join(ROOT, "kunskap"));
  const rules = (await read(env.MEJL_REGLER || path.join(ROOT, "regler.md"))).trim();
  const firstHeading = files.map((f) => f.text.match(/^#\s+(.+)$/m)?.[1]).find(Boolean) ?? "";
  return {
    namn: env.MEJL_NAMN || firstHeading,
    text: [...files.map((f) => f.text), rules && `# Regler från verksamheten\n${rules}`].filter(Boolean).join("\n\n"),
  };
}
