import * as React from "react";
import type { ShiftActionsProps } from "react-querybuilder";

import { Button } from "@/components/ui/button";

export const CarbonShiftActions = ({
  shiftUp,
  shiftDown,
  shiftUpDisabled,
  shiftDownDisabled,
  disabled,
  className,
  labels,
  titles,
  testID,
}: ShiftActionsProps): React.JSX.Element => (
  <div data-testid={testID} className={className}>
    <Button type="button" variant="ghost" size="sm" disabled={disabled || shiftUpDisabled} onClick={shiftUp} title={titles?.shiftUp}>
      {labels?.shiftUp}
    </Button>
    <Button type="button" variant="ghost" size="sm" disabled={disabled || shiftDownDisabled} onClick={shiftDown} title={titles?.shiftDown}>
      {labels?.shiftDown}
    </Button>
  </div>
);
