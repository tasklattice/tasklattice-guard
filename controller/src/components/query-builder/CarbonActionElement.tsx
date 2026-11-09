import * as React from "react";
import type { ActionProps } from "react-querybuilder";

import { Button } from "@/components/ui/button";

export type CarbonActionProps = ActionProps;

export const CarbonActionElement = ({
  className,
  handleOnClick,
  label,
  title,
  disabled,
  disabledTranslation,
  testID,
  rules: _rules,
  ruleOrGroup: _ruleOrGroup,
  path: _path,
  level: _level,
  context: _context,
  validation: _validation,
  schema: _schema,
  ...otherProps
}: CarbonActionProps): React.JSX.Element => (
  <Button
    {...otherProps}
    data-testid={testID}
    type="button"
    className={className}
    title={disabledTranslation && disabled ? disabledTranslation.title : title}
    disabled={disabled && !disabledTranslation}
    onClick={(event: React.MouseEvent) => handleOnClick(event)}
  >
    {disabledTranslation && disabled ? disabledTranslation.label : label}
  </Button>
);
