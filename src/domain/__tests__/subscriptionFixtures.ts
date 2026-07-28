import type { ProxyProtocol } from "../subscriptions";
import type { XrayOutboundCompatibilityStatus } from "../subscriptions";

export interface SubscriptionCompatibilityFixture {
  id: string;
  payload: string;
  expected: {
    name: string;
    protocol: ProxyProtocol;
    address: string;
    port: number;
    security?: string;
    transport?: string;
    sni?: string;
  };
  xrayCompatibilityStatus?: XrayOutboundCompatibilityStatus;
  outboundMatch: Record<string, unknown>;
}

const vmessWsTls = Buffer.from(
  JSON.stringify({
    v: "2",
    ps: "VMess WS TLS",
    add: "vmess.example.com",
    port: "443",
    id: "vmess-uuid",
    aid: "0",
    net: "ws",
    type: "none",
    host: "cdn.example.com",
    path: "/vmess",
    tls: "tls",
    sni: "edge.example.com",
    scy: "auto",
  }),
).toString("base64");
const wireGuardPrivateKey = "kC+rcYLfu5eDay+B38l+3BsaCj3SaHEsLVVDnDcifUY=";
const wireGuardPublicKey = "xvLr+tvUJKCD3amfTkG8jbN/rj3q2j/Wi1BTt2LjNn0=";
const wireGuardPreSharedKey = "bmksqJz2tpgoNqoSqIxgcSxosP2NfQ2fK10zzju93yI=";

export const singBoxTuicJsonFixture = JSON.stringify({
  outbounds: [
    {
      type: "tuic",
      tag: "sing-box TUIC",
      server: "sing-tuic.example.com",
      server_port: 443,
      uuid: "sing-tuic-uuid",
      password: "sing-tuic-secret",
      congestion_control: "bbr",
      udp_relay_mode: "native",
      zero_rtt_handshake: true,
      tls: {
        enabled: true,
        server_name: "edge.example.com",
        alpn: ["h3"],
      },
    },
  ],
});

export const xrayFullConfigJsonFixture = JSON.stringify({
  log: { loglevel: "info", dnsLog: true },
  dns: {
    servers: [
      {
        address: "1.1.1.1",
        port: 53,
      },
    ],
    queryStrategy: "UseIPv4",
  },
  routing: {
    domainStrategy: "IPOnDemand",
    domainMatcher: "hybrid",
    rules: [
      {
        type: "field",
        domain: ["full:user.example.com"],
        outboundTag: "tachyon-proxy",
      },
      {
        type: "field",
        inboundTag: ["tachyon-socks"],
        outboundTag: "tachyon-proxy",
      },
    ],
    userRoutingField: { retained: true },
  },
  policy: {
    levels: {
      "0": {
        handshake: 7,
        userUplink: true,
      },
    },
    system: {
      statsUserUplink: true,
    },
    userPolicyField: "keep-policy",
  },
  stats: {
    userStatsField: ["keep", "stats"],
  },
  api: {
    tag: "user-api",
    services: ["HandlerService"],
    userApiField: { retained: true },
  },
  fakedns: [
    {
      ipPool: "198.18.0.0/15",
      poolSize: 1024,
    },
  ],
  observatory: {
    subjectSelector: ["Xray Full"],
    probeUrl: "https://www.gstatic.com/generate_204",
    probeInterval: "30s",
    enableConcurrency: true,
  },
  burstObservatory: {
    subjectSelector: ["tachyon-proxy"],
    pingConfig: {
      destination: "https://www.gstatic.com/generate_204",
      connectivity: "http",
      interval: "10s",
      sampling: 3,
      timeout: "5s",
    },
  },
  inbounds: [
    {
      tag: "tachyon-socks",
      listen: "127.0.0.1",
      port: 18000,
      protocol: "dokodemo-door",
      settings: { address: "127.0.0.1", port: 9, network: "tcp" },
      userInboundField: "keep-inbound",
    },
  ],
  outbounds: [
    {
      tag: "Xray Full Trojan TLS",
      protocol: "trojan",
      settings: {
        servers: [
          {
            address: "xray-trojan.example.com",
            port: 443,
            password: "xray-trojan-secret",
          },
        ],
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
          fingerprint: "chrome",
        },
        sockopt: {
          tcpKeepAliveIdle: 60,
          tcpKeepAliveInterval: 30,
        },
      },
      userOutboundField: { retained: true },
    },
    {
      tag: "tachyon-proxy",
      protocol: "vmess",
      settings: {
        address: "backup-vmess.example.com",
        port: 8443,
        id: "backup-vmess-uuid",
        security: "auto",
      },
      streamSettings: {
        network: "xhttp",
        security: "tls",
        tlsSettings: {
          serverName: "backup-edge.example.com",
          alpn: ["h2", "http/1.1"],
        },
        xhttpSettings: {
          path: "/xhttp",
          mode: "auto",
          extra: {
            xPaddingBytes: "100-1000",
          },
        },
      },
    },
  ],
  userTopLevelField: {
    nested: ["preserve", { exactly: true }],
  },
});

export const xrayManagedReferenceGraphJsonFixture = JSON.stringify({
  outbounds: [
    {
      tag: "tachyon-direct",
      protocol: "vmess",
      settings: {
        address: "selected.example.com",
        port: 443,
        id: "selected-node-id",
      },
      userSelectedField: { retained: true },
    },
    {
      tag: "chain-hop",
      protocol: "freedom",
      proxySettings: {
        tag: "tachyon-direct",
      },
    },
    {
      tag: "dial-hop",
      protocol: "freedom",
      streamSettings: {
        sockopt: {
          dialerProxy: "tachyon-direct",
        },
      },
    },
  ],
  routing: {
    rules: [
      {
        type: "field",
        domain: ["full:managed-reference.example"],
        outboundTag: "tachyon-direct",
      },
    ],
    balancers: [
      {
        tag: "managed-balancer",
        selector: ["tachyon-direct"],
        fallbackTag: "tachyon-direct",
        strategy: { type: "roundRobin" },
      },
    ],
  },
  observatory: {
    subjectSelector: ["tachyon-direct"],
    probeUrl: "https://www.gstatic.com/generate_204",
    probeInterval: "30s",
  },
  burstObservatory: {
    subjectSelector: ["tachyon-direct"],
    pingConfig: {
      destination: "https://connectivitycheck.gstatic.com/generate_204",
      interval: "30s",
      sampling: 3,
      timeout: "5s",
    },
  },
});

export const xrayAdvancedRoundTripJsonFixture = JSON.stringify(
  {
    log: { loglevel: "warning" },
    dns: { hosts: { "domain:example.test": "127.0.0.1" }, servers: ["1.1.1.1"] },
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["tachyon-socks"],
          outboundTag: "custom-proxy",
        },
      ],
    },
    policy: { levels: { "0": { handshake: 4 } }, system: { statsInboundUplink: true } },
    api: { tag: "tachyon-xray-api", services: ["StatsService"] },
    stats: { preserveStatsExtension: true },
    metrics: { tag: "metrics", listen: "127.0.0.1:11111" },
    reverse: {
      bridges: [{ tag: "bridge", domain: "reverse.example.test" }],
    },
    observatory: {
      subjectSelector: ["custom-proxy"],
      probeUrl: "https://example.test/generate_204",
    },
    burstObservatory: {
      subjectSelector: ["custom-proxy"],
      pingConfig: { destination: "https://example.test/ping", interval: "15s" },
    },
    fakedns: [{ ipPool: "198.18.0.0/15", poolSize: 2048 }],
    inbounds: [
      {
        tag: "tachyon-socks",
        listen: "127.0.0.1",
        port: 10808,
        protocol: "socks",
        settings: { udp: true },
      },
      {
        tag: "custom-inbound",
        listen: "127.0.0.1",
        port: 10810,
        protocol: "dokodemo-door",
        settings: { address: "example.test", port: 443 },
      },
    ],
    outbounds: [
      {
        tag: "custom-proxy",
        protocol: "future-protocol",
        settings: { futureCredentialShape: { id: "fixture-only" } },
      },
      {
        tag: "tachyon-direct",
        protocol: "freedom",
        settings: { domainStrategy: "UseIP" },
      },
    ],
    futureXrayField: {
      enabled: true,
      nested: [{ untouched: "round-trip" }],
    },
  },
  null,
  2,
);

export const subscriptionCompatibilityFixtures: SubscriptionCompatibilityFixture[] = [
  {
    id: "vless-reality",
    payload:
      "vless://vless-reality-uuid@reality.example.com:443?encryption=none&type=tcp&security=reality&sni=www.cloudflare.com&fp=chrome&pbk=reality-public-key&sid=01&flow=xtls-rprx-vision#VLESS Reality",
    expected: {
      name: "VLESS Reality",
      protocol: "vless",
      address: "reality.example.com",
      port: 443,
      security: "reality",
      transport: "raw",
      sni: "www.cloudflare.com",
    },
    outboundMatch: {
      protocol: "vless",
      settings: {
        address: "reality.example.com",
        port: 443,
        id: "vless-reality-uuid",
        encryption: "none",
        flow: "xtls-rprx-vision",
      },
      streamSettings: {
        network: "raw",
        security: "reality",
        realitySettings: {
          serverName: "www.cloudflare.com",
          password: "reality-public-key",
          shortId: "01",
        },
      },
    },
  },
  {
    id: "vless-ws-tls",
    payload:
      "vless://vless-ws-uuid@vless-ws.example.com:443?encryption=none&type=ws&security=tls&sni=edge.example.com&host=cdn.example.com&path=/vless#VLESS WS TLS",
    expected: {
      name: "VLESS WS TLS",
      protocol: "vless",
      address: "vless-ws.example.com",
      port: 443,
      security: "tls",
      transport: "websocket",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "vless",
      settings: {
        address: "vless-ws.example.com",
        port: 443,
        id: "vless-ws-uuid",
        encryption: "none",
      },
      streamSettings: {
        network: "websocket",
        security: "tls",
        wsSettings: {
          path: "/vless",
          headers: { Host: "cdn.example.com" },
        },
      },
    },
  },
  {
    id: "vmess-ws-tls",
    payload: `vmess://${vmessWsTls}`,
    expected: {
      name: "VMess WS TLS",
      protocol: "vmess",
      address: "vmess.example.com",
      port: 443,
      security: "tls",
      transport: "websocket",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "vmess",
      settings: {
        address: "vmess.example.com",
        port: 443,
        id: "vmess-uuid",
        alterId: 0,
        security: "auto",
      },
      streamSettings: {
        network: "websocket",
        security: "tls",
        wsSettings: {
          path: "/vmess",
          headers: { Host: "cdn.example.com" },
        },
      },
    },
  },
  {
    id: "trojan-tls",
    payload:
      "trojan://trojan-secret@trojan.example.com:443?security=tls&sni=edge.example.com&alpn=h2,http/1.1#Trojan TLS",
    expected: {
      name: "Trojan TLS",
      protocol: "trojan",
      address: "trojan.example.com",
      port: 443,
      security: "tls",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "trojan",
      settings: {
        address: "trojan.example.com",
        port: 443,
        password: "trojan-secret",
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
          alpn: ["h2", "http/1.1"],
        },
      },
    },
  },
  {
    id: "shadowsocks-aead",
    payload: "ss://YWVzLTI1Ni1nY206c3Mtc2VjcmV0@ss.example.com:8388#Shadowsocks AEAD",
    expected: {
      name: "Shadowsocks AEAD",
      protocol: "shadowsocks",
      address: "ss.example.com",
      port: 8388,
    },
    outboundMatch: {
      protocol: "shadowsocks",
      settings: {
        address: "ss.example.com",
        port: 8388,
        method: "aes-256-gcm",
        password: "ss-secret",
      },
    },
  },
  {
    id: "socks",
    payload: "socks5://socks-user:socks-pass@socks.example.com:1080#SOCKS Node",
    expected: {
      name: "SOCKS Node",
      protocol: "socks",
      address: "socks.example.com",
      port: 1080,
    },
    outboundMatch: {
      protocol: "socks",
      settings: {
        address: "socks.example.com",
        port: 1080,
        user: "socks-user",
        pass: "socks-pass",
      },
    },
  },
  {
    id: "http",
    payload: "http://http-user:http-pass@http.example.com:8080#HTTP Node",
    expected: {
      name: "HTTP Node",
      protocol: "http",
      address: "http.example.com",
      port: 8080,
    },
    outboundMatch: {
      protocol: "http",
      settings: {
        address: "http.example.com",
        port: 8080,
        user: "http-user",
        pass: "http-pass",
      },
    },
  },
  {
    id: "hysteria2",
    payload:
      "hysteria2://hy-secret@hy2.example.com:443?security=tls&sni=edge.example.com&udpIdleTimeout=25s#Hysteria2 Node",
    expected: {
      name: "Hysteria2 Node",
      protocol: "hysteria",
      address: "hy2.example.com",
      port: 443,
      security: "tls",
      transport: "hysteria",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "hysteria",
      settings: {
        version: 2,
        address: "hy2.example.com",
        port: 443,
      },
      streamSettings: {
        network: "hysteria",
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
        },
        hysteriaSettings: {
          auth: "hy-secret",
          udpIdleTimeout: 25,
        },
      },
    },
  },
  {
    id: "tuic",
    xrayCompatibilityStatus: "unsupported-by-xray",
    payload:
      "tuic://tuic-uuid:tuic-secret@tuic.example.com:443?sni=edge.example.com&alpn=h3&congestion=bbr&udpRelayMode=native&zeroRttHandshake=true#TUIC Node",
    expected: {
      name: "TUIC Node",
      protocol: "tuic",
      address: "tuic.example.com",
      port: 443,
      security: "tls",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "tuic",
      settings: {
        address: "tuic.example.com",
        port: 443,
        uuid: "tuic-uuid",
        password: "tuic-secret",
        congestion: "bbr",
        udpRelayMode: "native",
        zeroRttHandshake: true,
      },
    },
  },
  {
    id: "sing-box-tuic-json",
    xrayCompatibilityStatus: "unsupported-by-xray",
    payload: singBoxTuicJsonFixture,
    expected: {
      name: "sing-box TUIC",
      protocol: "tuic",
      address: "sing-tuic.example.com",
      port: 443,
      security: "tls",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "tuic",
      settings: {
        address: "sing-tuic.example.com",
        port: 443,
        uuid: "sing-tuic-uuid",
        password: "sing-tuic-secret",
        congestion: "bbr",
        udpRelayMode: "native",
        zeroRttHandshake: true,
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
          alpn: ["h3"],
        },
      },
    },
  },
  {
    id: "wireguard",
    payload: `wireguard://${encodeURIComponent(wireGuardPublicKey)}@wg.example.com:51820?secretKey=${encodeURIComponent(wireGuardPrivateKey)}&address=10.8.0.2/32,fd00::2/128&reserved=1,2,3&mtu=1420&preSharedKey=${encodeURIComponent(wireGuardPreSharedKey)}&keepAlive=25&allowedIPs=0.0.0.0/0,::/0#WireGuard Node`,
    expected: {
      name: "WireGuard Node",
      protocol: "wireguard",
      address: "wg.example.com",
      port: 51820,
    },
    outboundMatch: {
      protocol: "wireguard",
      settings: {
        secretKey: wireGuardPrivateKey,
        address: ["10.8.0.2/32", "fd00::2/128"],
        reserved: [1, 2, 3],
        mtu: 1420,
        peers: [
          {
            endpoint: "wg.example.com:51820",
            publicKey: wireGuardPublicKey,
            preSharedKey: wireGuardPreSharedKey,
            keepAlive: 25,
            allowedIPs: ["0.0.0.0/0", "::/0"],
          },
        ],
      },
    },
  },
  {
    id: "clash-mihomo-proxies",
    payload: `
proxies:
  - name: Clash VMess WS TLS
    type: vmess
    server: clash-vmess.example.com
    port: 443
    uuid: clash-vmess-uuid
    cipher: auto
    network: ws
    tls: true
    sni: edge.example.com
    ws-opts:
      path: /clash
      headers:
        Host: cdn.example.com
`,
    expected: {
      name: "Clash VMess WS TLS",
      protocol: "vmess",
      address: "clash-vmess.example.com",
      port: 443,
      security: "tls",
      transport: "websocket",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "vmess",
      settings: {
        address: "clash-vmess.example.com",
        port: 443,
        id: "clash-vmess-uuid",
        security: "auto",
      },
      streamSettings: {
        network: "websocket",
        security: "tls",
        wsSettings: {
          path: "/clash",
          headers: { Host: "cdn.example.com" },
        },
      },
    },
  },
  {
    id: "xray-full-outbound-json",
    payload: JSON.stringify({
      log: { loglevel: "warning" },
      outbounds: [
        {
          tag: "Xray Full Trojan TLS",
          protocol: "trojan",
          settings: {
            servers: [
              {
                address: "xray-trojan.example.com",
                port: 443,
                password: "xray-trojan-secret",
              },
            ],
          },
          streamSettings: {
            security: "tls",
            tlsSettings: {
              serverName: "edge.example.com",
            },
          },
        },
      ],
    }),
    expected: {
      name: "Xray Full Trojan TLS",
      protocol: "trojan",
      address: "xray-trojan.example.com",
      port: 443,
      security: "tls",
      sni: "edge.example.com",
    },
    outboundMatch: {
      protocol: "trojan",
      settings: {
        servers: [
          {
            address: "xray-trojan.example.com",
            port: 443,
            password: "xray-trojan-secret",
          },
        ],
      },
      streamSettings: {
        security: "tls",
        tlsSettings: {
          serverName: "edge.example.com",
        },
      },
    },
  },
  {
    id: "sing-box-full-outbound-json",
    xrayCompatibilityStatus: "unsupported-by-xray",
    payload: JSON.stringify({
      log: { level: "info" },
      outbounds: [
        {
          type: "vless",
          tag: "sing-box VLESS Reality",
          server: "sing-vless.example.com",
          server_port: 443,
          uuid: "sing-vless-uuid",
          flow: "xtls-rprx-vision",
          tls: {
            enabled: true,
            server_name: "www.cloudflare.com",
            utls: { fingerprint: "chrome" },
            reality: {
              enabled: true,
              public_key: "sing-reality-public-key",
              short_id: "02",
            },
          },
          transport: {
            type: "ws",
            path: "/sing",
            headers: {
              Host: "cdn.example.com",
            },
          },
        },
      ],
    }),
    expected: {
      name: "sing-box VLESS Reality",
      protocol: "vless",
      address: "sing-vless.example.com",
      port: 443,
      security: "reality",
      transport: "websocket",
      sni: "www.cloudflare.com",
    },
    outboundMatch: {
      protocol: "vless",
      settings: {
        address: "sing-vless.example.com",
        port: 443,
        id: "sing-vless-uuid",
        encryption: "none",
        flow: "xtls-rprx-vision",
      },
      streamSettings: {
        network: "websocket",
        security: "reality",
        realitySettings: {
          serverName: "www.cloudflare.com",
          password: "sing-reality-public-key",
          shortId: "02",
        },
        wsSettings: {
          path: "/sing",
          headers: { Host: "cdn.example.com" },
        },
      },
    },
  },
];

export const unsupportedSubscriptionFixture = [
  "vless://ok-uuid@ok.example.com:443?encryption=none#OK",
  "ssr://legacy.example.com:443",
  "not-a-node",
].join("\n");

export const unsupportedSingBoxJsonFixture = JSON.stringify({
  outbounds: [
    {
      type: "selector",
      tag: "sing-box selector",
      outbounds: ["OK"],
    },
  ],
});
