import type { GameProfile } from "./gameProfiles";

export interface ListGameProfilesResponse {
  profiles: GameProfile[];
}

export interface SteamAppManifest {
  appId: number;
  name: string;
  installDir: string;
  universe: string;
  stateFlags: number;
  libraryPath: string;
}

export interface ScanSteamResponse {
  apps: SteamAppManifest[];
  profiles: GameProfile[];
}

export class CoreApi {
  constructor(private readonly baseUrl = "http://127.0.0.1:55123") {}

  async listGameProfiles(): Promise<GameProfile[]> {
    const response = await this.request<ListGameProfilesResponse>(
      "/v1/routing/game-profiles",
      { method: "GET" },
    );
    return response.profiles;
  }

  async addGameProfile(profile: GameProfile): Promise<GameProfile> {
    return this.request<GameProfile>("/v1/routing/game-profiles", {
      method: "POST",
      body: JSON.stringify(profile),
    });
  }

  async updateGameProfile(profile: GameProfile): Promise<GameProfile> {
    return this.request<GameProfile>(
      `/v1/routing/game-profiles/${encodeURIComponent(profile.id)}`,
      {
        method: "PUT",
        body: JSON.stringify(profile),
      },
    );
  }

  async removeGameProfile(id: string): Promise<void> {
    await this.request<void>(`/v1/routing/game-profiles/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async scanSteam(root?: string): Promise<ScanSteamResponse> {
    const params = root?.trim()
      ? `?root=${encodeURIComponent(root.trim())}`
      : "";
    return this.request<ScanSteamResponse>(`/v1/launchers/steam/scan${params}`, {
      method: "GET",
    });
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error(payload.error ?? response.statusText);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }
}

export const coreApi = new CoreApi();
