import type { ConfigurableAiService } from "./ai-service";
import type { StateRepository } from "./repository";
import type { ModelProfileVersion, ProviderConnectionProfile } from "../src/domain/types";

export type ProfileRestoreStatus = "restored" | "credential_missing" | "not_configured";

function desiredProfile(profiles: ModelProfileVersion[]) {
  const active = profiles.find((item) => item.status === "active");
  if (active) return active;
  return profiles
    .filter((item) => item.status === "credential_missing")
    .sort((left, right) => (right.activated_at ?? "").localeCompare(left.activated_at ?? ""))[0];
}

function updateConnection(connection: ProviderConnectionProfile, credentialAvailable: boolean, at: string): ProviderConnectionProfile {
  const source = connection.auth_mode === "none" ? "none" : credentialAvailable ? "environment" : "none";
  if (connection.credential_available === credentialAvailable && connection.credential_source === source) return connection;
  return { ...connection, credential_available: credentialAvailable, credential_source: source, revision: connection.revision + 1, updated_at: at };
}

export function restorePersistedModelProfile(repository: StateRepository, aiService: ConfigurableAiService, tenantId: string, environment: NodeJS.ProcessEnv = process.env): ProfileRestoreStatus {
  const loaded = repository.load(tenantId);
  const profile = desiredProfile(loaded.state.model_profiles);
  if (!profile) return "not_configured";
  const connection = loaded.state.provider_connections.find((item) => item.id === profile.connection_profile_id);
  if (!connection) return "not_configured";
  const credentialAvailable = connection.auth_mode === "none" || Boolean(connection.credential_ref && environment[connection.credential_ref]?.trim());
  const at = new Date().toISOString();

  if (!credentialAvailable) {
    const nextProfile: ModelProfileVersion = profile.status === "credential_missing" ? profile : { ...profile, status: "credential_missing", revision: profile.revision + 1, updated_at: at };
    const nextConnection = updateConnection(connection, false, at);
    if (nextProfile !== profile || nextConnection !== connection) {
      repository.save(tenantId, {
        ...loaded.state,
        model_profiles: loaded.state.model_profiles.map((item) => item.id === profile.id ? nextProfile : item),
        provider_connections: loaded.state.provider_connections.map((item) => item.id === connection.id ? nextConnection : item),
        audits: profile.status === "credential_missing" ? loaded.state.audits : [{ id: `audit-${crypto.randomUUID()}`, actor: "系统", action: "模型凭据重启失效", detail: `${profile.provider} · ${profile.primary_model} · 生成已阻断`, at, source: "system" }, ...loaded.state.audits],
      }, loaded.repositoryRevision);
    }
    return "credential_missing";
  }

  aiService.activateProfile(connection, profile);
  const restoredProfile: ModelProfileVersion = profile.status === "active" ? profile : { ...profile, status: "active", revision: profile.revision + 1, updated_at: at };
  const restoredConnection = updateConnection(connection, true, at);
  if (restoredProfile !== profile || restoredConnection !== connection) {
    repository.save(tenantId, {
      ...loaded.state,
      model_profiles: loaded.state.model_profiles.map((item) => item.id === profile.id ? restoredProfile : item),
      provider_connections: loaded.state.provider_connections.map((item) => item.id === connection.id ? restoredConnection : item),
      audits: [{ id: `audit-${crypto.randomUUID()}`, actor: "系统", action: "恢复全局模型 Profile", detail: `${profile.provider} · ${profile.primary_model}`, at, source: "system" }, ...loaded.state.audits],
    }, loaded.repositoryRevision);
  }
  return "restored";
}
