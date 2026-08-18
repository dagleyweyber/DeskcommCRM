"use client";
import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
  const initialStage = useMemo(() => defaultStageId(stages), [stages]);

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

  async function onSubmit(values: FormShape) {
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
        return;
      }
    }

    let phoneE164: string | null = null;
    if (values.phone.trim()) {
      phoneE164 = normalizePhoneBR(values.phone);
      if (!phoneE164) {
        form.setError("phone", { message: "Telefone inválido" });
        return;
      }
    }

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
        resolvedContactId = res.data.id;
      } catch {
        // erro já mostrado pelo toast do hook; aborta sem criar lead órfão de intenção
        return;
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
    if (resolvedContactId) payload.contact_id = resolvedContactId;
    if (values.description.trim()) payload.description = values.description.trim();
    if (valueCents !== null) payload.value_cents = valueCents;
    if (values.expected_close_date) payload.expected_close_date = values.expected_close_date;
    if (values.owner_user_id !== NO_OWNER) payload.owner_user_id = values.owner_user_id;
    if (values.produtoInteresse.trim()) {
      payload.custom_fields = { produto_interesse: values.produtoInteresse.trim() };
    }

    const parsed = createLeadSchema.safeParse(payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }

    try {
      await create.mutateAsync(parsed.data as CreateLeadInput);
      toast.success("Lead criado");
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
      onOpenChange(false);
    } catch {
      // toast already shown
    }
  }

  const stageId = form.watch("stage_id");
  const ownerUserId = form.watch("owner_user_id");
  const source = form.watch("source");
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
              <Input
                id="produtoInteresse"
                placeholder="Ex: Combo Presente"
                {...form.register("produtoInteresse")}
              />
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

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
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
