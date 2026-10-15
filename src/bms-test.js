const axios = require("axios");
const https = require("node:https");

const TEST_TIMEOUT_MS = 2000;
const BACNET_PORT = 47808;
const DISTECH_BASE = "/api/rest/v2";
const { getClient } = require("./bacnet-native");

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  responseType: "text",
  transformResponse: (data) => data,
  validateStatus: () => true
});

function basicAuthorization(connection) {
  return `Basic ${Buffer.from(`${connection.bacnetLogin ?? ""}:${connection.bacnetPassword ?? ""}`).toString("base64")}`;
}

// Any HTTP answer proves the server is reachable, except authentication failures.
async function testRestApiBacnet(connection, { client = httpClient, timeout = TEST_TIMEOUT_MS } = {}) {
  if (connection.model !== "distechControlsV2") throw new Error(`Unknown controller model: ${connection.model}`);
  let response;
  try {
    response = await client.request({
      method: "POST",
      url: `https://${connection.ipAddress}${DISTECH_BASE}/services/bacnet/local/objects/read-property-multiple`,
      headers: { Authorization: basicAuthorization(connection), "Content-Type": "application/json" },
      data: { encode: "text", "property-references": [{ type: "analogValue", instance: 1, property: "presentValue" }] },
      timeout
    });
  } catch (error) {
    throw new Error(`Cannot reach the BMS: ${error.code || error.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error("The BMS answered but rejected the credentials. Check login and password");
  }
  return `BMS connected (HTTP ${response.status})`;
}

// The bitstring bytes of the client hold service n at bit (n % 8), least significant bit first.
function isServiceSupported(bitstring, service) {
  const byte = bitstring?.value?.[service >> 3];
  return byte !== undefined && (byte & (1 << (service & 7))) !== 0;
}

// Returns a warning when the supported services cannot be read or lack Create/Delete Object; the connection itself is already proven.
async function checkSupportedServices(client, address, { ObjectType, PropertyIdentifier, ServicesSupported }) {
  try {
    const read = await client.readProperty(address, { type: ObjectType.DEVICE, instance: 4194303 }, PropertyIdentifier.PROTOCOL_SERVICES_SUPPORTED);
    const services = read?.values?.[0]?.value;
    if (!services?.value) return "";
    const create = isServiceSupported(services, ServicesSupported.CREATE_OBJECT);
    const remove = isServiceSupported(services, ServicesSupported.DELETE_OBJECT);
    if (create && remove) return "";
    const missing = [!create && "CreateObject", !remove && "DeleteObject"].filter(Boolean).join(" and ");
    return `BACnet communication will have some limitations (${missing} not supported by the BMS).`;
  } catch {
    return "";
  }
}

// A BACnet error or abort is still an answer from the device; only silence is a failure.
async function testBacnet(connection, { createClient, timeout = TEST_TIMEOUT_MS } = {}) {
  const bacnetLib = require("@bacnet-js/client");
  const { ObjectType, PropertyIdentifier } = bacnetLib;
  // The shared client owns UDP 47808: a second client could not receive the BMS replies.
  const client = createClient ? await createClient() : getClient(timeout);
  const ownsClient = Boolean(createClient);
  if (ownsClient) client.on?.("error", () => {});
  const address = { address: `${connection.ipAddress}:${BACNET_PORT}` };
  let timer;
  try {
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ERR_TIMEOUT")), timeout);
    });
    let reachable = "BMS connected (BACnet)";
    try {
      await Promise.race([
        client.readProperty(address, { type: ObjectType.ANALOG_VALUE, instance: 1 }, PropertyIdentifier.PRESENT_VALUE),
        timeoutPromise
      ]);
    } catch (error) {
      const message = error?.message || String(error);
      if (!/^Bacnet(Error|Abort)/.test(message)) throw error;
    }
    const warning = await checkSupportedServices(client, address, bacnetLib);
    return warning ? { message: reachable, warning } : reachable;
  } catch (error) {
    const message = error?.message || String(error);
    throw new Error(`Cannot reach the BMS: ${message === "ERR_TIMEOUT" ? "timeout" : message}`);
  } finally {
    clearTimeout(timer);
    if (ownsClient) {
      try { client.close(); } catch { /* already closed */ }
    }
  }
}

async function testBmsConnection(connection, options = {}) {
  if (!connection?.ipAddress) throw new Error("BMS IP address is required");
  if (connection.protocol === "restAPIBacnet") return testRestApiBacnet(connection, options.rest);
  if (connection.protocol === "bacnet") return testBacnet(connection, options.bacnet);
  throw new Error(`Unknown BMS protocol: ${connection.protocol}`);
}

module.exports = { testBmsConnection };
