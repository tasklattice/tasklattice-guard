import { createRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectRunnerConfiguration } from "./project-runner-configuration";
import * as api from "@/lib/projects-api";
import { updateRunnerPoolConnectivity } from "@/lib/project-groups-api";
import type { ProjectRunnerView } from "../../shared/project-groups";
import i18n from "@/i18n";
vi.mock("@/lib/projects-api",()=>({getProjectRunner:vi.fn(),configureProjectRunner:vi.fn()}));
vi.mock("@/lib/project-groups-api",()=>({updateRunnerPoolConnectivity:vi.fn()}));
vi.mock("@tanstack/react-router",()=>({Link:({children,to}:{children:ReactNode;to:string})=><a href={to}>{children}</a>}));
vi.mock("@/components/group-model-configuration",()=>({GroupModelConfigurationSheet:({scopeDescription,onClose}:{scopeDescription:string;onClose:()=>void})=><section role="dialog"><p>{scopeDescription}</p><button onClick={onClose}>Back</button></section>}));
let client: QueryClient;
let detail: ProjectRunnerView;
beforeEach(async()=>{
 await i18n.changeLanguage("en");
 client = new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 detail={projectId:"test1",projectName:"test1",groupId:"default",pool:{id:"default",name:"runner-default",projectId:null,groupId:"default",isDefault:true,runtimeUrl:null,publicUrl:null,desiredReplicas:1,safeRpsPerRunner:50,maxConcurrencyPerRunner:64,connectedCount:1},modelScope:{projectCount:2,poolCount:1}};
 vi.mocked(api.getProjectRunner).mockImplementation(async()=>detail);
 vi.mocked(api.configureProjectRunner).mockImplementation(async()=>detail);
 vi.mocked(updateRunnerPoolConnectivity).mockResolvedValue(detail.pool!);
});
afterEach(()=>{cleanup();client.clear();vi.resetAllMocks();});
function mount(){return render(<QueryClientProvider client={client}><ProjectRunnerConfiguration project={{id:"test1",name:"test1",groupId:"default"}} onClose={vi.fn()} returnFocusRef={createRef()}/></QueryClientProvider>);}
it("shows shared impact and opens model access in a single dialog",async()=>{
 mount();await screen.findByText("runner-default");
 expect(screen.getByText(/changes affect all 2 projects/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Configure model access"}));
 expect(screen.getAllByRole("dialog")).toHaveLength(1);
 expect(screen.getByText(/changes affect all 2 projects/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Back"}));
 expect(await screen.findByText("runner-default")).toBeTruthy();
});
it("keeps connection changes out of the summary and validates origins before saving",async()=>{
 mount();await screen.findByText("runner-default");
 fireEvent.click(screen.getByRole("button",{name:"Edit connection"}));
 const save=screen.getByRole("button",{name:"Save changes"});
 expect(save.hasAttribute("disabled")).toBe(true);
 fireEvent.change(screen.getByLabelText("Internal Runner URL"),{target:{value:"http://runner/path"}});
 expect(save.hasAttribute("disabled")).toBe(true);
 fireEvent.change(screen.getByLabelText("Internal Runner URL"),{target:{value:"http://runner-default:8091"}});
 fireEvent.click(save);
 await waitFor(()=>expect(updateRunnerPoolConnectivity).toHaveBeenCalledWith("default",{runtimeUrl:"http://runner-default:8091",publicUrl:null}));
 await screen.findByText("Runner configuration saved.");
});
it("registers a dedicated allocation in one request with the reviewed assignment",async()=>{
 detail={...detail,groupId:"test1",pool:null,modelScope:{projectCount:1,poolCount:0}};
 mount();fireEvent.click(await screen.findByRole("button",{name:"Allocate Runner"}));
 fireEvent.click(screen.getByRole("radio",{name:/Dedicated Runner/}));
 expect(screen.getByText(/Deploy the Runner workload separately/)).toBeTruthy();
 expect(screen.getByText("runner-test1-0")).toBeTruthy();
 fireEvent.change(screen.getByLabelText("Internal Runner URL"),{target:{value:"http://runner-test1:8091"}});
 fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Register dedicated Runner"}));
 await waitFor(()=>expect(api.configureProjectRunner).toHaveBeenCalledExactlyOnceWith("test1",{mode:"dedicated",expectedGroupId:"test1",expectedPoolId:null,runtimeUrl:"http://runner-test1:8091",publicUrl:null}));
});
it("requires reviewing the shared policy impact before assigning an unallocated project",async()=>{
 detail={...detail,groupId:"test1",pool:null,modelScope:{projectCount:1,poolCount:0}};
 mount();fireEvent.click(await screen.findByRole("button",{name:"Allocate Runner"}));
 expect(api.configureProjectRunner).not.toHaveBeenCalled();
 expect(screen.getByText(/will use the shared Runner's model policy/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button",{name:"Use default shared Runner"}));
 await waitFor(()=>expect(api.configureProjectRunner).toHaveBeenCalledWith("test1",{mode:"shared",expectedGroupId:"test1",expectedPoolId:null}));
});
it("does not offer actions from a stale cached detail after a failed refresh",async()=>{
 client.setQueryData(["project-runner","test1"],detail);
 vi.mocked(api.getProjectRunner).mockRejectedValue(new Error("Runner detail unavailable"));
 mount();await screen.findByText("Runner detail unavailable");
 expect(screen.queryByRole("button",{name:"Configure model access"})).toBeNull();
 expect(screen.queryByRole("button",{name:"Edit connection"})).toBeNull();
});

it("keeps low-frequency reallocation in a more menu, separate from settings",async()=>{
 mount();await screen.findByText("runner-default");
 expect(screen.queryByText("Switch to a dedicated Runner")).toBeNull();
 fireEvent.click(screen.getByRole("button",{name:"Runner options"}));
 fireEvent.click(await screen.findByText("Switch to a dedicated Runner"));
 expect(screen.getAllByRole("dialog")).toHaveLength(1);
 expect(screen.getByText(/Stop the current allocation/)).toBeTruthy();
});

it("keeps the reviewed allocation version while the query cache refreshes",async()=>{
 detail={...detail,groupId:"test1",pool:null,modelScope:{projectCount:1,poolCount:0}};
 mount();fireEvent.click(await screen.findByRole("button",{name:"Allocate Runner"}));
 await act(async()=>{client.setQueryData(["project-runner","test1"],{...detail,groupId:"changed"});});
 fireEvent.click(screen.getByRole("button",{name:"Use default shared Runner"}));
 await waitFor(()=>expect(api.configureProjectRunner).toHaveBeenCalledWith("test1",{mode:"shared",expectedGroupId:"test1",expectedPoolId:null}));
});
