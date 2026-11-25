/*
  Svar på veckorapporten blir regler. När den som sköter brevlådan svarar på rapporten (svaret
  ligger i skickat, dit bara den som är inloggad kan skriva) tolkar Claude vilka förslag som
  valdes, och med vilka ord, och de läggs till sist i regler.md. Inga regler tas bort eller
  ändras automatiskt: det görs för hand.
*/
import { readFile, writeFile } from "node:fs/promises";
import { askJson } from "./claude.js";

export const SECTION = "## Från veckorapporterna";

export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    regler: {
      type: "array",
      description: "Reglerna som ska läggas till, i den ordning de valdes. Tom om svaret inte väljer något.",
      items: { type: "string", description: "En regel, en eller två korta meningar, som den ska stå i regler.md." },
    },
    skal: { type: "string", description: "En mening om vad svaret valde, eller varför inget lades till." },
  },
  required: ["regler", "skal"],
};

const SYSTEM = `Du läser ett svar på mejlagentens veckorapport. Rapporten hade numrerade förslag på nya regler. Den som sköter mejlen har svarat med vilka förslag hon vill behålla, ibland med egna ord, och ibland med en egen ny regel.

- Ta med förslag hon väljer, med nummer eller genom att återge dem. Har hon skrivit om ett förslag: använd hennes ord.
- Ta med en ny regel hon själv skriver och tydligt vill ha som regel.
- Ta inte med förslag hon inte valt, eller förslag hon säger nej till.
- Skriv varje regel som en eller två korta meningar på svenska, som instruktion till agenten. Inga namn på kunder och inga personuppgifter.
- Svarar hon något annat än vilka regler hon vill ha, eller är det oklart: lägg inte till något, och säg varför i skal.
- Använd aldrig tankstreck.

Svara med ett JSON-objekt med fälten regler och skal.`;

/** What a reply to the report chooses: the rules to add. */
export async function interpretReply({ client, model, forslag, svar }) {
  const out = await askJson(client, {
    model,
    maxTokens: 4000,
    system: SYSTEM,
    content: `<forslag>\n${forslag.map((f, i) => `${i + 1}. ${f.regel}`).join("\n")}\n</forslag>\n\n<svar>\n${String(svar).slice(0, 6000)}\n</svar>`,
    schema: SCHEMA,
  });
  const regler = (Array.isArray(out?.regler) ? out.regler : []).map((r) => String(r).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 20);
  return { regler, skal: String(out?.skal ?? "") };
}

/** Adds rules at the end of the rules file, under one heading. Returns the rules actually added. */
export async function appendRules(file, regler, { vecka } = {}) {
  let text = (await readFile(file, "utf8").catch(() => "")).replace(/\s+$/, "");
  const fresh = regler.filter((r) => !text.includes(r));
  if (!fresh.length) return [];
  if (!text.includes(SECTION)) text += `\n\n${SECTION}\n\nRegler som valts i svar på veckorapporten. Ändra eller ta bort dem som andra regler.`;
  text += `\n${vecka ? `\n<!-- vecka ${vecka} -->` : ""}\n${fresh.map((r) => `- ${r}`).join("\n")}`;
  await writeFile(file, `${text}\n`);
  return fresh;
}
