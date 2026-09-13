import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PathTestSelect({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value}
      onValueChange={onChange}
      disabled={disabled || !options.length}
    >
      <SelectTrigger
        aria-label={label}
        className="h-11 w-full min-w-0 bg-background shadow-none lg:w-auto lg:min-w-32 lg:max-w-56"
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
