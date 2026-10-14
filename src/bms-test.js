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

// A BACnet error or abort is still an answer from the device; only silence is a failure.
async function testBacnet(connection, { createClient, timeout = TEST_TIMEOUT_MS } = {}) {
  const { ObjectType, PropertyIdentifier } = require("@bacnet-js/client");
  // The shared client owns UDP 47808: a second client could not receive the BMS replies.
  const client = createClient ? await createClient() : getClient(timeout);
  const ownsClient = Boolean(createClient);
  client.on?.("error", () => {});
  let timer;
  try {
    const timeoutPromise = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("ERR_TIMEOUT")), timeout);
    });
    await Promise.race([
      client.readProperty({ address: `${connection.ipAddress}:${BACNET_PORT}` }, { type: ObjectType.ANALOG_VALUE, instance: 1 }, PropertyIdentifier.PRESENT_VALUE),
      timeoutPromise
    ]);
    return "BMS connected (BACnet)";
  } catch (error) {
    const message = error?.message || String(error);
    if (/^Bacnet(Error|Abort)/.test(message)) return `BMS connected  (BACnet)`;
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
