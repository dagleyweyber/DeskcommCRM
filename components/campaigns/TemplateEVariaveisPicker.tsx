"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { deriveTemplateContract, describeAddress } from "@/lib/channels/meta/template-contract";
import { slotKey } from "@/lib/channels/meta/build-components";
import type { VariableMapping, VariableSource } from "@/lib/messaging/variable-mapping";

/**
 * O seletor "modelo aprovado → mapear cada variável" — extraído de dentro
 * de `NovaCampanhaForm.tsx` porque `NovaAutomacaoForm.tsx` precisa do
 * MESMO pedaço, letra por letra (mesmo contrato de slots, mesmo desenho de
 * fixo/nome do contato). Componente CONTROLADO: quem usa é dono do
 * estado, este componente só apresenta e emite mudança — mesma razão de
 * `templateEscolhido` viver no formulário pai (o formulário precisa dele
 * pra montar o payload de criação, não só pra exibir).
 */
export interface TemplateAprovado {
  name: string;
  language: string;
  components: unknown;
}

const FONTES_BASE: Array<{ kind: VariableSource["kind"]; label: string }> = [
  { kind: "fixed", label: "Texto fixo" },
  { kind: "contact_name", label: "Nome do contato" },
  { kind: "contact_first_name", label: "Primeiro nome" },
];

/** Dica do campo de texto fixo — diz o FORMATO esperado, não só "valor". */
export function placeholderPara(expects: string): string {
  switch (expects) {
    case "image":
      return "https://…/imagem.jpg";
    case "video":
      return "https://…/video.mp4";
    case "document":
      return "https://…/arquivo.pdf";
    case "coupon_code":
      return "Código do cupom";
    default:
      return "Valor pra todo mundo";
  }
}

/**
 * Slot de MÍDIA/cupom só aceita texto fixo — nome/primeiro-nome do contato
 * nunca é uma URL de imagem nem um código de cupom. Slot de TEXTO (o caso
 * comum, `{{1}}` no corpo ou num botão) continua com todas as fontes.
 *
 * Achado ao vivo (RevitaFio Mossoró): campanha com template de cabeçalho de
 * imagem mandava "Primeiro nome" pro campo que a Meta espera como
 * `image.link` — o operador escolheu "Primeiro nome" porque a tela oferecia
 * essa opção pra QUALQUER slot, sem diferenciar mídia de texto. Toda
 * mensagem da campanha falhava com `(#100) Param ... image.link is not a
 * valid URI`. A opção errada nem aparece mais.
 */
export function fontesPara(expects: string, extras: Array<{ kind: VariableSource["kind"]; label: string }>) {
  if (expects === "text" || expects === "url_suffix") return [...FONTES_BASE, ...extras];
  return FONTES_BASE.filter((f) => f.kind === "fixed");
}

interface Props {
  aprovados: TemplateAprovado[];
  templateEscolhido: string;
  onTemplateChange: (value: string) => void;
  mapping: VariableMapping;
  onMappingChange: (mapping: VariableMapping) => void;
  /** Fontes extras específicas de um gatilho (ex.: automação de agendamento oferece data/hora). */
  fontesExtras?: Array<{ kind: VariableSource["kind"]; label: string }>;
}

export function TemplateEVariaveisPicker({
  aprovados,
  templateEscolhido,
  onTemplateChange,
  mapping,
  onMappingChange,
  fontesExtras = [],
}: Props) {
  // Chave do slot que está subindo agora, ou `null` — nunca mais de um por
  // vez faz sentido aqui (um clique trava o próprio botão).
  const [subindoSlot, setSubindoSlot] = useState<string | null>(null);

  async function subirImagem(key: string, file: File): Promise<void> {
    setSubindoSlot(key);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // Rota do Storage (URL assinada), não a de criação de template — o
      // ENVIO de mensagem aceita link direto (mesmo caminho que o composer
      // do inbox já usa pra mandar imagem pelo canal oficial,
      // `lib/channels/adapters/meta-cloud.ts`'s `mediaPayload`); só a
      // CRIAÇÃO de definição é que exige o handle da Resumable Upload API.
      const r = await fetch("/api/v1/channels/partner/templates/media", { method: "POST", body: fd });
      const j = (await r.json()) as { data?: { url?: string }; error?: { message?: string } };
      if (!r.ok || !j.data?.url) {
        toast.error(j.error?.message ?? "Não consegui subir a imagem.");
        return;
      }
      onMappingChange({ ...mapping, [key]: { kind: "fixed", value: j.data.url } });
    } finally {
      setSubindoSlot(null);
    }
  }

  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;
  const contrato = useMemo(
    () =>
      atual
        ? deriveTemplateContract({
            name: atual.name,
            language: atual.language,
            components: atual.components as never,
          })
        : null,
    [atual],
  );
  return (
    <>
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="template-picker">
          Modelo aprovado
        </label>
        {aprovados.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum modelo aprovado ainda. Crie um em <strong>Conexões → Templates da Meta</strong>.
          </p>
        ) : (
          <select
            id="template-picker"
            value={templateEscolhido}
            onChange={(e) => {
              onTemplateChange(e.target.value);
              onMappingChange({});
            }}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">Escolha um modelo…</option>
            {aprovados.map((t) => (
              <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`}>
                {t.name} ({t.language})
              </option>
            ))}
          </select>
        )}
      </div>

      {contrato && contrato.slots.length > 0 && (
        <div className="flex flex-col gap-2 rounded-md bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">
            Este modelo pede {contrato.slots.length} valor(es). Escolha um texto fixo (igual pra
            todo mundo) ou um valor que muda por destinatário.
          </p>
          {contrato.slots.map((s) => {
            const key = slotKey(s.address, s.key);
            const fonte = mapping[key];
            const fontes = fontesPara(s.expects, fontesExtras);
            return (
              <div key={key} className="flex flex-wrap items-center gap-2">
                <span className="w-40 shrink-0 text-xs text-muted-foreground">
                  {describeAddress(s.address)} · {s.contextBefore.slice(-15)}…
                </span>
                <select
                  value={fonte?.kind ?? "fixed"}
                  onChange={(e) => {
                    const kind = e.target.value as VariableSource["kind"];
                    const proximo: VariableSource =
                      kind === "fixed" ? { kind: "fixed", value: "" } : { kind };
                    onMappingChange({ ...mapping, [key]: proximo });
                  }}
                  aria-label={`Fonte do valor de ${describeAddress(s.address)}`}
                  className="h-8 w-44 rounded-md border border-input bg-background px-2 text-sm"
                >
                  {fontes.map((f) => (
                    <option key={f.kind} value={f.kind}>
                      {f.label}
                    </option>
                  ))}
                </select>
                {(!fonte || fonte.kind === "fixed") && (
                  <input
                    value={fonte?.kind === "fixed" ? fonte.value : ""}
                    onChange={(e) =>
                      onMappingChange({ ...mapping, [key]: { kind: "fixed", value: e.target.value } })
                    }
                    placeholder={placeholderPara(s.expects)}
                    aria-label={`Texto fixo de ${describeAddress(s.address)}`}
                    className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                  />
                )}
                {/* Só imagem: a rota de Storage que faz o upload (ver
                    `subirImagem` acima) só aceita JPG/PNG — vídeo/documento
                    continuam por URL colada até a rota ganhar esses tipos. */}
                {(!fonte || fonte.kind === "fixed") && s.expects === "image" && (
                  <label
                    className="flex h-8 shrink-0 cursor-pointer items-center rounded-md border border-dashed border-input px-2 text-xs text-muted-foreground hover:bg-muted"
                    aria-disabled={subindoSlot === key}
                  >
                    {subindoSlot === key ? "Subindo…" : "Subir imagem"}
                    <input
                      type="file"
                      accept="image/jpeg,image/png"
                      className="hidden"
                      disabled={subindoSlot === key}
                      aria-label={`Subir imagem pra ${describeAddress(s.address)}`}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        e.target.value = "";
                        if (f) void subirImagem(key, f);
                      }}
                    />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
