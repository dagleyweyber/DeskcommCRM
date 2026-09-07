"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PreviaDaDefinicao } from "./PreviaDaDefinicao";
import {
  useCreateTemplate,
  useSyncTemplates,
  useTemplates,
  type TemplatePreview,
} from "@/hooks/channels/useTemplates";
import {
  contarVariaveis,
  IDIOMAS_DA_DEFINICAO,
  LIMITE_BOTOES,
  LIMITE_CORPO,
  LIMITE_RODAPE,
  montarComponents,
  type BotaoDaDefinicao,
} from "@/lib/channels/template-conteudo";
import { cn } from "@/lib/utils";

/** Só APPROVED pode ser disparado — o resto é informação, não opção. */
function statusTone(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "APPROVED") return "default";
  if (status === "REJECTED" || status === "DISABLED") return "destructive";
  if (status === "PENDING") return "secondary";
  return "outline";
}

/**
 * O preview é a peça central desta tela. A Meta **não devolve** valores de exemplo
 * (`example` vem null nos templates reais), então o único jeito de o operador saber
 * o que preencher é ver o texto ao redor do parâmetro.
 *
 * O texto aparece INTEIRO e uma vez só, com todos os `{{n}}` marcados. A versão
 * anterior repetia o corpo a cada slot — cada linha destacava o seu e deixava o
 * vizinho cru, o que é tecnicamente correto e ilegível.
 */
function Preview({ preview }: { preview: TemplatePreview }) {
  const partes = preview.text.split(/(\{\{\w+\}\})/g);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {preview.onde}
      </span>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {partes.map((parte, i) =>
          /^\{\{\w+\}\}$/.test(parte) ? (
            <span
              key={i}
              className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-xs font-medium text-primary ring-1 ring-primary/20"
            >
              {parte.slice(2, -2)}
            </span>
          ) : (
            <span key={i} className="text-muted-foreground">
              {parte}
            </span>
          ),
        )}
      </p>
    </div>
  );
}

/**
 * Criar uma definição nova, direto na WABA do canal oficial.
 *
 * Achado ao vivo (RevitaFio Mossoró): antes desta tela, criar um modelo exigia
 * sair do CRM e entrar no Gerenciador do WhatsApp da Meta. O formulário abaixo
 * reaproveita os MESMOS helpers do canal intermediado
 * (`lib/channels/template-conteudo.ts`) — o formato do contrato é o mesmo,
 * porque as duas portas escrevem na mesma WABA.
 */
function CriarModelo({ onCriado }: { onCriado: () => void }) {
  const criar = useCreateTemplate();
  const [nome, setNome] = useState("");
  const [idioma, setIdioma] = useState("pt_BR");
  const [categoria, setCategoria] = useState("UTILITY");
  const [corpo, setCorpo] = useState("");
  const [rodape, setRodape] = useState("");
  const [exemplos, setExemplos] = useState<string[]>([]);
  const [cabecalho, setCabecalho] = useState("");
  const [midiaUrl, setMidiaUrl] = useState("");
  const [botoes, setBotoes] = useState<BotaoDaDefinicao[]>([]);
  const [subindo, setSubindo] = useState(false);

  // Recalculado enquanto se digita: o operador vê o campo de exemplo aparecer
  // no instante em que escreve `{{1}}`, não numa recusa que chega horas depois.
  const nVariaveis = contarVariaveis(corpo);

  return (
    <div className="grid gap-4 rounded-md border border-border p-3 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-2">
          <input
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            placeholder="nome_do_modelo"
            aria-label="Nome do modelo"
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm"
          />
          {/* LISTA, e não campo livre: `esp`, `ES`, `es-AR` são todos recusados,
              e a recusa vem como "language not supported" horas depois. */}
          <select
            value={idioma}
            onChange={(e) => setIdioma(e.target.value)}
            aria-label="Idioma"
            className="h-9 w-56 rounded-md border border-input bg-background px-2 text-sm"
          >
            {IDIOMAS_DA_DEFINICAO.map((i) => (
              <option key={i.codigo} value={i.codigo}>
                {i.rotulo} ({i.codigo})
              </option>
            ))}
          </select>
        </div>

        <select
          value={categoria}
          onChange={(e) => setCategoria(e.target.value)}
          aria-label="Categoria"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        >
          <option value="UTILITY">Utilidade — aviso de pedido, agendamento, cobrança</option>
          <option value="MARKETING">Marketing — promoção, novidade, reengajamento</option>
          <option value="AUTHENTICATION">Autenticação — código de verificação</option>
        </select>

        {/* CABEÇALHO opcional: texto OU mídia, nunca os dois — a plataforma
            aceita um formato por definição, e mandar ambos é recusa. */}
        <div className="flex flex-wrap gap-2">
          <input
            value={cabecalho}
            onChange={(e) => {
              setCabecalho(e.target.value);
              if (e.target.value) setMidiaUrl("");
            }}
            placeholder="Cabeçalho de texto (opcional)"
            aria-label="Cabeçalho de texto"
            disabled={!!midiaUrl}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
          />
          <label
            className={cn(
              "flex h-9 flex-1 cursor-pointer items-center justify-center rounded-md border border-dashed border-input px-2 text-sm text-muted-foreground hover:bg-muted",
              cabecalho && "pointer-events-none opacity-50",
            )}
          >
            {subindo ? "Subindo…" : midiaUrl ? "Trocar imagem" : "Subir imagem (JPG/PNG)"}
            <input
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              aria-label="Imagem do cabeçalho"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setSubindo(true);
                try {
                  const fd = new FormData();
                  fd.append("file", f);
                  const r = await fetch("/api/v1/channels/partner/templates/media", {
                    method: "POST",
                    body: fd,
                  });
                  const j = (await r.json()) as {
                    data?: { url?: string };
                    error?: { message?: string };
                  };
                  if (!r.ok || !j.data?.url) {
                    toast.error(j.error?.message ?? "Não consegui subir a imagem.");
                    return;
                  }
                  setMidiaUrl(j.data.url);
                  setCabecalho("");
                } finally {
                  setSubindo(false);
                  e.target.value = "";
                }
              }}
            />
          </label>
        </div>

        <div className="flex flex-col gap-1">
          <textarea
            value={corpo}
            onChange={(e) => setCorpo(e.target.value.slice(0, LIMITE_CORPO))}
            placeholder="Texto da mensagem. Use {{1}}, {{2}} para os valores que mudam."
            aria-label="Conteúdo"
            className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
          />
          <span className="self-end text-[10px] text-muted-foreground">
            {corpo.length}/{LIMITE_CORPO}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <input
            value={rodape}
            onChange={(e) => setRodape(e.target.value.slice(0, LIMITE_RODAPE))}
            placeholder="Rodapé (opcional) — texto pequeno no fim da mensagem"
            aria-label="Rodapé"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          />
          <span className="self-end text-[10px] text-muted-foreground">
            {rodape.length}/{LIMITE_RODAPE}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          {botoes.map((b, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                value={b.tipo}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, tipo: e.target.value as BotaoDaDefinicao["tipo"] };
                  setBotoes(p);
                }}
                aria-label={`Tipo do botão ${i + 1}`}
                className="h-8 w-40 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="quick_reply">Resposta rápida</option>
                <option value="url">Abrir link</option>
                <option value="phone_number">Ligar</option>
              </select>
              <input
                value={b.texto}
                onChange={(e) => {
                  const p = [...botoes];
                  p[i] = { ...b, texto: e.target.value };
                  setBotoes(p);
                }}
                placeholder="Texto do botão"
                aria-label={`Texto do botão ${i + 1}`}
                className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              />
              {b.tipo === "url" && (
                <input
                  value={b.url ?? ""}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, url: e.target.value };
                    setBotoes(p);
                  }}
                  placeholder="https://…"
                  aria-label={`URL do botão ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              )}
              {b.tipo === "phone_number" && (
                <input
                  value={b.telefone ?? ""}
                  onChange={(e) => {
                    const p = [...botoes];
                    p[i] = { ...b, telefone: e.target.value };
                    setBotoes(p);
                  }}
                  placeholder="+55…"
                  aria-label={`Telefone do botão ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              )}
              <button
                type="button"
                onClick={() => setBotoes(botoes.filter((_, j) => j !== i))}
                className="text-xs text-muted-foreground hover:text-destructive"
                aria-label={`Remover botão ${i + 1}`}
              >
                remover
              </button>
            </div>
          ))}
          {botoes.length < LIMITE_BOTOES && (
            <button
              type="button"
              onClick={() => setBotoes([...botoes, { tipo: "quick_reply", texto: "" }])}
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              + Adicionar botão ({botoes.length}/{LIMITE_BOTOES})
            </button>
          )}
        </div>

        {nVariaveis > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50/50 p-2 dark:border-amber-800/60 dark:bg-amber-950/20">
            <p className="text-[11px] text-amber-900 dark:text-amber-200">
              A revisão exige um exemplo de cada valor. Sem eles o modelo é recusado.
            </p>
            {Array.from({ length: nVariaveis }, (_, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">
                  {`{{${i + 1}}}`}
                </span>
                <input
                  value={exemplos[i] ?? ""}
                  onChange={(e) => {
                    const proximo = [...exemplos];
                    proximo[i] = e.target.value;
                    setExemplos(proximo);
                  }}
                  placeholder="ex.: Maria"
                  aria-label={`Exemplo do valor ${i + 1}`}
                  className="h-8 flex-1 rounded-md border border-input bg-background px-2 text-sm"
                />
              </div>
            ))}
          </div>
        )}

        <p className="text-[11px] text-muted-foreground">
          A Meta revisa antes de aprovar — o modelo nasce pendente e some da lista de envio até
          ela decidir.
        </p>
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!nome.trim() || !corpo.trim() || criar.isPending}
            onClick={() =>
              criar.mutate(
                {
                  name: nome.trim(),
                  language: idioma.trim(),
                  category: categoria,
                  components: montarComponents({
                    body: corpo,
                    footer: rodape,
                    exemplos,
                    cabecalho: { texto: cabecalho, midiaUrl },
                    botoes,
                  }),
                },
                {
                  onSuccess: () => {
                    toast.success("Modelo enviado para revisão da Meta.");
                    setNome("");
                    setCorpo("");
                    setRodape("");
                    setExemplos([]);
                    setCabecalho("");
                    setMidiaUrl("");
                    setBotoes([]);
                    onCriado();
                  },
                },
              )
            }
          >
            {criar.isPending ? "Enviando…" : "Enviar para revisão"}
          </Button>
        </div>
      </div>

      {/* A prévia fica AO LADO, não embaixo: embaixo ela sai da tela junto com
          o botão de enviar, e o operador manda sem ter olhado. */}
      <div className="lg:sticky lg:top-4 lg:self-start">
        <PreviaDaDefinicao
          cabecalho={cabecalho}
          midiaUrl={midiaUrl}
          corpo={corpo}
          rodape={rodape}
          botoes={botoes}
        />
      </div>
    </div>
  );
}

export function TemplatesClient() {
  const { data, isPending } = useTemplates();
  const sync = useSyncTemplates();
  const [criando, setCriando] = useState(false);

  const waba = data?.data.waba ?? null;
  const templates = data?.data.templates ?? null;

  async function sincronizar() {
    const res = await sync.mutateAsync();
    const { inserted, updated, disabled } = res.data;
    toast.success(
      `Sincronizado: ${inserted} novo(s), ${updated} atualizado(s), ${disabled} desativado(s).`,
    );
  }

  if (isPending || templates === null) {
    return <p className="text-sm text-muted-foreground">Carregando…</p>;
  }

  // Estado vazio que ENSINA — distinguir "canal não conectado" de "conectado sem
  // template" é a diferença entre o operador saber o próximo passo ou não.
  if (!waba) {
    return (
      <Card className="p-6">
        <h2 className="font-medium">Canal oficial não conectado</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Os templates vivem na sua conta do WhatsApp Business (Meta) — esta tela é um espelho
          deles. Conecte o canal oficial em <strong>Conexões WhatsApp</strong> para começar a
          sincronizar.
        </p>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="templates-root">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Espelho da conta <span className="font-mono text-xs">{waba}</span> ·{" "}
          {templates.length} template(s)
        </p>
        <div className="flex gap-2">
          <Button onClick={sincronizar} disabled={sync.isPending} data-testid="btn-sync">
            {sync.isPending ? "Sincronizando…" : "Sincronizar com a Meta"}
          </Button>
          <Button
            type="button"
            variant={criando ? "outline" : "default"}
            onClick={() => setCriando((v) => !v)}
          >
            {criando ? "Cancelar" : "Criar modelo"}
          </Button>
        </div>
      </div>

      {criando && <CriarModelo onCriado={() => setCriando(false)} />}

      {templates.length === 0 ? (
        <Card className="p-6">
          <h2 className="font-medium">Nenhum template ainda</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Clique em <strong>Criar modelo</strong> para enviar um novo para revisão da Meta, ou
            em <strong>Sincronizar com a Meta</strong> se já criou algum por lá. Só templates
            aprovados podem ser enviados fora da janela de 24 horas.
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {templates.map((t) => (
            <Card key={`${t.name}:${t.language}`} className="p-4" data-testid="template-card">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{t.name}</span>
                <Badge variant="outline" className="font-mono text-xs">
                  {t.language}
                </Badge>
                <Badge variant={statusTone(t.status)}>{t.status}</Badge>
                {t.category ? (
                  <Badge variant="outline" className="text-xs">
                    {t.category}
                  </Badge>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  {t.slots.length === 0
                    ? "sem parâmetros"
                    : `${t.slots.length} parâmetro(s)`}
                </span>
              </div>

              {t.rejectedReason ? (
                <p className="mt-2 text-sm text-destructive">Recusado: {t.rejectedReason}</p>
              ) : null}

              {t.previews.length > 0 || t.slots.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3 border-l-2 border-muted pl-3">
                  {t.previews.map((p, i) => (
                    <Preview key={`${p.onde}:${i}`} preview={p} />
                  ))}
                  {/* Slots SEM texto ao redor: header de mídia. É justamente o
                      parâmetro que contar `{{n}}` não enxerga. */}
                  {t.slots
                    .filter((s) => s.expects !== "text")
                    .map((s, i) => (
                      <div key={`m:${s.onde}:${i}`} className="flex flex-col gap-0.5">
                        <span className="text-xs uppercase tracking-wide text-muted-foreground">
                          {s.onde} · {s.expects}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          arquivo de {s.expects} enviado no disparo
                        </span>
                      </div>
                    ))}
                </div>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
