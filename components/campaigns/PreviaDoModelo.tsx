"use client";
import { slotKey } from "@/lib/channels/meta/build-components";
import type { SlotAddress } from "@/lib/channels/meta/template-contract";
import type { VariableMapping, VariableSource } from "@/lib/messaging/variable-mapping";

/**
 * A mensagem como o paciente vai ver, ao lado do seletor de modelo.
 *
 * Por que existe: a lista de modelos aprovados é só NOME, e dois nomes
 * parecidos (`campanha_11_11` × `2_campanha_11_11`) bastam para disparar a
 * campanha errada para a base inteira. Pedido do dono do produto (2026-11-08).
 *
 * As variáveis entram com o valor que o operador escolheu: texto fixo como está,
 * nome do contato com um nome de exemplo, e o que ainda não tem valor aparece
 * como `{{1}}` destacado — é o que falta preencher.
 */

interface Bruto {
  type?: string;
  format?: string;
  text?: string;
  buttons?: Array<{ type?: string; text?: string; url?: string }>;
}

const EXEMPLO: Partial<Record<VariableSource["kind"], string>> = {
  contact_name: "Maria Silva",
  contact_first_name: "Maria",
  appointment_date: "12/11",
  appointment_time: "14:30",
};

export interface Trecho {
  texto: string;
  /** `true` = variável sem valor ainda: a tela destaca. */
  faltando?: boolean;
  /** `true` = veio de uma variável preenchida. */
  variavel?: boolean;
}

/** Valor que a prévia mostra para um slot — `null` quando ainda não há valor. */
export function valorDeExemplo(fonte: VariableSource | undefined): string | null {
  if (!fonte) return null;
  if (fonte.kind === "fixed") return fonte.value.trim() ? fonte.value : null;
  return EXEMPLO[fonte.kind] ?? null;
}

/** Quebra o texto em trechos, trocando cada `{{x}}` pelo valor do seu slot. */
export function trechosDaPrevia(
  texto: string,
  endereco: SlotAddress,
  mapping: VariableMapping,
): Trecho[] {
  const out: Trecho[] = [];
  let ultimo = 0;
  for (const m of texto.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    const inicio = m.index ?? 0;
    if (inicio > ultimo) out.push({ texto: texto.slice(ultimo, inicio) });
    const valor = valorDeExemplo(mapping[slotKey(endereco, m[1]!)]);
    out.push(valor === null ? { texto: m[0], faltando: true } : { texto: valor, variavel: true });
    ultimo = inicio + m[0].length;
  }
  if (ultimo < texto.length) out.push({ texto: texto.slice(ultimo) });
  return out;
}

function Texto({ trechos }: { trechos: Trecho[] }) {
  return (
    <>
      {trechos.map((t, i) =>
        t.faltando ? (
          <span key={i} className="rounded bg-amber-200/80 px-0.5 font-mono text-[12px] text-amber-900">
            {t.texto}
          </span>
        ) : (
          <span key={i} className={t.variavel ? "font-medium text-emerald-800 dark:text-emerald-300" : undefined}>
            {t.texto}
          </span>
        ),
      )}
    </>
  );
}

export function PreviaDoModelo({
  components,
  mapping,
}: {
  components: unknown;
  mapping: VariableMapping;
}) {
  const lista = (Array.isArray(components) ? components : []) as Bruto[];
  const achar = (tipo: string) => lista.find((c) => (c.type ?? "").toUpperCase() === tipo);
  const cabecalho = achar("HEADER");
  const corpo = achar("BODY");
  const rodape = achar("FOOTER");
  const botoes = achar("BUTTONS")?.buttons ?? [];

  const formato = (cabecalho?.format ?? "TEXT").toUpperCase();
  const midia = cabecalho && formato !== "TEXT" ? valorDeExemplo(mapping[slotKey({ kind: "header" }, "1")]) : null;

  return (
    <div className="flex flex-col gap-1" data-testid="previa-do-modelo">
      <span className="text-sm font-medium">Como o paciente vai ver</span>
      <div className="rounded-lg bg-[#efeae2] p-3 dark:bg-[#0b141a]">
        <div className="max-w-[340px] overflow-hidden rounded-lg bg-white text-[13.5px] leading-snug text-[#111b21] shadow-sm dark:bg-[#202c33] dark:text-[#e9edef]">
          {cabecalho && formato !== "TEXT" && (
            <div className="p-1 pb-0">
              {formato === "IMAGE" && midia ? (
                // Prévia de URL que o próprio operador colou ou subiu — sem next/image de propósito.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={midia} alt="" className="max-h-48 w-full rounded-md object-cover" />
              ) : (
                <div className="flex h-28 items-center justify-center rounded-md bg-black/5 text-xs text-muted-foreground dark:bg-white/5">
                  {formato === "IMAGE" ? "Imagem" : formato === "VIDEO" ? "Vídeo" : "Documento"}
                  {midia ? "" : " (falta escolher)"}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-col gap-1 px-2.5 pb-1.5 pt-2">
            {cabecalho && formato === "TEXT" && cabecalho.text && (
              <p className="font-semibold">
                <Texto trechos={trechosDaPrevia(cabecalho.text, { kind: "header" }, mapping)} />
              </p>
            )}
            {corpo?.text && (
              <p className="whitespace-pre-wrap break-words">
                <Texto trechos={trechosDaPrevia(corpo.text, { kind: "body" }, mapping)} />
              </p>
            )}
            {rodape?.text && <p className="text-xs text-[#667781] dark:text-[#8696a0]">{rodape.text}</p>}
          </div>
          {botoes.map((b, i) => (
            <div
              key={i}
              className="border-t border-black/10 py-2 text-center text-[13.5px] font-medium text-[#027eb5] dark:border-white/10 dark:text-[#53bdeb]"
              title={b.url ?? undefined}
            >
              {b.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
