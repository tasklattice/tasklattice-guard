import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {ReactNode} from 'react';
import * as api from '@/lib/projects-api';
import {ProjectsPage} from './projects';
import i18n from '@/i18n';
vi.mock('@tanstack/react-router',()=>({Link:({children,to}: {children:ReactNode;to:string})=><a href={to}>{children}</a>}));
vi.mock('@/lib/projects-api',()=>({listProjects:vi.fn(),listProjectMembers:vi.fn(),listMemberCandidates:vi.fn(),createProject:vi.fn(),setProjectMember:vi.fn(),getProjectRunner:vi.fn()}));
let client:QueryClient;
beforeEach(async()=>{
 await i18n.changeLanguage('en');client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 vi.mocked(api.listProjects).mockResolvedValue({items:[{id:'support',name:'support',groupId:'default',groupName:'Default',poolId:'default',poolName:'runner-default',memberCount:12}],nextCursor:'support'});
 vi.mocked(api.listProjectMembers).mockResolvedValue({items:[{userId:'sso',username:'sso',email:'sso@test',source:'sso',access:'read',roles:[]}],nextCursor:null});
 vi.mocked(api.listMemberCandidates).mockResolvedValue({items:[{id:'local',username:'local'}],nextCursor:null});
 vi.mocked(api.createProject).mockResolvedValue({id:'new-project',name:'new-project',groupId:'default'});
});
afterEach(()=>{cleanup();client.clear();vi.clearAllMocks();});
const mount=()=>render(<QueryClientProvider client={client}><ProjectsPage/></QueryClientProvider>);
it('loads members and local candidates in separate on-demand queries',async()=>{
 mount();await screen.findByText('runner-default');expect(api.listProjectMembers).not.toHaveBeenCalled();expect(api.listMemberCandidates).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Manage local users · support'}));await screen.findByText('sso');expect(screen.queryByRole('button',{name:'Remove access'})).toBeNull();
 fireEvent.click(screen.getByRole('combobox',{name:'Search and select a local user'}));await screen.findByRole('option',{name:'local'});expect(api.listMemberCandidates).toHaveBeenCalledWith('support',{q:'',cursor:undefined,limit:25},expect.any(AbortSignal));
});
it('creates one canonical Project identity without a separate ID override',async()=>{
 mount();await screen.findByText('runner-default');fireEvent.click(screen.getByRole('button',{name:'Create project'}));const sheet=screen.getByRole('dialog');
 expect(within(sheet).queryByLabelText('Project ID (optional)')).toBeNull();
 fireEvent.change(within(sheet).getByLabelText('Project name'),{target:{value:'New Project'}});
 expect(within(sheet).getByText('runner-default')).toBeTruthy();
 expect(within(sheet).getByText(/http.*new-project/)).toBeTruthy();
 expect(within(sheet).queryByText('runner-new-project-0')).toBeNull();
 fireEvent.click(within(sheet).getByRole('button',{name:'Create project'}));await waitFor(()=>expect(api.createProject).toHaveBeenCalledWith({name:'new-project'}));
});

it('opens only the chosen Runner detail and keeps the project list as summaries',async()=>{
 vi.mocked(api.getProjectRunner).mockResolvedValue({projectId:'support',projectName:'support',groupId:'default',pool:null,modelScope:{projectCount:1,poolCount:0}});
 mount();await screen.findByText('runner-default');expect(api.getProjectRunner).not.toHaveBeenCalled();
 expect(screen.queryByRole('link',{name:'runner-default'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Configure Runner · support'}));
 await screen.findByRole('button',{name:'Allocate Runner'});
 expect(api.getProjectRunner).toHaveBeenCalledWith('support',expect.any(AbortSignal));
 expect(api.listProjectMembers).not.toHaveBeenCalled();
});
