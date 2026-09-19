import DashboardShell from "@/components/DashboardShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useBusinessMembership } from "@/hooks/useBusinessMembership";

export default function AttendantDashboard() {
  const { membership, permissions } = useBusinessMembership();
  return <DashboardShell title="Área do atendente" description="As conversas e módulos autorizados para o seu atendimento."><Card><CardHeader><CardTitle>Olá, {membership?.name || membership?.email}</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">Permissões ativas: {permissions.length ? permissions.join(", ") : "Nenhuma"}</CardContent></Card></DashboardShell>;
}
