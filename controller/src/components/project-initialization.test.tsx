import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { initializationEmail } from "@/projects-i18n";
import { ProjectInitializationGate } from "./project-initialization";
const api = vi.hoisted(() => ({ get: vi.fn(), refresh: vi.fn(), clipboard: vi.fn() }));
vi.mock("@/lib/projects-api", () => ({ getProjectAccess: api.get, refreshProjectAccess: api.refresh }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ user: {id:"human-1", display_name:"Alice", username:"alice", email:"alice@users.guard.invalid", role:"user", project_id:null} }) }));
const missing = {state:"project_missing" as const, projectId:null, missingProjects:[{projectId:"support",departmentId:"operations"}]};
const mount = () => render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><ProjectInitializationGate><div>Project workspace</div></ProjectInitializationGate></QueryClientProvider>);
beforeEach(async () => {
  await i18n.changeLanguage("en"); api.get.mockReset().mockResolvedValue(missing); api.refresh.mockReset().mockResolvedValue(missing); api.clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:api.clipboard}});
});
afterEach(cleanup);
describe("Project initialization", () => {
  it("keeps the workspace closed and only copies an email draft for the human to send", async () => {
    mount(); await screen.findByRole("heading",{name:"Project is not initialized"});
    expect(screen.queryByText("Project workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"Copy email template"}));
    await screen.findByRole("button",{name:"Copied"});
    const text=api.clipboard.mock.calls[0]![0];
    expect(text).toContain("support (department: operations)"); expect(text).toContain("Account: alice");
    expect(text).not.toContain("users.guard.invalid"); expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
    fireEvent.click(screen.getByText("Preview email template"));
    expect((screen.getByRole("textbox",{name:"Email template"}) as HTMLTextAreaElement).value).toBe(text);
    fireEvent.click(screen.getByRole("button",{name:"Check again"}));
    await screen.findByText(/Initialization is still pending/); expect(api.refresh).toHaveBeenCalledOnce();
  });
  it("offers manual copy if the clipboard is unavailable and preserves retry errors", async () => {
    api.clipboard.mockRejectedValue(new Error("denied")); api.refresh.mockRejectedValue(new Error("Temporarily unavailable"));
    mount(); fireEvent.click(await screen.findByRole("button",{name:"Copy email template"}));
    await screen.findByText(/Could not access the clipboard/);
    fireEvent.click(screen.getByRole("button",{name:"Check again"}));
    await screen.findByText(/Temporarily unavailable/);
    expect(screen.getByRole("button",{name:"Check again"})).toBeTruthy();
  });
  it("renders business content only after the server confirms initialization", async () => {
    api.get.mockResolvedValue({...missing,state:"ready",projectId:"support"}); mount();
    await waitFor(()=>expect(screen.getByText("Project workspace")).toBeTruthy());
    expect(screen.queryByRole("button",{name:"Copy email template"})).toBeNull();
  });
  it("explains the missing Runner setup in the generated text", () => {
    const email=initializationEmail({chinese:false,name:"Alice",account:"alice@example.test",userId:"human-1",origin:"https://guard.example.test",status:{state:"runner_uninitialized",projectId:"support",missingProjects:[]}});
    expect(email.body).toContain("Runner environment is not initialized"); expect(email.body).toContain("Project: support");
  });
});
