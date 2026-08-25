"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Megaphone } from "@/lib/ui/icons";
import {
  useMetaAdsCredentials,
  useDisconnectMetaAds,
  type MetaAdsCredentialsRow,
} from "@/hooks/integrations/useMetaAdsCredentials";
import { ConnectMetaAdsDialog } from "./_components/ConnectMetaAdsDialog";

const STATUS_LABELS: Record<MetaAdsCredentialsRow["status"], string> = {
  connecting: "Conectando…",
  healthy: "Conectado",
  invalid: "Token inválido",
  error: "Erro no último envio",
};

interface Props {
  initialData: MetaAdsCredentialsRow | null;
  canWrite: boolean;
}

export function MetaAdsIntegrationClient({ initialData, canWrite }: Props) {
  const router = useRouter();
  const { data: credentials } = useMetaAdsCredentials({ initialData });
  const disconnect = useDisconnectMetaAds();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleDisconnect = async () => {
    try {
      await disconnect.mutateAsync();
      toast.success("Meta Ads desconectado.");
      setConfirmOpen(false);
      router.refresh();
    } catch {
      // erro já mostrado pelo toast do hook
    }
  };

  if (!credentials) {
    return (
      <Card className="flex flex-col items-start gap-4 p-6">
        <Megaphone size={28} className="text-muted-foreground" />
        <div>
          <h2 className="font-medium">Nenhum Meta Ads conectado</h2>
          <p className="text-sm text-muted-foreground">
            Cole o token de acesso e o Dataset ID (Gerenciador de Eventos do Meta
            Business) pra ativar o envio automático.
          </p>
        </div>
        {canWrite && <Button onClick={() => setDialogOpen(true)}>Conectar Meta Ads</Button>}
        <ConnectMetaAdsDialog open={dialogOpen} onOpenChange={setDialogOpen} />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col items-start gap-4 p-6">
      <div className="flex w-full items-start justify-between gap-4">
        <div>
          <h2 className="font-medium">Dataset {credentials.dataset_id}</h2>
          <p className="text-sm text-muted-foreground">{STATUS_LABELS[credentials.status]}</p>
          {credentials.last_error && (
            <p className="mt-1 text-xs text-destructive">{credentials.last_error}</p>
          )}
        </div>
        {canWrite && (
          <Button variant="outline" onClick={() => setConfirmOpen(true)}>
            Desconectar
          </Button>
        )}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Desconectar o Meta Ads?</AlertDialogTitle>
            <AlertDialogDescription>
              As vendas param de ser enviadas automaticamente pro Conversions API
              até você conectar de novo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnect.isPending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDisconnect} disabled={disconnect.isPending}>
              {disconnect.isPending ? "Desconectando…" : "Desconectar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
