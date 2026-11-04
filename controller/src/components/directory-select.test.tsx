import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { DirectorySelect, type DirectorySelection } from "./directory-select";

afterEach(cleanup);

it("preserves selected projects through server search and loads the next result page", async () => {
  await i18n.changeLanguage("en");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const load = vi.fn(async ({ q, cursor }: { q?: string; cursor?: string }) => {
    if (q === "sales") return { items: [{ id: "sales", name: "sales" }], nextCursor: null };
    if (cursor) return { items: [{ id: "sales", name: "sales" }], nextCursor: null };
    return { items: [{ id: "support", name: "support" }], nextCursor: "support" };
  });
  function Form() {
    const [value, onChange] = useState<DirectorySelection[]>([{ id: "support", name: "support" }]);
    return <DirectorySelect scope="test-projects" label="Projects" value={value} onChange={onChange} load={load} />;
  }
  render(<QueryClientProvider client={client}><Form /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await waitFor(() => expect(load).toHaveBeenCalledWith({ q: "", cursor: "support", limit: 25 }, expect.any(AbortSignal)));
  const input = screen.getByRole("combobox", { name: "Projects" });
  fireEvent.change(input, { target: { value: "sales" } });
  await waitFor(() => expect(load).toHaveBeenLastCalledWith({ q: "sales", cursor: undefined, limit: 25 }, expect.any(AbortSignal)));
  expect(screen.getByRole("button", { name: "Remove support", exact: true })).toBeTruthy();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter", keyCode: 13 });
  await screen.findByRole("button", { name: "Remove sales", exact: true });
  expect(screen.getByRole("button", { name: "Remove support", exact: true })).toBeTruthy();
  cleanup();
  client.clear();
});
