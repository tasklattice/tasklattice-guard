import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

/** Resource ownership comes from the server, never from the selected tenant. */
export function TenantResourceBadge({ ownerTenantId, activeTenantId, className }: { ownerTenantId?: string | null; activeTenantId?: string | null; className?: string }) {
  const { t } = useTranslation();
  if (!ownerTenantId) return null;
  return <Badge variant="outline" className={className}>{t(ownerTenantId === activeTenantId ? "sharing.ownedBy" : "sharing.sharedFrom", { tenant: ownerTenantId })}</Badge>;
}
