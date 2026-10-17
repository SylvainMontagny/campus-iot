const os = require("node:os");
const { getClient, describeError } = require("./bacnet-native");

const DISCOVERY_WINDOW_MS = 3000;
const NAME_TIMEOUT_MS = 4000;
const BACNET_PORT = 47808;

const hostOf = (address) => String(address ?? "").replace(/:\d+$/, "");

const toInt = (ip) => ip.split(".").reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0);
const toIp = (int) => [24, 16, 8, 0].map((shift) => (int >>> shift) & 255).join(".");

/** Directed broadcast address of every usable IPv4 interface (the OS would otherwise pick one interface for 255.255.255.255). */
function localBroadcastAddresses(interfaces = os.networkInterfaces()) {
  const result = new Set();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal || entry.address.startsWith("169.254.")) continue;
      result.add(toIp((toInt(entry.address) | (~toInt(entry.netmask) >>> 0)) >>> 0));
    }
  }
  return [...result];
}

/** Broadcasts a Who-Is and returns [{ deviceName, ipAddress, deviceId }] for every device that answers, sorted by name. */
async function discoverBmsDevices({ client, bacnet, broadcastAddresses, windowMs = DISCOVERY_WINDOW_MS, nameTimeout = NAME_TIMEOUT_MS } = {}) {
  const { ObjectType, PropertyIdentifier } = bacnet ?? require("@bacnet-js/client");
  let ownedClient;
  try {
    ownedClient = client ?? getClient();
  } catch (error) {
    throw new Error(`Cannot send the Who-Is: ${describeError(error)}`);
  }

  const found = new Map();
  const onIAm = (content) => {
    const payload = content?.payload;
    if (!payload || !Number.isInteger(payload.deviceId)) return;
    const address = payload.address ?? content.header?.sender?.address;
    found.set(`${address}|${payload.deviceId}`, { address: String(address ?? ""), deviceId: payload.deviceId });
  };
  ownedClient.on("iAm", onIAm);
  try {
    const broadcasts = broadcastAddresses ?? localBroadcastAddresses();
    if (broadcasts.length) broadcasts.forEach((address) => ownedClient.whoIs({ address, distributeBroadcastToNetwork: true }));
    else ownedClient.whoIs();
    await new Promise((resolve) => setTimeout(resolve, windowMs));
  } finally {
    ownedClient.removeListener("iAm", onIAm);
  }

  const devices = await Promise.all([...found.values()].map(async ({ address, deviceId }) => {
    let deviceName = "";
    try {
      const target = { address: address.includes(":") ? address : `${address}:47808` };
      const result = await Promise.race([
        ownedClient.readProperty(target, { type: ObjectType.DEVICE, instance: deviceId }, PropertyIdentifier.OBJECT_NAME),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), nameTimeout))
      ]);
      deviceName = String(result.values?.[0]?.value ?? "");
    } catch {
      // The device answered the Who-Is but did not give its name.
    }
    return { deviceName, ipAddress: hostOf(address), deviceId };
  }));
  return devices.sort((a, b) => a.deviceName.localeCompare(b.deviceName, undefined, { numeric: true }) || a.deviceId - b.deviceId);
}

module.exports = { discoverBmsDevices, localBroadcastAddresses };
