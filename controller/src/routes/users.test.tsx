import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as api from '@/lib/identity-api';
import * as projectsApi from '@/lib/projects-api';
import {UsersPage} from './users';
import i18n from '@/i18n';
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'admin',role:'admin'}})}));
vi.mock('@/lib/identity-api',()=>({getUsers:vi.fn(),getUser:vi.fn(),createUser:vi.fn(),updateUser:vi.fn(),getPasswordPolicy:vi.fn()}));
vi.mock('@/lib/projects-api',()=>({listProjects:vi.fn(),setProjectMember:vi.fn()}));
vi.mock('@/components/ui/notifications',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
let client:QueryClient;
const user={id:'sso',username:'sso',role:'user' as const,project_id:null,enabled:true,preferred_language:'en' as const,last_login_at:null,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z'};
beforeEach(async()=>{
 await i18n.changeLanguage('en');client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 vi.mocked(api.getUsers).mockResolvedValue({items:[{...user,source:'sso',projectCount:42}],nextCursor:'sso'});
 vi.mocked(api.getUser).mockResolvedValue({user,source:'sso',projects:{items:[{id:'support',name:'support'}],nextCursor:null}});
 vi.mocked(api.updateUser).mockResolvedValue(user);
 vi.mocked(api.getPasswordPolicy).mockResolvedValue({minLength:12,maxLength:128});
 vi.mocked(api.createUser).mockResolvedValue({...user,id:'local',username:'alice'});
 vi.mocked(projectsApi.listProjects).mockResolvedValue({items:[{id:'support',name:'support',groupId:'default',groupName:'Default',poolId:'default',poolName:'runner-default',memberCount:0},{id:'sales',name:'sales',groupId:'default',groupName:'Default',poolId:'default',poolName:'runner-default',memberCount:0}],nextCursor:null});
 vi.mocked(projectsApi.setProjectMember).mockResolvedValue(undefined);
});
afterEach(()=>{cleanup();client.clear();vi.clearAllMocks();});
const mount=()=>render(<QueryClientProvider client={client}><UsersPage/></QueryClientProvider>);
it('loads summaries first, then selected user details without permitting local SSO role or password edits',async()=>{
 mount();await screen.findByText('Keycloak');expect(screen.getByText('42')).toBeTruthy();expect(api.getUser).not.toHaveBeenCalled();expect(screen.queryByText('support')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Manage user · sso'}));await screen.findByText('support');
 const sheet=screen.getByRole('dialog');expect(within(sheet).queryByLabelText('New password (optional)')).toBeNull();expect(within(sheet).getByRole('combobox').hasAttribute('disabled')).toBe(true);
 expect(within(sheet).queryByRole('combobox',{name:'Search and select projects'})).toBeNull();
 fireEvent.click(within(sheet).getByRole('switch',{name:'Account enabled'}));
 fireEvent.click(within(sheet).getByRole('button',{name:'Save changes'}));await waitFor(()=>expect(api.updateUser).toHaveBeenCalledWith('sso',{enabled:false}));
});
it('requests the next page on demand and resets the cursor for server search',async()=>{
 mount();await screen.findByText('Keycloak');fireEvent.click(screen.getByRole('button',{name:'Next'}));
 await waitFor(()=>expect(api.getUsers).toHaveBeenLastCalledWith({q:'',cursor:'sso',limit:25},expect.any(AbortSignal)));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Alice'}});
 await waitFor(()=>expect(api.getUsers).toHaveBeenLastCalledWith({q:'Alice',cursor:undefined,limit:25},expect.any(AbortSignal)));
 expect(api.getUser).not.toHaveBeenCalled();
});

async function openCreate() {
 mount(); await screen.findByText('Keycloak'); fireEvent.click(screen.getByRole('button',{name:'Add user'}));
 await screen.findByText('Use 12–128 characters.');
 fireEvent.change(screen.getByLabelText('Username'),{target:{value:'alice'}});
 fireEvent.change(screen.getByLabelText('Password'),{target:{value:'valid-password'}});
}
async function chooseProject(name:string) {
 const input=screen.getByRole('combobox',{name:'Search and select projects'});
 fireEvent.change(input,{target:{value:name}});
 await waitFor(()=>expect(projectsApi.listProjects).toHaveBeenLastCalledWith({q:name,cursor:undefined,limit:25},expect.any(AbortSignal)));
 fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'Enter',keyCode:13});
 await screen.findByRole('button',{name:`Remove ${name}`,exact:true});
}
it('uses server password requirements and reveals passwords without changing their value',async()=>{
 await openCreate();
 const password=screen.getByLabelText('Password') as HTMLInputElement;
 fireEvent.change(password,{target:{value:'eight123'}});fireEvent.blur(password);
 expect(screen.getByRole('button',{name:'Create'}).hasAttribute('disabled')).toBe(true);
 expect(password.getAttribute('aria-invalid')).toBe('true');
 fireEvent.click(screen.getByRole('button',{name:'Show password'}));expect(password.type).toBe('text');expect(password.value).toBe('eight123');
 fireEvent.change(password,{target:{value:'valid-password'}});
 expect(screen.getByRole('button',{name:'Create'}).hasAttribute('disabled')).toBe(false);
});
it('creates once and retries only unfinished project assignments after a partial failure',async()=>{
 await openCreate(); await chooseProject('support'); await chooseProject('sales');
 vi.mocked(projectsApi.setProjectMember).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Assignment failed')).mockResolvedValue(undefined);
 fireEvent.click(screen.getByRole('button',{name:'Create'}));
 await screen.findByText('Assignment failed');expect(api.createUser).toHaveBeenCalledTimes(1);
 expect(screen.getByText(/The account was created/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Retry project assignment'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(api.createUser).toHaveBeenCalledTimes(1);
 expect(projectsApi.setProjectMember).toHaveBeenCalledTimes(3);
 expect(projectsApi.setProjectMember).toHaveBeenNthCalledWith(3,'sales','local',true);
});
it('loads all existing memberships and saves only the selected project changes',async()=>{
 vi.mocked(api.getUser).mockImplementation(async(_id,query)=>({user:{...user,id:'local'},source:'local',projects:query?.cursor ? {items:[{id:'sales',name:'sales'}],nextCursor:null} : {items:[{id:'support',name:'support'}],nextCursor:'support'}}));
 mount();await screen.findByText('Keycloak');fireEvent.click(screen.getByRole('button',{name:'Manage user · sso'}));
 await screen.findByRole('button',{name:'Remove sales',exact:true});
 expect(screen.getByRole('button',{name:'Save changes'}).hasAttribute('disabled')).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Remove support',exact:true}));
 fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
 expect(api.updateUser).not.toHaveBeenCalled();
 expect(projectsApi.setProjectMember).toHaveBeenCalledExactlyOnceWith('support','local',false);
});
it('does not enable account creation when password requirements fail to load',async()=>{
 vi.mocked(api.getPasswordPolicy).mockRejectedValue(new Error('Policy unavailable'));
 mount();await screen.findByText('Keycloak');fireEvent.click(screen.getByRole('button',{name:'Add user'}));
 await screen.findByText('Policy unavailable');expect(screen.getByRole('button',{name:'Try again'})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Create'}).hasAttribute('disabled')).toBe(true);
});
it('returns keyboard focus to the opener after canceling a user sheet',async()=>{
 mount();await screen.findByText('Keycloak');
 const add=screen.getByRole('button',{name:'Add user'});
 fireEvent.click(add);await screen.findByText('Use 12–128 characters.');
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await waitFor(()=>expect(document.activeElement).toBe(add));
 const manage=screen.getByRole('button',{name:'Manage user · sso'});
 fireEvent.click(manage);await screen.findByText('support');
 fireEvent.click(screen.getByRole('button',{name:'Cancel'}));
 await waitFor(()=>expect(document.activeElement).toBe(manage));
});
