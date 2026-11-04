import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import * as api from '@/lib/identity-api';
import {UsersPage} from './users';
import i18n from '@/i18n';
vi.mock('@/lib/auth',()=>({useAuth:()=>({user:{id:'admin',role:'admin'}})}));
vi.mock('@/lib/identity-api',()=>({getUsers:vi.fn(),getUser:vi.fn(),createUser:vi.fn(),updateUser:vi.fn()}));
vi.mock('@/components/ui/notifications',()=>({toast:{success:vi.fn(),error:vi.fn()}}));
let client:QueryClient;
const user={id:'sso',username:'sso',role:'user' as const,project_id:null,enabled:true,preferred_language:'en' as const,last_login_at:null,created_at:'2026-11-01T00:00:00Z',updated_at:'2026-11-01T00:00:00Z'};
beforeEach(async()=>{
 await i18n.changeLanguage('en');client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
 vi.mocked(api.getUsers).mockResolvedValue({items:[{...user,source:'sso',projectCount:42}],nextCursor:'sso'});
 vi.mocked(api.getUser).mockResolvedValue({user,source:'sso',projects:{items:[{id:'support',name:'support'}],nextCursor:null}});
 vi.mocked(api.updateUser).mockResolvedValue(user);
});
afterEach(()=>{cleanup();client.clear();vi.clearAllMocks();});
const mount=()=>render(<QueryClientProvider client={client}><UsersPage/></QueryClientProvider>);
it('loads summaries first, then selected user details without permitting local SSO role or password edits',async()=>{
 mount();await screen.findByText('Keycloak');expect(screen.getByText('42')).toBeTruthy();expect(api.getUser).not.toHaveBeenCalled();expect(screen.queryByText('support')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Manage user · sso'}));await screen.findByText('support');
 const sheet=screen.getByRole('dialog');expect(within(sheet).queryByLabelText('New password (optional)')).toBeNull();expect(within(sheet).getByRole('combobox').hasAttribute('disabled')).toBe(true);
 fireEvent.click(within(sheet).getByRole('button',{name:'Save changes'}));await waitFor(()=>expect(api.updateUser).toHaveBeenCalledWith('sso',{enabled:true}));
});
it('requests the next page on demand and resets the cursor for server search',async()=>{
 mount();await screen.findByText('Keycloak');fireEvent.click(screen.getByRole('button',{name:'Next'}));
 await waitFor(()=>expect(api.getUsers).toHaveBeenLastCalledWith({q:'',cursor:'sso',limit:25},expect.any(AbortSignal)));
 fireEvent.change(screen.getByRole('textbox'),{target:{value:'Alice'}});
 await waitFor(()=>expect(api.getUsers).toHaveBeenLastCalledWith({q:'Alice',cursor:undefined,limit:25},expect.any(AbortSignal)));
 expect(api.getUser).not.toHaveBeenCalled();
});
