(function installOutboundEvidence(global) {
  const asRecord = (value) => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  );
  const firstRecord = (value) => (
    Array.isArray(value) ? asRecord(value.find((item) => item && typeof item === 'object')) : {}
  );

  const stableValue = (value) => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  };

  const canonicalizeOutbound = (outbound) => JSON.stringify(stableValue(asRecord(outbound)));

  const endpointFromOutbound = (outbound) => {
    const settings = asRecord(outbound?.settings);
    const candidate = Object.keys(asRecord(settings.address)).length > 0
      ? asRecord(settings.address)
      : Object.keys(firstRecord(settings.servers)).length > 0
        ? firstRecord(settings.servers)
        : Object.keys(firstRecord(settings.vnext)).length > 0
          ? firstRecord(settings.vnext)
          : settings;
    let address = typeof candidate.address === 'string' ? candidate.address : '';
    let port = Number.isFinite(Number(candidate.port)) ? Number(candidate.port) : 0;
    if ((!address || !port) && Array.isArray(settings.peers)) {
      const endpoint = String(firstRecord(settings.peers).endpoint ?? '');
      const match = endpoint.match(/^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/);
      address = match?.[1] ?? match?.[3] ?? address;
      port = Number(match?.[2] ?? match?.[4] ?? port);
    }
    return {
      address: address.trim().toLowerCase(),
      port: Number.isInteger(port) && port > 0 ? port : 0,
    };
  };

  const redactedOutboundDescriptor = (outbound) => {
    const settings = asRecord(outbound?.settings);
    const stream = asRecord(outbound?.streamSettings);
    const tls = asRecord(stream.tlsSettings);
    const reality = asRecord(stream.realitySettings);
    const ws = asRecord(stream.wsSettings);
    const xhttp = asRecord(stream.xhttpSettings);
    const grpc = asRecord(stream.grpcSettings);
    const firstServer = firstRecord(settings.servers);
    const firstVnext = firstRecord(settings.vnext);
    const firstUser = firstRecord(firstVnext.users);
    const endpoint = endpointFromOutbound(outbound);
    return {
      protocol: String(outbound?.protocol ?? '').trim().toLowerCase(),
      address: endpoint.address,
      port: endpoint.port,
      transport: String(stream.network ?? '').trim().toLowerCase(),
      security: String(stream.security ?? settings.security ?? '').trim().toLowerCase(),
      cipher: String(
        settings.method ?? settings.encryption ?? firstServer.method ?? firstUser.encryption ?? '',
      ).trim().toLowerCase(),
      flow: String(settings.flow ?? firstUser.flow ?? '').trim(),
      tlsServerName: String(tls.serverName ?? '').trim().toLowerCase(),
      realityServerName: String(reality.serverName ?? '').trim().toLowerCase(),
      fingerprint: String(reality.fingerprint ?? tls.fingerprint ?? '').trim().toLowerCase(),
      wsPath: String(ws.path ?? '').trim(),
      xhttpPath: String(xhttp.path ?? '').trim(),
      grpcServiceName: String(grpc.serviceName ?? '').trim(),
    };
  };

  const toHex = (bytes) => Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');

  const compareOutbounds = async (selected, catchAll, suppliedKey) => {
    const keyBytes = suppliedKey
      ? new Uint8Array(suppliedKey)
      : global.crypto.getRandomValues(new Uint8Array(32));
    if (keyBytes.byteLength !== 32) throw new Error('outbound evidence HMAC key must be 32 bytes');
    const key = await global.crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sign = async (canonical) => toHex(new Uint8Array(await global.crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(canonical),
    )));
    const selectedCanonical = canonicalizeOutbound(selected);
    const catchAllCanonical = canonicalizeOutbound(catchAll);
    const selectedHmac = await sign(selectedCanonical);
    const catchAllHmac = await sign(catchAllCanonical);
    return {
      selectedDescriptor: redactedOutboundDescriptor(selected),
      catchAllDescriptor: redactedOutboundDescriptor(catchAll),
      selectedHmac,
      catchAllHmac,
      objectsMatch: selectedCanonical === catchAllCanonical && selectedHmac === catchAllHmac,
    };
  };

  const api = {
    canonicalizeOutbound,
    compareOutbounds,
    redactedOutboundDescriptor,
    stableValue,
  };
  global.TachyonOutboundEvidence = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(globalThis));
