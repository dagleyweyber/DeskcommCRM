/**
 * Parsing do inbound de captação: field_map → lead normalizado + HMAC.
 * Sem I/O — puro, testável. A rota (webhooks/in/[token]) faz o resto.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface FieldMap {
  name?: string[];
  phone?: string[];
  email?: string[];
}

const DEFAULT_FIELD_MAP: Required<FieldMap> = {
  name: ["name", "nome", "full_name", "fullname"],
  phone: ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"],
  email: ["email", "e-mail", "mail"],
};

/**
 * Identificadores de clique de anúncio que chegam soltos na URL (site,
 * Typebot) — mesmo destino dos `utm_*`: `source_metadata`, pra alimentar o
 * dashboard e o futuro envio ao Meta/Google Conversions API. `fbclid` é o
 * parâmetro que a Meta gruda na URL de quem clicou; `fbc`/`fbp` são os
 * cookies do Pixel quando o site os tem instalados.
 */
const ATTRIBUTION_KEYS = new Set(["fbclid", "fbc", "fbp", "gclid"]);

/**
 * Achado ao vivo (RevitaFio Mossoró): o MESMO webhook genérico atende a
 * landing page de tráfego pago e a de parceria — cada uma manda seu próprio
 * `origem` (ou `source`) no payload, e antes disso a rota gravava o literal
 * fixo "webhook" pra qualquer uma das duas. `crm_leads.source` é vocabulário
 * aberto (sem CHECK) e o Dashboard de Vendas já quebra receita por ele — deixar
 * o PRÓPRIO payload dizer a origem aproveita esse relatório de graça, sem
 * precisar de um webhook por origem.
 */
const ORIGIN_ALIASES = ["origem", "source", "origin"];

export interface MappedLead {
  name: string | null;
  phone: string | null;
  email: string | null;
  /** `crm_leads.source` real, quando o payload manda um `origem`/`source` — `null` = usa o default do chamador. */
  origin: string | null;
  custom_fields: Record<string, string>;
  source_metadata: Record<string, string>;
}

/** Normaliza telefone BR para E.164. ponytail: heurística BR-only (público-alvo); internacional entra quando houver demanda. */
export function normalizePhoneBR(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const digits = raw.replace(/\D/g, "");
  if (raw.trim().startsWith("+")) {
    return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
  }
  if (digits.length === 12 || digits.length === 13) {
    // 55 + DDD + numero
    return digits.startsWith("55") ? `+${digits}` : null;
  }
  if (digits.length === 10 || digits.length === 11) {
    // DDD + numero (fixo ou celular)
    return `+55${digits}`;
  }
  return null;
}

function firstMatch(payload: Record<string, unknown>, aliases: string[]): { key: string; value: string } | null {
  const lowered = new Map(Object.keys(payload).map((k) => [k.toLowerCase(), k]));
  for (const alias of aliases) {
    const key = lowered.get(alias.toLowerCase());
    if (key !== undefined) {
      const v = payload[key];
      if (typeof v === "string" && v.trim()) return { key, value: v.trim() };
    }
  }
  return null;
}

export function mapInboundPayload(
  payload: Record<string, unknown>,
  fieldMap: FieldMap = {},
): MappedLead {
  const map: Required<FieldMap> = {
    name: [...(fieldMap.name ?? []), ...DEFAULT_FIELD_MAP.name],
    phone: [...(fieldMap.phone ?? []), ...DEFAULT_FIELD_MAP.phone],
    email: [...(fieldMap.email ?? []), ...DEFAULT_FIELD_MAP.email],
  };

  const nameHit = firstMatch(payload, map.name);
  const phoneHit = firstMatch(payload, map.phone);
  const emailHit = firstMatch(payload, map.email);
  // `origem`/`source` não é configurável por field_map (não há dono de
  // instalação que precise renomear isso) — mesmo tratamento fixo que
  // `ATTRIBUTION_KEYS`/`utm_` já recebem logo abaixo.
  const originHit = firstMatch(payload, ORIGIN_ALIASES);
  const consumed = new Set(
    [nameHit?.key, phoneHit?.key, emailHit?.key, originHit?.key].filter(Boolean),
  );

  const custom_fields: Record<string, string> = {};
  const source_metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (consumed.has(key)) continue;
    const str =
      typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : null;
    if (str === null) continue; // objetos/arrays aninhados: descartados no v1
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || ATTRIBUTION_KEYS.has(lower)) source_metadata[lower] = str;
    else custom_fields[key] = str;
  }

  return {
    name: nameHit?.value ?? null,
    phone: normalizePhoneBR(phoneHit?.value),
    email: emailHit?.value ?? null,
    // Minúsculo pra bater com o vocabulário canônico do Select de origem
    // (`LEAD_SOURCES` em lib/leads/lead-form-shared.ts já tem "parceria") —
    // sem isso "Parceria" (como a landing page manda) viraria uma origem
    // solta, fora da lista, em vez de cair na opção de verdade.
    origin: originHit ? originHit.value.trim().toLowerCase() : null,
    custom_fields,
    source_metadata,
  };
}

/**
 * A tag `parceiro:<slug>` que deixa "quantos leads esse parceiro gerou"
 * responder pelo filtro de tag que o Kanban JÁ TEM — sem relatório novo.
 * Lê de `custom_fields` (não remove nada de lá: o Cartão do Lead também lê o
 * valor bruto pra mostrar o bloco "Indicação de parceiro").
 */
export function tagDoParceiro(customFields: Record<string, string>): string | null {
  const nome = customFields["parceiro"];
  if (!nome?.trim()) return null;
  const slug = nome
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `parceiro:${slug}` : null;
}

/** HMAC SHA-256 hex do raw body. Header: X-Deskcomm-Signature. */
export function verifyInboundSignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
