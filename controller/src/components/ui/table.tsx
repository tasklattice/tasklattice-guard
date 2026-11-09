import * as React from "react";
import {
  Table as CarbonTable,
  TableHead as CarbonTableHead,
  TableBody as CarbonTableBody,
  TableRow as CarbonTableRow,
  TableHeader as CarbonTableHeader,
  TableCell as CarbonTableCell,
} from "@carbon/react";

import { cn } from "@/lib/utils";

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <CarbonTable
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({
  className,
  ...props
}: React.ComponentProps<typeof CarbonTableHead>) {
  return (
    <CarbonTableHead
      data-slot="table-header"
      className={cn("bg-muted [&_tr]:border-b", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <CarbonTableBody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className,
      )}
      {...props}
    />
  );
}

function TableRow({
  className,
  "aria-label": label,
  ...props
}: React.ComponentProps<"tr">) {
  const rowRef = React.useRef<HTMLTableRowElement>(null);
  React.useLayoutEffect(() => {
    if (label) rowRef.current?.setAttribute("aria-label", label);
    else rowRef.current?.removeAttribute("aria-label");
  }, [label]);
  return (
    <CarbonTableRow
      ref={rowRef}
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted has-aria-expanded:bg-muted data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({
  className,
  ...props
}: React.ComponentProps<typeof CarbonTableHeader>) {
  return (
    <CarbonTableHeader
      data-slot="table-head"
      className={cn(
        // Carbon resets its inner label to start; keep the column's alignment.
        "h-12 px-4 text-left align-middle font-semibold whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0 [&_.cds--table-header-label]:[text-align:inherit]",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <CarbonTableCell
      data-slot="table-cell"
      className={cn(
        "h-12 px-4 py-3 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableCaption,
};
