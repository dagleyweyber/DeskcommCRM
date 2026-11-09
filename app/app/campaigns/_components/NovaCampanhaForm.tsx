"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  fraseDosValoresSemFonte,
  valoresSemFonte,
  type Definicao,
} from "@/lib/channels/valores-sem-fonte";
import { TemplateEVariaveisPicker } from "@/components/campaigns/TemplateEVariaveisPicker";
import {
  useCreateCampaign,
  usePreviewAudience,
  type ContagemDoPublico,
  type RegrasDeEnvioInput,
} from "@/hooks/campaigns/useCampaigns";
import { JANELAS_EM_DIAS, type JanelaEmDias } from "@/lib/campaigns/regras-de-envio";
import {
  RITMOS,
  VELOCIDADE_PADRAO,
  VELOCIDADES_DA_CAMPANHA,
  type VelocidadeDaCampanha,
} from "@/lib/campaigns/velocidade";
import { useTemplates } from "@/hooks/channels/useTemplates";
import { useContactTags } from "@/hooks/contacts/useContactTags";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import type { AudienceFilter } from "@/lib/campaigns/audience";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

type AudienceKind = AudienceFilter["kind"];

/** "Vai sair para 1.000 de 2.000 — 400 já receberam, 600 ficam para depois." */
export function fraseDaContagem(c: ContagemDoPublico): string {
  if (c.do_filtro === 0) return "Nenhum contato bate com esse público.";
  const n = (v: number) => v.toLocaleString("pt-BR");
  if (c.total === 0) return `Todos os ${n(c.do_filtro)} contatos desse público já receberam campanha no período.`;
  const motivos = [
    c.excluidos_por_recente > 0 ? `${n(c.excluidos_por_recente)} já receberam` : null,
    c.cortados_pelo_limite > 0 ? `${n(c.cortados_pelo_limite)} ficam para a próxima` : null,
  ].filter(Boolean);
  if (motivos.length === 0) return `Isso vai atingir ${n(c.total)} contato(s).`;
  return `Vai sair para ${n(c.total)} de ${n(c.do_filtro)} contatos — ${motivos.join(", ")}.`;
}

export function NovaCampanhaForm({ onCriada }: { onCriada: () => void }) {
  const templates = useTemplates();
  const pipelines = usePipelines();
  const tags = useContactTags();
  const preview = usePreviewAudience();
  const criar = useCreateCampaign();

  const [nome, setNome] = useState("");
  const [templateEscolhido, setTemplateEscolhido] = useState("");
  const [mapping, setMapping] = useState<VariableMapping>({});
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("tag");
  const [tag, setTag] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [contagem, setContagem] = useState<ContagemDoPublico | null>(null);
  const [janela, setJanela] = useState<JanelaEmDias | null>(null);
  const [limiteTexto, setLimiteTexto] = useState("");
  const [velocidade, setVelocidade] = useState<VelocidadeDaCampanha>(VELOCIDADE_PADRAO);
  const limite = /^\d+$/.test(limiteTexto) && Number(limiteTexto) > 0 ? Number(limiteTexto) : null;
  const regras: RegrasDeEnvioInput = { excluir_quem_recebeu_dias: janela, limite };

  const stages = usePipelineStages(pipelineId || null);

  const aprovados = useMemo(
    () => (templates.data?.data.templates ?? []).filter((t) => t.status === "APPROVED"),
    [templates.data],
  );
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;

  // Toda variável do modelo precisa de uma origem ANTES de criar: sem isso o primeiro
  // disparo é recusado (`template_missing_values`) para todo destinatário. A API confere
  // de novo — esta é a mesma regra, só que dita na hora em vez de depois.
  const semFonte = useMemo(
    () =>
      atual
        ? valoresSemFonte(
            {
              name: atual.name,
              language: atual.language,
              parameter_format: atual.parameterFormat,
              components: atual.components as Definicao["components"],
            },
            mapping,
          )
        : [],
    [atual, mapping],
  );

  function audience(): AudienceFilter | null {
    if (audienceKind === "tag") return tag.trim() ? { kind: "tag", tag: tag.trim() } : null;
    if (audienceKind === "pipeline_stage")
      return pipelineId && stageId ? { kind: "pipeline_stage", pipelineId, stageId } : null;
    return { kind: "all_contacts" };
  }

  async function verContagem() {
    const filtro = audience();
    if (!filtro) {
      toast.error("Escolha o público antes de conferir a contagem.");
      return;
    }
    const r = await preview.mutateAsync({ audience: filtro, regras });
    setContagem(r.data);
  }

  function criarCampanha() {
    const filtro = audience();
    const channelSessionId = templates.data?.data.channelSessionId;
    if (!nome.trim() || !atual || !filtro || !channelSessionId) return;
    criar.mutate(
      {
        name: nome.trim(),
        channel_session_id: channelSessionId,
        template_name: atual.name,
        template_language: atual.language,
        variable_mapping: mapping,
        audience: filtro,
        regras,
        velocidade,
      },
      {
        onSuccess: (r) => {
          toast.success(`Campanha criada com ${r.data.total_recipients} destinatário(s). Ainda não foi disparada.`);
          onCriada();
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-4">
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium" htmlFor="campanha-nome">
          Nome da campanha
        </label>
        <input
          id="campanha-nome"
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          placeholder="Ex.: Promoção de setembro"
          className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        />
      </div>

      <TemplateEVariaveisPicker
        aprovados={aprovados}
        templateEscolhido={templateEscolhido}
        onTemplateChange={setTemplateEscolhido}
        mapping={mapping}
        onMappingChange={setMapping}
      />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Público</span>
        <div className="flex flex-wrap gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="audience-kind"
              checked={audienceKind === "tag"}
              onChange={() => setAudienceKind("tag")}
            />
            Por tag
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="audience-kind"
              checked={audienceKind === "pipeline_stage"}
              onChange={() => setAudienceKind("pipeline_stage")}
            />
            Por etapa do funil
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              name="audience-kind"
              checked={audienceKind === "all_contacts"}
              onChange={() => setAudienceKind("all_contacts")}
            />
            Todos os contatos
          </label>
        </div>

        {audienceKind === "tag" && (
          <>
            {/* Sugere as tags que existem: o público é por igualdade exata, e "VIP" ≠ "vip". */}
            <input
              value={tag}
              onChange={(e) => {
                setTag(e.target.value);
                setContagem(null);
              }}
              list="campanha-tags"
              placeholder="Nome da tag"
              aria-label="Tag do público"
              className="h-9 w-64 max-w-full rounded-md border border-input bg-background px-2 text-sm"
            />
            <datalist id="campanha-tags">
              {(tags.data ?? []).map((t) => (
                <option key={t.tag} value={t.tag}>{`${t.total.toLocaleString("pt-BR")} contatos`}</option>
              ))}
            </datalist>
          </>
        )}

        {audienceKind === "pipeline_stage" && (
          <div className="flex flex-wrap gap-2">
            <select
              value={pipelineId}
              onChange={(e) => {
                setPipelineId(e.target.value);
                setStageId("");
              }}
              aria-label="Funil"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">Escolha o funil…</option>
              {(pipelines.data?.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              disabled={!pipelineId}
              aria-label="Etapa"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50"
            >
              <option value="">Escolha a etapa…</option>
              {(stages.data?.data.stages ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}

      </div>

      {/* Mandar uma base grande em partes sem repetir ninguém: hoje 1.000 com
          teto, amanhã a mesma lista com "últimas 24h" pega só quem faltou. */}
      <div className="flex flex-col gap-2" data-testid="campanha-regras">
        <span className="text-sm font-medium">Evitar repetição</span>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="campanha-janela">Não enviar para quem recebeu campanha</label>
          <select
            id="campanha-janela"
            value={janela ?? ""}
            onChange={(e) => {
              setJanela(e.target.value ? (Number(e.target.value) as JanelaEmDias) : null);
              setContagem(null);
            }}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            <option value="">— enviar para todos —</option>
            {JANELAS_EM_DIAS.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "nas últimas 24 horas" : `nos últimos ${d} dias`}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="campanha-limite">Enviar para no máximo</label>
          <input
            id="campanha-limite"
            inputMode="numeric"
            value={limiteTexto}
            onChange={(e) => {
              setLimiteTexto(e.target.value.replace(/\D/g, "").slice(0, 6));
              setContagem(null);
            }}
            placeholder="sem limite"
            className="h-9 w-28 rounded-md border border-input bg-background px-2 text-sm"
          />
          <span className="text-muted-foreground">contatos nesta campanha</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Quem está na fila de uma campanha em andamento também fica de fora quando a primeira opção
          está ligada.
        </p>
      </div>

      {/* A Meta limita por nível do número (250, 1.000, 10 mil… contatos a cada 24 h) e pela
          qualidade; ir mais rápido só adianta se o número aguenta. Padrão = o ritmo de sempre. */}
      <div className="flex flex-col gap-2" data-testid="campanha-velocidade">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label htmlFor="campanha-velocidade-select" className="font-medium">
            Velocidade do envio
          </label>
          <select
            id="campanha-velocidade-select"
            value={velocidade}
            onChange={(e) => setVelocidade(e.target.value as VelocidadeDaCampanha)}
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
          >
            {VELOCIDADES_DA_CAMPANHA.map((v) => (
              <option key={v} value={v}>
                {RITMOS[v].rotulo} — cerca de {RITMOS[v].porHora.toLocaleString("pt-BR")} por hora
              </option>
            ))}
          </select>
        </div>
        {velocidade !== VELOCIDADE_PADRAO && (
          <p className="text-xs text-amber-700 dark:text-amber-500" data-testid="campanha-velocidade-aviso">
            A Meta limita quantos contatos diferentes o número alcança em 24 horas (250, 1.000, 10 mil…
            conforme o nível dele). Use mais rápido só se o número já aguenta essa quantidade com boa
            qualidade. Se muitos envios falharem em sequência, o disparo desacelera sozinho.
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={verContagem} disabled={preview.isPending}>
          {preview.isPending ? "Contando…" : "Ver quantos contatos"}
        </Button>
        {contagem !== null && (
          <span className="text-sm text-muted-foreground" data-testid="campanha-contagem">
            {fraseDaContagem(contagem)}
          </span>
        )}
      </div>

      {semFonte.length > 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-500" data-testid="campanha-variaveis-faltando">
          {fraseDosValoresSemFonte(semFonte)}
        </p>
      )}

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={criarCampanha}
          disabled={
            !nome.trim() ||
            !atual ||
            semFonte.length > 0 ||
            criar.isPending ||
            !templates.data?.data.channelSessionId
          }
        >
          {criar.isPending ? "Criando…" : "Criar campanha"}
        </Button>
      </div>
    </div>
  );
}
