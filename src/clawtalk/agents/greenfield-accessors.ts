import { getDbPg } from '../../db.js';

export interface GreenfieldAgentRecord {
  id: string;
  workspace_id: string;
  role_key: string;
  name: string;
  handle: string;
  initials: string;
  accent: string;
  accent_dark: string | null;
  model_id: string;
  default_model_id: string;
  model_display_name: string | null;
  default_model_display_name: string | null;
  job: string;
  persona: string | null;
  focus: string | null;
  method: string[];
  capabilities: string[];
  is_default: boolean;
  is_custom: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface GreenfieldTeamRecord {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  is_default: boolean;
  runs_count: number;
  agent_ids: string[];
  created_at: string;
  updated_at: string;
}

export async function listWorkspaceAgents(input: {
  workspaceId: string;
  includeSystem?: boolean;
}): Promise<GreenfieldAgentRecord[]> {
  const db = getDbPg();
  return db<GreenfieldAgentRecord[]>`
    select
      a.id,
      a.workspace_id,
      a.role_key,
      a.name,
      a.handle,
      a.initials,
      a.accent,
      a.accent_dark,
      a.model_id,
      a.default_model_id,
      m.display_name as model_display_name,
      dm.display_name as default_model_display_name,
      t.job,
      a.persona,
      a.focus,
      a.method,
      a.capabilities,
      a.is_default,
      a.is_custom,
      a.enabled,
      a.created_at,
      a.updated_at
    from public.agents a
    join public.agent_role_templates t
      on t.role_key = a.role_key
    left join public.llm_provider_models m
      on m.model_id = a.model_id
    left join public.llm_provider_models dm
      on dm.model_id = a.default_model_id
    where a.workspace_id = ${input.workspaceId}::uuid
      and (${input.includeSystem === true}::boolean or a.is_system = false)
    order by
      case a.role_key
        when 'strategist' then 1
        when 'critic' then 2
        when 'researcher' then 3
        when 'quant' then 4
        when 'editor' then 5
        when 'forge_rewriter' then 90
        when 'forge_critic' then 91
        else 50
      end,
      a.name asc,
      a.id asc
  `;
}

export async function listWorkspaceTeams(input: {
  workspaceId: string;
}): Promise<GreenfieldTeamRecord[]> {
  const db = getDbPg();
  return db<GreenfieldTeamRecord[]>`
    select
      tc.id,
      tc.workspace_id,
      tc.name,
      tc.description,
      tc.icon,
      tc.is_default,
      tc.runs_count,
      coalesce(
        array_agg(tca.agent_id order by tca.sort_order asc)
          filter (where tca.agent_id is not null),
        '{}'::uuid[]
      )::text[] as agent_ids,
      tc.created_at,
      tc.updated_at
    from public.team_compositions tc
    left join public.team_composition_agents tca
      on tca.workspace_id = tc.workspace_id
     and tca.team_id = tc.id
    where tc.workspace_id = ${input.workspaceId}::uuid
    group by tc.id
    order by tc.is_default desc, tc.name asc, tc.id asc
  `;
}
