export type UDPPolicy = "auto" | "tgp" | "direct" | "block";
export type TCPPolicy = "auto" | "direct" | "block";

export interface MatchRule {
  processNames: string[];
  paths: string[];
  pathPrefixes: string[];
  sha256: string[];
  steamAppIds: number[];
}

export interface GameProfile {
  id: string;
  displayName: string;
  enabled: boolean;
  manual: boolean;
  priority: number;
  match: MatchRule;
  udpPolicy: UDPPolicy;
  tcpPolicy: TCPPolicy;
}

export const defaultGameProfiles: GameProfile[] = [
  {
    id: "cs2",
    displayName: "Counter-Strike 2",
    enabled: true,
    manual: true,
    priority: 100,
    match: {
      processNames: ["cs2.exe"],
      paths: [],
      pathPrefixes: [],
      sha256: [],
      steamAppIds: [730],
    },
    udpPolicy: "tgp",
    tcpPolicy: "auto",
  },
];
