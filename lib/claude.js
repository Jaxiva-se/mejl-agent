/*
  Ett anrop till Claude som ska ge ett svar i ett bestämt format. Formatet styrs med
  strukturerade svar (output_config.format): svaret är JSON som följer schemat. Nyare modeller
  tar inte emot ett tvingat verktygsanrop (tool_choice), så det används inte.

  Avböjer modellen av säkerhetsskäl tar API:t över med en annan modell (fallbacks), och avböjer
  den också blir det ett fel för just det mejlet.
*/
import Anthropic from "@anthropic-ai/sdk";

export function anthropic(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY saknas");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

/**
  Asks for one JSON object that follows `schema` and returns it parsed.
  `system` is a string or a list of text blocks (for caching); `content` is the user turn.
*/
export async function askJson(client, { model, system, content, schema, maxTokens = 16000, effort = "medium" }) {
  const res = await client.beta.messages.create({
    model,
    max_tokens: maxTokens,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error(`Modellen avböjde${res.stop_details?.category ? ` (${res.stop_details.category})` : ""}`);
  if (res.stop_reason === "max_tokens") throw new Error("Svaret blev för långt");
  const text = (res.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Modellen lämnade inget giltigt svar");
  }
}
