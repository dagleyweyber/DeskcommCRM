"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_MEDIA_TYPES, actionConfigSchema, type ActionMediaType } from "@/lib/followup/graph-schema";
import { MODOS_DA_ACAO, opcoes, type ModoDaAcao } from "@/lib/followup/vocabulario";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import { useUploadFollowupMedia } from "@/hooks/followup/useUploadFollowupMedia";

import type { ConfigOf } from "./shared";

const ROTULOS_MEDIA_TYPE: Record<ActionMediaType, string> = {
  audio: "Áudio",
  image: "Imagem",
  video: "Vídeo",
};

const ACCEPT_POR_TIPO: Record<ActionMediaType, string> = {
  audio: "audio/*",
  image: "image/*",
  video: "video/*",
};

/**
 * O seletor de modelo, no lugar dos dois `<Input>` que pediam um UUID colado à
 * mão. Trata os três estados em vez de fingir que a lista sempre chega:
 * carregando, vazia e erro — porque um seletor vazio sem explicação é o mesmo
 * beco sem saída que o campo de UUID era, só que mais bonito.
 */
function SeletorDeModelo({
  id,
  valor,
  onChange,
  permiteVazio,
}: {
  id: string;
  valor: string;
  onChange: (templateId: string) => void;
  permiteVazio: boolean;
}) {
  const { data: modelos, isLoading, isError } = useMessageTemplates();

  if (isLoading) return <p className="text-xs text-text-muted">Carregando seus modelos…</p>;
  if (isError) {
    return <p className="text-xs text-error-fg">Não consegui carregar seus modelos de mensagem. Recarregue a página.</p>;
  }
  if (!modelos?.length) {
    return (
      <p className="text-xs text-text-muted">
        Você ainda não tem modelos de mensagem. Crie um em Ajustes → Modelos e ele aparece aqui.
      </p>
    );
  }

  const SEM_MODELO = "__nenhum__";
  return (
    <Select
      value={valor === "" ? SEM_MODELO : valor}
      onValueChange={(v) => onChange(v === SEM_MODELO ? "" : v)}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="Escolha um modelo" />
      </SelectTrigger>
      <SelectContent>
        {permiteVazio && <SelectItem value={SEM_MODELO}>Nenhum</SelectItem>}
        {modelos.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.title}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Upload do arquivo fixo de um passo `mode: 'media'`. Não manda a URL pro
 * grafo — só o `storage_path` (o composer do Inbox segue a mesma regra: a URL
 * assinada expira em ~9 dias, o caminho no bucket não).
 */
function UploaderDeMidia({
  mediaType,
  storagePath,
  fileName,
  onUploaded,
}: {
  mediaType: ActionMediaType;
  storagePath: string;
  fileName: string | null;
  onUploaded: (r: { storagePath: string; mime: string; fileName: string }) => void;
}) {
  const upload = useUploadFollowupMedia();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [erroTipo, setErroTipo] = useState<string | null>(null);

  const escolherArquivo = () => inputRef.current?.click();

  const aoEscolher = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite escolher o MESMO arquivo de novo depois de um erro
    if (!file) return;
    setErroTipo(null);
    try {
      const res = await upload.mutateAsync({ file });
      // `kind` vem da validação REAL do arquivo (magic bytes/mime), não do que o
      // seletor "Tipo" dizia — um PDF renomeado pra .jpg não vira imagem só
      // porque o usuário escolheu "Imagem" no combo ao lado.
      if (res.kind !== mediaType) {
        setErroTipo(
          `Esse arquivo é ${ROTULOS_MEDIA_TYPE[res.kind as ActionMediaType] ?? res.kind}, não ${ROTULOS_MEDIA_TYPE[mediaType]}. Escolha um arquivo de ${ROTULOS_MEDIA_TYPE[mediaType].toLowerCase()} ou troque o tipo acima.`,
        );
        return;
      }
      onUploaded({ storagePath: res.storage_path, mime: res.media_mime, fileName: file.name });
    } catch {
      // erro já mostrado pelo toast do hook (useUploadFollowupMedia → showApiError)
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_POR_TIPO[mediaType]}
        className="hidden"
        onChange={(e) => void aoEscolher(e)}
      />
      <Button type="button" variant="outline" onClick={escolherArquivo} disabled={upload.isPending}>
        {upload.isPending ? "Enviando…" : storagePath ? "Trocar arquivo" : "Escolher arquivo"}
      </Button>
      {storagePath && !upload.isPending && (
        <p className="text-xs text-text-muted">
          Arquivo pronto{fileName ? `: ${fileName}` : ""}.
        </p>
      )}
      {erroTipo && <p className="text-xs text-error-fg">{erroTipo}</p>}
    </div>
  );
}

export function ActionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"action">;
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const [mode, setMode] = useState(config.mode);
  const [promptHint, setPromptHint] = useState(config.mode === "ai_message" ? config.prompt_hint : "");
  const [fallbackTemplateId, setFallbackTemplateId] = useState(
    config.mode === "ai_message" ? (config.fallback_template_id ?? "") : "",
  );
  const [templateId, setTemplateId] = useState(config.mode === "template" ? config.template_id : "");
  const [mediaType, setMediaType] = useState<ActionMediaType>(
    config.mode === "media" ? config.media_type : "image",
  );
  const [storagePath, setStoragePath] = useState(config.mode === "media" ? config.storage_path : "");
  const [mediaMime, setMediaMime] = useState(config.mode === "media" ? config.media_mime : "");
  // Só pra exibir "arquivo já escolhido" na tela — não é campo do grafo.
  const [fileName, setFileName] = useState<string | null>(null);
  const [caption, setCaption] = useState(config.mode === "media" ? (config.caption ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: ModoDaAcao;
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
    mediaType: ActionMediaType;
    storagePath: string;
    mediaMime: string;
    caption: string;
  }) => {
    const candidate =
      next.mode === "ai_message"
        ? {
            mode: "ai_message" as const,
            prompt_hint: next.promptHint,
            ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
          }
        : next.mode === "template"
          ? { mode: "template" as const, template_id: next.templateId }
          : {
              mode: "media" as const,
              media_type: next.mediaType,
              storage_path: next.storagePath,
              media_mime: next.mediaMime,
              ...(next.caption.trim() ? { caption: next.caption.trim() } : {}),
            };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  const commitState = { mode, promptHint, fallbackTemplateId, templateId, mediaType, storagePath, mediaMime, caption };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="action-mode">Como escrever a mensagem</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as ModoDaAcao;
            setMode(next);
            commit({ ...commitState, mode: next });
          }}
        >
          <SelectTrigger id="action-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {opcoes(MODOS_DA_ACAO).map(({ valor, rotulo }) => (
              <SelectItem key={valor} value={valor}>
                {rotulo}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {mode === "ai_message" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-prompt-hint">Instrução para a IA</Label>
            <Textarea
              id="action-prompt-hint"
              maxLength={1000}
              value={promptHint}
              onChange={(e) => {
                setPromptHint(e.target.value);
                commit({ ...commitState, promptHint: e.target.value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-fallback">Se a IA não conseguir escrever, mandar este modelo</Label>
            <SeletorDeModelo
              id="action-fallback"
              valor={fallbackTemplateId}
              permiteVazio
              onChange={(v) => {
                setFallbackTemplateId(v);
                commit({ ...commitState, fallbackTemplateId: v });
              }}
            />
          </div>
        </>
      )}

      {mode === "template" && (
        <div className="space-y-2">
          <Label htmlFor="action-template-id">Modelo de mensagem</Label>
          <SeletorDeModelo
            id="action-template-id"
            valor={templateId}
            permiteVazio={false}
            onChange={(v) => {
              setTemplateId(v);
              commit({ ...commitState, templateId: v });
            }}
          />
        </div>
      )}

      {mode === "media" && (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-media-type">Tipo de arquivo</Label>
            <Select
              value={mediaType}
              onValueChange={(v) => {
                const next = v as ActionMediaType;
                setMediaType(next);
                // Trocar o tipo invalida o arquivo já escolhido — um áudio não
                // vira imagem só porque o combo mudou.
                setStoragePath("");
                setMediaMime("");
                setFileName(null);
                commit({ ...commitState, mediaType: next, storagePath: "", mediaMime: "" });
              }}
            >
              <SelectTrigger id="action-media-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACTION_MEDIA_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {ROTULOS_MEDIA_TYPE[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Arquivo</Label>
            <UploaderDeMidia
              mediaType={mediaType}
              storagePath={storagePath}
              fileName={fileName}
              onUploaded={(r) => {
                setStoragePath(r.storagePath);
                setMediaMime(r.mime);
                setFileName(r.fileName);
                commit({ ...commitState, storagePath: r.storagePath, mediaMime: r.mime });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-caption">Legenda (opcional)</Label>
            <Input
              id="action-caption"
              maxLength={1024}
              value={caption}
              onChange={(e) => {
                setCaption(e.target.value);
                commit({ ...commitState, caption: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
