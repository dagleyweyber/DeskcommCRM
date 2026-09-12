"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { TemplateEVariaveisPicker } from "@/components/campaigns/TemplateEVariaveisPicker";
import { useCreateCampaign, usePreviewAudience } from "@/hooks/campaigns/useCampaigns";
import { useTemplates } from "@/hooks/channels/useTemplates";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import type { AudienceFilter } from "@/lib/campaigns/audience";
import type { VariableMapping } from "@/lib/messaging/variable-mapping";

type AudienceKind = AudienceFilter["kind"];

export function NovaCampanhaForm({ onCriada }: { onCriada: () => void }) {
  const templates = useTemplates();
  const pipelines = usePipelines();
  const preview = usePreviewAudience();
  const criar = useCreateCampaign();

  const [nome, setNome] = useState("");
  const [templateEscolhido, setTemplateEscolhido] = useState("");
  const [mapping, setMapping] = useState<VariableMapping>({});
  const [audienceKind, setAudienceKind] = useState<AudienceKind>("tag");
  const [tag, setTag] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  const [previewTotal, setPreviewTotal] = useState<number | null>(null);

  const stages = usePipelineStages(pipelineId || null);

  const aprovados = useMemo(
    () => (templates.data?.data.templates ?? []).filter((t) => t.status === "APPROVED"),
    [templates.data],
  );
  const atual = aprovados.find((t) => `${t.name}|${t.language}` === templateEscolhido) ?? null;

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
    const r = await preview.mutateAsync(filtro);
    setPreviewTotal(r.data.total);
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
          <input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="Nome da tag"
            aria-label="Tag do público"
            className="h-9 w-64 rounded-md border border-input bg-background px-2 text-sm"
          />
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

        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={verContagem} disabled={preview.isPending}>
            {preview.isPending ? "Contando…" : "Ver quantos contatos"}
          </Button>
          {previewTotal !== null && (
            <span className="text-sm text-muted-foreground">
              {previewTotal === 0
                ? "Nenhum contato bate com esse público."
                : `Isso vai atingir ${previewTotal} contato(s).`}
            </span>
          )}
        </div>
      </div>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={criarCampanha}
          disabled={!nome.trim() || !atual || criar.isPending || !templates.data?.data.channelSessionId}
        >
          {criar.isPending ? "Criando…" : "Criar campanha"}
        </Button>
      </div>
    </div>
  );
}
