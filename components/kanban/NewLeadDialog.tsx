"use client";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateLead } from "@/hooks/kanban/useCreateLead";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useServiceOptions } from "@/hooks/pipelines/useServiceOptions";
import type { Stage } from "@/lib/kanban/types";
import { createLeadSchema, type CreateLeadInput } from "@/lib/schemas/leads";
import { LEAD_SOURCES, NO_OWNER, normalizePhoneBR } from "@/lib/leads/lead-form-shared";
import { parseReaisToCents } from "@/lib/money";
import { EcoDoValor } from "./EcoDoValor";

interface FormShape {
  title: string;
  description: string;
  stage_id: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
  phone: string;
  email: string;
  owner_user_id: string;
  produtoInteresse: string;
  source: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  pipelineId: string;
  stages: Stage[];
  /** Vincula o lead criado a este contato de origem (ex.: painel do Inbox). */
  contactId?: string | null;
}

function defaultStageId(stages: Stage[]): string {
  const open = stages.find((s) => !s.is_won && !s.is_lost && !s.is_archived);
  return open?.id ?? stages[0]?.id ?? "";
}

export function NewLeadDialog({ open, onOpenChange, pipelineId, stages, contactId }: Props) {
  const create = useCreateLead(pipelineId);
  const createContact = useCreateContact();
  const { data: members } = useAssignableMembers(open);
  const { data: serviceOptionsRes } = useServiceOptions(pipelineId);
  const serviceOptions = serviceOptionsRes?.data.service_options ?? [];
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);
  // Achado ao vivo: dois leads pro mesmo contato, no mesmo pipeline, um sem
  // valor escondendo o outro que fechou de verdade — a criação manual nunca
  // avisava. `duplicidade` guarda o lead já aberto que o servidor encontrou;
  // `payloadPendente` é o mesmo payload já montado (contato já resolvido),
  // pronto pra reenviar com `confirm_duplicate: true` sem recriar o contato.
  const [duplicidade, setDuplicidade] = useState<{ leadId: string; titulo: string } | null>(null);
  const [payloadPendente, setPayloadPendente] = useState<CreateLeadInput | null>(null);
  // Achado ao vivo (RevitaFio Mossoró): criar lead manual pra um telefone que já
  // é contato — o caso comum numa base que veio do WhatsApp — parava aqui sem
  // NENHUM jeito de continuar. `createContact` recusava com 409, o catch só
  // repassava o toast e abortava, e o lead nunca nascia. `contatoExistente`
  // guarda quem o servidor achou; `valoresPendentes` é o formulário no instante
  // da tentativa, pra remontar o payload sem pedir pra pessoa preencher de novo.
  const [contatoExistente, setContatoExistente] = useState<{
    id: string;
    nome: string | null;
  } | null>(null);
  const [valoresPendentes, setValoresPendentes] = useState<FormShape | null>(null);

  const form = useForm<FormShape>({
    defaultValues: {
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      tagsRaw: "",
      expected_close_date: "",
      phone: "",
      email: "",
      owner_user_id: NO_OWNER,
      produtoInteresse: "",
      source: "manual",
    },
  });

  // Reset stage_id default if stages change while dialog mounted.
  useEffect(() => {
    if (!form.getValues("stage_id") && initialStage) {
      form.setValue("stage_id", initialStage);
    }
  }, [initialStage, form]);

  /**
   * Os campos do lead que não dependem de contato resolvido, mais o telefone já
   * normalizado (quem chama decide o que fazer com ele). `null` = validação
   * falhou e já marcou o erro no campo certo — quem chama só precisa parar.
   */
  function montarPayload(
    values: FormShape,
  ): { payload: Record<string, unknown>; phoneE164: string | null } | null {
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: "Valor inválido" });
        return null;
      }
    }

    let phoneE164: string | null = null;
    if (values.phone.trim()) {
      phoneE164 = normalizePhoneBR(values.phone);
      if (!phoneE164) {
        form.setError("phone", { message: "Telefone inválido" });
        return null;
      }
    }

    const payload: Record<string, unknown> = {
      pipeline_id: pipelineId,
      stage_id: values.stage_id,
      title: values.title.trim(),
      currency: "BRL",
      source: values.source,
      tags,
    };
    if (values.description.trim()) payload.description = values.description.trim();
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;
    if (values.owner_user_id !== NO_OWNER) payload.owner_user_id = values.owner_user_id;
    if (values.produtoInteresse.trim()) {
      payload.custom_fields = { produto_interesse: values.produtoInteresse.trim() };
    }

    return { payload, phoneE164 };
  }

  async function onSubmit(values: FormShape) {
    // Submissão nova (não "Criar mesmo assim"/"Usar este contato") sempre
    // refaz a checagem do zero — um aviso de uma tentativa anterior não pode
    // continuar valendo pra dados que a pessoa já mudou.
    setDuplicidade(null);
    setPayloadPendente(null);
    setContatoExistente(null);
    setValoresPendentes(null);

    const montado = montarPayload(values);
    if (!montado) return;
    const { payload, phoneE164 } = montado;

    // Cria (ou reaproveita, via contactId de prop) o contato ANTES do lead —
    // o lead referencia contact_id, não guarda telefone/e-mail direto.
    let resolvedContactId = contactId ?? null;
    if (!resolvedContactId && (phoneE164 || values.email.trim())) {
      try {
        const res = await createContact.mutateAsync({
          name: values.title.trim() || undefined,
          email: values.email.trim() || undefined,
          phone_number: phoneE164 ?? undefined,
          source: values.source,
        });
        // `data` é `{ contact, action }`, não o Contact direto — ver o
        // comentário em `useCreateContact.ts`. `res.data.id` sempre foi
        // `undefined` aqui, e o lead nascia sem telefone vinculado.
        resolvedContactId = res.data.contact.id;
      } catch (err) {
        // Achado ao vivo: telefone/e-mail já é de OUTRO contato (comum numa
        // base que veio do WhatsApp — a pessoa já escreveu antes). Sem este
        // desvio a criação simplesmente parava aqui, com o toast dizendo "já
        // existe" e nenhum jeito de a pessoa continuar — nem pra ligar o lead
        // ao contato que o próprio servidor já identificou.
        if (
          err instanceof ApiError &&
          (err.code === "contact_duplicate_phone" || err.code === "contact_duplicate_email")
        ) {
          const detalhes = err.details as
            | { existing_contact_id?: string; existing_contact_name?: string | null }
            | undefined;
          if (detalhes?.existing_contact_id) {
            setContatoExistente({
              id: detalhes.existing_contact_id,
              nome: detalhes.existing_contact_name ?? null,
            });
            setValoresPendentes(values);
          }
        }
        // erro já mostrado pelo toast do hook; aborta sem criar lead órfão de intenção
        return;
      }
    }

    if (resolvedContactId) payload.contact_id = resolvedContactId;

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }

    await enviar(parsed.data as CreateLeadInput);
  }

  function resetForm() {
    form.reset({
      title: "",
      description: "",
      stage_id: initialStage,
      valueReais: "",
      tagsRaw: "",
      expected_close_date: "",
      phone: "",
      email: "",
      owner_user_id: NO_OWNER,
      produtoInteresse: "",
      source: "manual",
    });
    setDuplicidade(null);
    setPayloadPendente(null);
    setContatoExistente(null);
    setValoresPendentes(null);
  }

  async function enviar(input: CreateLeadInput) {
    try {
      await create.mutateAsync(input);
      toast.success("Lead criado");
      resetForm();
      onOpenChange(false);
    } catch (err) {
      // Achado ao vivo: sem este desvio, o mesmo cliente ganhava um SEGUNDO
      // lead aberto no mesmo pipeline, um dos dois sem valor escondendo o
      // outro que fechou de verdade. O servidor já recusa com
      // `duplicate_open_lead`; aqui a tela vira a recusa numa pergunta.
      if (err instanceof ApiError && err.code === "duplicate_open_lead") {
        const detalhes = err.details as
          | { existing_lead_id?: string; existing_lead_title?: string }
          | undefined;
        setDuplicidade({
          leadId: detalhes?.existing_lead_id ?? "",
          titulo: detalhes?.existing_lead_title ?? "outro lead",
        });
        setPayloadPendente(input);
        return;
      }
      // outros erros: toast já mostrado pelo hook (onError: showApiError)
    }
  }

  function criarMesmoAssim() {
    if (!payloadPendente) return;
    void enviar({ ...payloadPendente, confirm_duplicate: true });
  }

  async function usarContatoExistente() {
    if (!contatoExistente || !valoresPendentes) return;
    const montado = montarPayload(valoresPendentes);
    if (!montado) return;
    montado.payload.contact_id = contatoExistente.id;

    const parsed = createLeadSchema.safeParse(montado.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }
    setContatoExistente(null);
    setValoresPendentes(null);
    await enviar(parsed.data as CreateLeadInput);
  }

  const stageId = form.watch("stage_id");
  const ownerUserId = form.watch("owner_user_id");
  const source = form.watch("source");
  const produtoInteresse = form.watch("produtoInteresse");
  const busy = create.isPending || createContact.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Novo Lead</DialogTitle>
          <DialogDescription>
            Crie um lead manualmente neste pipeline.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Título</Label>
            <Input
              id="title"
              placeholder="Ex: Pedido Maria — combo presente"
              {...form.register("title", { required: true, minLength: 2 })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="phone">Telefone</Label>
              <Input
                id="phone"
                inputMode="tel"
                placeholder="(11) 98765-4321"
                {...form.register("phone")}
              />
              {form.formState.errors.phone && (
                <p className="text-xs text-error-fg">{form.formState.errors.phone.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">E-mail</Label>
              <Input
                id="email"
                type="email"
                placeholder="cliente@exemplo.com"
                {...form.register("email")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Descrição</Label>
            <Textarea
              id="description"
              rows={3}
              placeholder="Contexto, observações, links…"
              {...form.register("description")}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Etapa</Label>
              <Select
                value={stageId}
                onValueChange={(v) => form.setValue("stage_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a etapa" />
                </SelectTrigger>
                <SelectContent>
                  {stages
                    .filter((s) => !s.is_archived)
                    .map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Atendente</Label>
              <Select
                value={ownerUserId}
                onValueChange={(v) => form.setValue("owner_user_id", v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Sem atendente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_OWNER}>Sem atendente</SelectItem>
                  {(members ?? []).map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name ?? "Sem nome"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="produtoInteresse">Produto de interesse</Label>
              {serviceOptions.length > 0 ? (
                <Select
                  value={produtoInteresse}
                  onValueChange={(v) => form.setValue("produtoInteresse", v)}
                >
                  <SelectTrigger id="produtoInteresse">
                    <SelectValue placeholder="Selecione o serviço" />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceOptions.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="produtoInteresse"
                  placeholder="Ex: Combo Presente"
                  {...form.register("produtoInteresse")}
                />
              )}
            </div>
            <div className="space-y-2">
              <Label>Origem do lead</Label>
              <Select value={source} onValueChange={(v) => form.setValue("source", v)}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione a origem" />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_SOURCES.map((s) => (
                    <SelectItem key={s.value} value={s.value}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="valueReais">Valor (R$)</Label>
              <Input
                id="valueReais"
                inputMode="decimal"
                placeholder="0,00"
                {...form.register("valueReais")}
              />
              <EcoDoValor control={form.control} />
              {form.formState.errors.valueReais && (
                <p className="text-xs text-error-fg">
                  {form.formState.errors.valueReais.message}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="expected_close_date">Fechamento previsto</Label>
              <Input
                id="expected_close_date"
                type="date"
                {...form.register("expected_close_date")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tagsRaw">Tags (separadas por vírgula)</Label>
            <Input
              id="tagsRaw"
              placeholder="vip, recompra"
              {...form.register("tagsRaw")}
            />
          </div>

          {contatoExistente ? (
            <div
              data-testid="aviso-contato-existente"
              className="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-xs dark:bg-amber-900/10"
            >
              Este telefone ou e-mail já é de um contato existente
              {contatoExistente.nome ? (
                <>
                  {" "}
                  — <strong>{contatoExistente.nome}</strong>
                </>
              ) : null}
              . Quer criar o lead pra esse contato, em vez de um contato novo?
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={usarContatoExistente}
                  disabled={busy}
                >
                  Usar este contato
                </Button>
              </div>
            </div>
          ) : null}

          {duplicidade ? (
            <div
              data-testid="aviso-lead-duplicado"
              className="rounded-md border border-amber-500/40 bg-amber-50/60 p-3 text-xs dark:bg-amber-900/10"
            >
              Este contato já tem um lead aberto neste pipeline:{" "}
              <strong>&ldquo;{duplicidade.titulo}&rdquo;</strong>. Criar outro deixa dois
              negócios abertos pro mesmo cliente ao mesmo tempo — confira se não é o
              mesmo antes de continuar.
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={criarMesmoAssim}
                  disabled={busy}
                >
                  Criar mesmo assim
                </Button>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onOpenChange(false);
                setDuplicidade(null);
                setPayloadPendente(null);
                setContatoExistente(null);
                setValoresPendentes(null);
              }}
              disabled={busy}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !stageId}>
              {busy ? "Criando…" : "Criar lead"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
