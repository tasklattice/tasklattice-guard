import { sql } from "drizzle-orm";
import type { ControllerDatabase } from "../db/client.js";
import { NotFoundError } from "../domain/errors.js";
import {
  directoryPage,
  searchPattern,
  type DirectoryQuery,
} from "../../shared/directory.js";
import type {
  IdentityUser,
  UserSummary,
  UserDetail,
} from "../../shared/identity.js";
import { SSO_PROVIDER_ID } from "../sso-config.js";

/** List only a bounded page; expand one user's memberships on demand. */
export class UserDirectory {
  constructor(private readonly db: ControllerDatabase) {}
  async list(query: DirectoryQuery) {
    const { rows } = await this.db.execute<UserSummary>(sql`
      with page as materialized (
        select id,username,role,banned from auth_user
        where (${query.cursor ?? null}::text is null or id > ${query.cursor ?? null})
          and (${query.q} = '' or username ilike ${searchPattern(query.q)})
        order by id limit ${query.limit + 1}
      ) select id,username,role,not banned as enabled,
        case when exists(select 1 from auth_account a where a.user_id=page.id and a.provider_id=${SSO_PROVIDER_ID}) then 'sso' else 'local' end as source,
        (select count(*)::int from project_member m where m.user_id=page.id) as "projectCount"
      from page order by id`);
    return directoryPage(rows, query.limit, (row) => row.id);
  }
  async detail(id: string, query: DirectoryQuery): Promise<UserDetail> {
    const {
      rows: [row],
    } = await this.db.execute<
      IdentityUser & {
        source: "sso" | "local";
        projects: Array<{ id: string; name: string }>;
      }
    >(sql`
      select u.id,u.username,u.email,u.role,not u.banned as enabled,
        null::text as project_id,u.preferred_language,u.last_login_at,u.created_at,u.updated_at,
        case when exists(select 1 from auth_account a where a.user_id=u.id and a.provider_id=${SSO_PROVIDER_ID}) then 'sso' else 'local' end as source,
        coalesce((select jsonb_agg(p order by p.id) from (
          select p.id,p.name from project_member m join project p on p.id=m.project_id
          where m.user_id=u.id and (${query.cursor ?? null}::text is null or p.id > ${query.cursor ?? null})
            and (${query.q}='' or p.name ilike ${searchPattern(query.q)})
          order by p.id limit ${query.limit + 1}) p),'[]'::jsonb) as projects
      from auth_user u where u.id=${id}`);
    if (!row) throw new NotFoundError("User", id);
    const { source, projects, ...user } = row;
    return {
      user,
      source,
      projects: directoryPage(projects, query.limit, (item) => item.id),
    };
  }
}
