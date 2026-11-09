import { useId } from "react";
import { Button, DismissibleTag, Dropdown, MultiSelect, Toggletip, ToggletipButton, ToggletipContent } from "@carbon/react";
import { Filter, Information } from "@carbon/react/icons";
import { useTranslation } from "react-i18next";
import { eventSeverities, selectedSeverities, type EventSeverity } from "../../shared/security-severity";
import type { MetricWindow, RuntimeFindingSummary } from "@/lib/api-types";
import "./event-filter-toolbar.scss";

const windows: MetricWindow[] = ["1h", "24h", "7d", "15d", "30d"];

/** Shared Carbon filter surface. Counts describe the time window, not the loaded page. */
export function EventFilterToolbar({ window, onWindowChange, severities, onSeveritiesChange, counts }: {
  window: MetricWindow;
  onWindowChange: (window: MetricWindow) => void;
  severities: EventSeverity[];
  onSeveritiesChange: (levels: EventSeverity[]) => void;
  counts?: RuntimeFindingSummary;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const translateMenu = (key: string) => t(key === "close.menu" ? "securityEvents.closeFilter" : key === "open.menu" ? "securityEvents.openFilter" : "securityEvents.clearFilters");
  return <div className="guard-carbon">
    <div className="event-filter-toolbar" role="group" aria-label={t("securityEvents.filters")}>
      <Dropdown<MetricWindow> id={`${id}-time`} className="event-filter-time" size="md" hideLabel titleText={t("dashboard.timeRangeFilter")} label={t("dashboard.timeRangeFilter")} items={windows} selectedItem={window}
        itemToString={value => value ? t(`dashboard.windows.${value}`) : ""} translateWithId={translateMenu}
        onChange={({ selectedItem }) => { if (selectedItem) onWindowChange(selectedItem); }} />
      <MultiSelect<EventSeverity> id={`${id}-risk`} className="event-filter-risk" size="md" hideLabel titleText={t("securityEvents.riskLevel")} label={<span className="event-filter-label"><Filter size={16} />{t("securityEvents.filters")}</span>}
        items={[...eventSeverities]} selectedItems={severities} selectionFeedback="fixed" sortItems={items => [...items]} locale={i18n.language}
        itemToString={level => t(`routerDetail.severity.${level}`)}
        itemToElement={level => <span className="event-filter-option"><span>{t(`routerDetail.severity.${level}`)}</span><span className="event-filter-count">{counts ? (counts[level] ?? 0).toLocaleString(i18n.language) : "—"}</span></span>}
        translateWithId={translateMenu} clearSelectionText={t("securityEvents.clearFilters")} clearAnnouncement={t("securityEvents.filtersCleared")} clearSelectionDescription={t("securityEvents.selectedLevels")}
        onChange={({ selectedItems }) => onSeveritiesChange(selectedSeverities(selectedItems ?? []))} />
      <div className="event-filter-help">
        <Toggletip align="bottom-right">
          <ToggletipButton label={t("securityEvents.levelGuide")}><Information size={16} /><span>{t("securityEvents.levelGuide")}</span></ToggletipButton>
          <ToggletipContent><p>{t("securityEvents.boundaryHint")}</p></ToggletipContent>
        </Toggletip>
      </div>
    </div>
    {severities.length ? <div className="event-filter-applied" aria-label={t("securityEvents.appliedFilters")}>
      <DismissibleTag type="cool-gray" text={`${t("securityEvents.riskLevel")}: ${severities.map(level => t(`routerDetail.severity.${level}`)).join(i18n.language.startsWith("zh") ? "、" : ", ")}`}
        title={t("securityEvents.removeRiskFilter")} dismissTooltipLabel={t("securityEvents.removeRiskFilter")} onClose={() => onSeveritiesChange([])} />
      <Button kind="ghost" size="sm" onClick={() => onSeveritiesChange([])}>{t("securityEvents.clearFilters")}</Button>
    </div> : null}
  </div>;
}
