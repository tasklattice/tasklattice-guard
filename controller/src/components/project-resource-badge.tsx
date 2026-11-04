import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";

/** Resource ownership comes from the server, never from the selected project. */
export function ProjectResourceBadge({ ownerProjectId, activeProjectId, className }: { ownerProjectId?: string | null; activeProjectId?: string | null; className?: string }) {
  const { t } = useTranslation();
  if (!ownerProjectId || ownerProjectId === activeProjectId) return null;
  return <Badge variant="outline" className={className}>{t("sharing.sharedFrom", { project: ownerProjectId })}</Badge>;
}
