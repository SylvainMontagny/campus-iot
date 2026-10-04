const axios = require("axios");
const https = require("node:https");

const DEFAULT_TIMEOUT_MS = 5000;
const DISTECH_BASE = "/api/rest/v2";

const ERROR_MESSAGES = {
  400: "Bad HTTP Request",
  401: "Authorization error. Check login and password",
  EHOSTUNREACH: "Host unreachable. Check IP address",
  ETIMEDOUT: "Connection timeout",
  ECONNABORTED: "Check BMS IP Address",
  ECONNREFUSED: "Check BMS IP Address",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "TLS certificate could not be verified"
};

// Controllers commonly use self-signed certificates, so verification is opt-out per call.
const defaultHttpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  responseType: "text",
  transformResponse: (data) => data,
  validateStatus: () => true
});

function getAuthorization(controller) {
  if (controller.httpAuthentication) return controller.httpAuthentication;
  return `Basic ${Buffer.from(`${controller.login}:${controller.password}`).toString("base64")}`;
}

function buildRequest(controller, path, body, timeout) {
  return {
    method: "POST",
    url: `https://${controller.ipAddress}${DISTECH_BASE}${path}`,
    headers: { Authorization: getAuthorization(controller), "Content-Type": "application/json" },
    data: body,
    timeout
  };
}

function buildReadWriteRequest(device, dataDirection, timeout) {
  const references = Object.values(device.bacnet.objects)
    .filter((object) => object.dataDirection === dataDirection)
    .map((object) => {
      const reference = { type: object.objectType, instance: object.instanceNum, property: "presentValue" };
      if (dataDirection === "uplink") reference.value = object.value;
      return reference;
    });
  const service = dataDirection === "uplink" ? "write-property-multiple" : "read-property-multiple";
  return buildRequest(
    device.controller,
    `/services/bacnet/local/objects/${service}`,
    { encode: "text", "property-references": references },
    timeout
  );
}

function buildCreateRequest(device, timeout) {
  const requests = Object.values(device.bacnet.objects).map((object, index) => ({
    id: String(index + 1),
    method: "POST",
    url: `${DISTECH_BASE}/services/bacnet/local/objects/add`,
    body: { "object-type": object.objectType, "instance-number": object.instanceNum, name: object.objectName }
  }));
  return buildRequest(device.controller, "/batch", { requests }, timeout);
}

// Downlink objects are written with their last known value, if any.
function buildWriteValuesRequest(device, previousValues, timeout) {
  const references = Object.values(device.bacnet.objects).map((object) => {
    let value = object.value;
    if (object.dataDirection === "downlink") {
      const previous = previousValues?.[device.identity.deviceName]?.bacnet?.objects?.[object.objectName]?.value;
      value = previous ?? value;
    }
    return { type: object.objectType, instance: object.instanceNum, property: "presentValue", value };
  });
  return buildRequest(
    device.controller,
    "/services/bacnet/local/objects/write-property-multiple",
    { encode: "text", "property-references": references },
    timeout
  );
}

async function send(httpClient, request) {
  try {
    const response = await httpClient.request(request);
    return { status: response.status, data: typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "") };
  } catch (error) {
    return { status: error.code || "UNKNOWN", data: "", message: error.message };
  }
}

function describeFailure(response, url) {
  if (response.status === 404) return `Invalid URL: '${url}'`;
  if (response.status === 400) {
    const extra = response.data.includes("write-access-denied") ? " - Trying to write a Read Only object (analogInput)" : "";
    return `${ERROR_MESSAGES[400]}${extra}`;
  }
  const detail = response.message ? ` (${response.message})` : "";
  return `${ERROR_MESSAGES[response.status] || `Unknown error ${response.status}`}${detail}`;
}

function storeDownlinkValues(device, payload) {
  const parsed = JSON.parse(payload);
  for (const result of parsed.results ?? []) {
    for (const object of Object.values(device.bacnet.objects)) {
      if (result.type !== object.objectType || result.instance !== object.instanceNum) continue;
      if (object.objectType === "analogValue") object.value = Number(result.value);
      else if (object.objectType === "binaryValue") object.value = result.value;
    }
  }
}

// Returns true when the stream completed without error.
async function runStream(device, dataDirection, ctx) {
  const { httpClient, previousValues, timeout, log } = ctx;
  const name = device.identity.deviceName;

  const request = buildReadWriteRequest(device, dataDirection, timeout);
  const response = await send(httpClient, request);

  if (response.status !== 200) {
    log("error", `${name} (RestAPI, ${dataDirection}): ${describeFailure(response, request.url)}`);
    return false;
  }

  if (response.data.includes("Unknown Object")) {
    const allNames = Object.values(device.bacnet.objects).map((object) => object.objectName).join(", ");
    log("info", `${name} (RestAPI, ${dataDirection}): Creating BACnet objects: ${allNames}`, undefined, "creation");
    const created = await send(httpClient, buildCreateRequest(device, timeout));
    if (created.status !== 200) {
      log("error", `${name} (RestAPI): Object creation failed: ${describeFailure(created, request.url)}`);
      return false;
    }
    const written = await send(httpClient, buildWriteValuesRequest(device, previousValues, timeout));
    if (written.status !== 200) {
      log("error", `${name} (RestAPI): Writing values after creation failed: ${describeFailure(written, request.url)}`);
      return false;
    }
    return true;
  }

  if (dataDirection === "downlink") {
    try {
      storeDownlinkValues(device, response.data);
    } catch (error) {
      log("error", `${name} (RestAPI): Invalid downlink response: ${error.message}`);
      return false;
    }
  }
  const names = Object.values(device.bacnet.objects)
    .filter((object) => object.dataDirection === dataDirection)
    .map((object) => object.objectName)
    .join(", ");
  log("info", `${name} (RestAPI): ${dataDirection === "uplink" ? "Wrote uplink BACNet objects" : "Read downlink BACNet objects"}: ${names}`, undefined, dataDirection === "uplink" ? "up" : "down");
  return true;
}

function logDeviceObject(log, device, dataDirection) {
  const label = dataDirection === "uplink" ? "uplink" : "downlink";
  log("output", `Device object after ${label} process:\n${JSON.stringify(device, null, 2)}`, structuredClone(device), dataDirection === "uplink" ? "deviceUplink" : "deviceDownlink");
}

/**
 * Uplink stream (write), then downlink stream (read + store) if the device has downlink objects.
 * Mutates device.bacnet.objects[*].value with downlink values read from the controller.
 */
async function processRestApiBacnet(device, { httpClient = defaultHttpClient, previousValues = {}, timeout = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  if (device?.controller?.protocol !== "restAPIBacnet") return { handled: false };
  if (device.controller.model !== "distechControlsV2") {
    log("error", `${device.identity.deviceName}: Unknown controller model: ${device.controller.model}`);
    return { handled: true, ok: false };
  }

  const ctx = { httpClient, previousValues, timeout, log };
  const objects = Object.values(device.bacnet.objects);

  if (objects.some((object) => object.dataDirection === "uplink")) {
    if (!(await runStream(device, "uplink", ctx))) return { handled: true, ok: false };
    logDeviceObject(log, device, "uplink");
  }
  if (objects.some((object) => object.dataDirection === "downlink")) {
    if (!(await runStream(device, "downlink", ctx))) return { handled: true, ok: false };
    logDeviceObject(log, device, "downlink");
  }

  log("info", `${device.identity.deviceName} (RestAPI): TX time = ${Date.now() - device.transmitTime}ms`, undefined, "txTime");
  return { handled: true, ok: true };
}

module.exports = { processRestApiBacnet, buildReadWriteRequest, buildCreateRequest, buildWriteValuesRequest };
