import { useTranslation } from "react-i18next";

import { EmptyState, PageHeader } from "@/components/product-shell";

/** Better Auth's global admin operations are disabled until user management is tenant-scoped. */
export function UsersUnavailablePage() {
  const { t } = useTranslation();
  return <section className="py-6 sm:py-8">
    <PageHeader title={t("users.title")} description={t("users.tenantUnavailableDescription")} />
    <div className="mt-6"><EmptyState title={t("users.tenantUnavailableTitle")} description={t("users.tenantUnavailableDescription")} /></div>
  </section>;
}
