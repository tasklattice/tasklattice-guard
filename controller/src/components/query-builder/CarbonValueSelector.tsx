import * as React from "react";
import { useMemo } from "react";
import type { OptionList, VersatileSelectorProps } from "react-querybuilder";
import { isOptionGroupArray, useValueSelector } from "react-querybuilder";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type CarbonValueSelectorProps = VersatileSelectorProps;

export const CarbonValueSelector = ({
  className,
  handleOnChange,
  options,
  value,
  title,
  disabled,
  multiple: _multiple,
  listsAsArrays: _listsAsArrays,
  testID,
  field: _field,
  fieldData: _fieldData,
  rule: _rule,
  ruleGroup: _ruleGroup,
  rules: _rules,
  path: _path,
  level: _level,
  context: _context,
  validation: _validation,
  schema: _schema,
  ...otherProps
}: CarbonValueSelectorProps): React.JSX.Element => {
  const { onChange, val } = useValueSelector({ handleOnChange, value });
  const optionContent = useMemo(() => {
    const items = options as OptionList;
    if (isOptionGroupArray(items)) {
      return items.map((group) => (
        <SelectGroup key={group.label}>
          <SelectLabel>{group.label}</SelectLabel>
          {group.options.map((option) => <SelectItem key={option.name} value={option.name}>{option.label}</SelectItem>)}
        </SelectGroup>
      ));
    }
    return items.map((option) => <SelectItem key={option.name} value={option.name}>{option.label}</SelectItem>);
  }, [options]);

  return (
    <Select {...otherProps} value={val as string} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger data-testid={testID} className={className} title={title}><SelectValue /></SelectTrigger>
      <SelectContent>{optionContent}</SelectContent>
    </Select>
  );
};
