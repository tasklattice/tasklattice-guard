import {
  createContext,
  useContext,
  useState,
  Children,
  cloneElement,
  isValidElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  Tabs as CarbonTabs,
  TabsVertical,
  TabList,
  TabListVertical,
  Tab,
  TabPanels,
  TabPanel,
} from "@carbon/react";
import { findSlots } from "@/components/carbon/composition";
import { cn } from "@/lib/utils";
const Context = createContext({
  value: "",
  orientation: "horizontal",
  activation: "automatic",
});
export function Tabs({
  children,
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  activationMode = "automatic",
  className,
  ...props
}: ComponentProps<"div"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  orientation?: "horizontal" | "vertical";
  activationMode?: "automatic" | "manual";
}) {
  const lists = findSlots(children, TabsList);
  const values = lists.flatMap((list) =>
    Children.toArray(list.props.children as ReactNode)
      .filter(isValidElement)
      .map((child) => String((child.props as { value: string }).value)),
  );
  const panels = findSlots(children, TabsContent);
  const [local, setLocal] = useState(defaultValue ?? values[0]);
  const selected = value ?? local;
  let placed = false;
  const transform = (nodes: ReactNode): ReactNode =>
    Children.map(nodes, (child) => {
      if (!isValidElement<{ children?: ReactNode }>(child)) return child;
      if (child.type === TabsContent) {
        if (placed) return null;
        placed = true;
        return (
          <TabPanels>
            {values.map((v) => {
              const panel = panels.find((p) => p.props.value === v);
              return <TabsContent key={v} {...panel?.props} value={v} />;
            })}
          </TabPanels>
        );
      }
      if (
        child.type === Tabs ||
        child.type === TabsList ||
        child.type === TabsTrigger
      )
        return child;
      return child.props.children
        ? cloneElement(child, {}, transform(child.props.children))
        : child;
    });
  const Root = orientation === "vertical" ? TabsVertical : CarbonTabs;
  return (
    <div
      {...props}
      data-slot="tabs"
      className={cn("guard-tabs min-w-0", className)}
    >
      <Context.Provider
        value={{ value: selected, orientation, activation: activationMode }}
      >
        <Root
          selectedIndex={Math.max(0, values.indexOf(selected))}
          onChange={({ selectedIndex }) => {
            const next = values[selectedIndex];
            if (next !== undefined) {
              setLocal(next);
              onValueChange?.(next);
            }
          }}
        >
          {transform(children)}
        </Root>
      </Context.Provider>
    </div>
  );
}
export function TabsList({ className, children, ...props }: ComponentProps<"div">) {
  const { orientation, activation } = useContext(Context);
  const List = orientation === "vertical" ? TabListVertical : TabList;
  return (
    <List
      {...props}
      data-slot="tabs-list"
      className={className}
      activation={activation as "automatic" | "manual"}
    >
      {Children.toArray(children)}
    </List>
  );
}
export function TabsTrigger({
  value,
  className,
  asChild,
  children,
  ...props
}: ComponentProps<typeof Tab> & { value: string; asChild?: boolean }) {
  const context = useContext(Context);
  const child =
    asChild && isValidElement<Record<string, unknown>>(children)
      ? children
      : null;
  return (
    <Tab
      {...props}
      {...(child?.props ?? {})}
      as={child ? (child.type as ComponentProps<typeof Tab>["as"]) : undefined}
      className={className}
      data-slot="tabs-trigger"
      data-state={context.value === value ? "active" : "inactive"}
    >
      {child ? (child.props.children as ReactNode) : children}
    </Tab>
  );
}
export function TabsContent({
  value,
  forceMount,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { value: string; forceMount?: boolean }) {
  const context = useContext(Context);
  return (
    <TabPanel
      {...props}
      data-slot="tabs-content"
      className={cn("min-w-0", className)}
    >
      {context.value === value || forceMount ? children : null}
    </TabPanel>
  );
}
