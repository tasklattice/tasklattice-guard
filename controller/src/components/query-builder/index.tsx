import type { ControlElementsProp, FullField, QueryBuilderContextProvider } from "react-querybuilder";
import { getCompatContextProvider } from "react-querybuilder";

import { CarbonActionElement } from "./CarbonActionElement";
import { CarbonNotToggle } from "./CarbonNotToggle";
import { CarbonShiftActions } from "./CarbonShiftActions";
import { CarbonValueEditor } from "./CarbonValueEditor";
import { CarbonValueSelector } from "./CarbonValueSelector";

export * from "./CarbonActionElement";
export * from "./CarbonNotToggle";
export * from "./CarbonShiftActions";
export * from "./CarbonValueEditor";
export * from "./CarbonValueSelector";

export const carbonControlElements: ControlElementsProp<FullField, string> = {
  actionElement: CarbonActionElement,
  notToggle: CarbonNotToggle,
  shiftActions: CarbonShiftActions,
  valueEditor: CarbonValueEditor,
  valueSelector: CarbonValueSelector,
};

export const QueryBuilderCarbon: QueryBuilderContextProvider = getCompatContextProvider({
  controlElements: carbonControlElements,
});
