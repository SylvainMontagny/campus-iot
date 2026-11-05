const axios = require("axios");
const https = require("node:https");
const { logDeviceObject } = require("../../diagnostics");
const { protocolLabel } = require("../../../lorawan-to-bacnet/downlink");

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

// Distech REST adapter: selects a configured authorization header or builds Basic authentication.
function getAuthorization(controller) {
  if (controller.httpAuthentication) return controller.httpAuthentication;
  return `Basic ${Buffer.from(`${controller.login}:${controller.password}`).toString("base64")}`;
}

// Distech REST adapter: builds the common authenticated HTTP request to the controller API.
function buildRequest(controller, path, body, timeout) {
  return {
    method: "POST",
    url: `https://${controller.ipAddress}${DISTECH_BASE}${path}`,
    headers: { Authorization: getAuthorization(controller), "Content-Type": "application/json" },
    data: body,
    timeout
  };
}

// Distech REST adapter: builds the BACnet REST request for a device's uplink writes or downlink reads.
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

// Distech REST adapter: builds a batch request to create the device profile's BACnet objects.
function buildCreateRequest(device, timeout) {
  const requests = Object.values(device.bacnet.objects).map((object, index) => ({
    id: String(index + 1),
    method: "POST",
    url: `${DISTECH_BASE}/services/bacnet/local/objects/add`,
    body: { "object-type": object.objectType, "instance-number": object.instanceNum, name: object.objectName }
  }));
  return buildRequest(device.controller, "/batch", { requests }, timeout);
}

// Distech REST adapter: initializes downlink objects from a controlling schedule, last known value, or profile default.
function buildWriteValuesRequest(device, previousValues, timeout, initialValues = {}) {
  const references = Object.entries(device.bacnet.objects).map(([key, object]) => {
    let value = object.value;
    if (object.dataDirection === "downlink") {
      const previous = previousValues?.[device.identity.deviceName]?.bacnet?.objects?.[key]?.value;
      value = initialValues[key] ?? previous ?? value;
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

// Distech REST adapter: executes an HTTP request and normalizes transport failures into a response shape.
async function send(httpClient, request) {
  try {
    const response = await httpClient.request(request);
    return { status: response.status, data: typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "") };
  } catch (error) {
    return { status: error.code || "UNKNOWN", data: "", message: error.message };
  }
}

// Distech REST adapter: translates HTTP and transport errors into actionable BMS log messages.
function describeFailure(response, url) {
  if (response.status === 404) return `Invalid URL: '${url}'`;
  if (response.status === 400) {
    const extra = response.data.includes("write-access-denied") ? " - Trying to write a Read Only object (analogInput)" : "";
    return `${ERROR_MESSAGES[400]}${extra}`;
  }
  const detail = response.message ? ` (${response.message})` : "";
  return `${ERROR_MESSAGES[response.status] || `Unknown error ${response.status}`}${detail}`;
}

// Distech REST adapter: copies values returned by the BMS into the device's mapped downlink objects.
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

// Distech REST adapter: runs one uplink-write or downlink-read phase, creating missing BACnet objects if needed.
async function runStream(device, dataDirection, ctx) {
  const { httpClient, previousValues, timeout, log, getInitialValues } = ctx;
  const name = device.identity.deviceName;

  const request = buildReadWriteRequest(device, dataDirection, timeout);
  const response = await send(httpClient, request);

  if (response.status !== 200) {
    log("error", `${name} (${protocolLabel(device)}, ${dataDirection}): ${describeFailure(response, request.url)}`);
    return false;
  }

  if (response.data.includes("Unknown Object")) {
    const allNames = Object.values(device.bacnet.objects).map((object) => object.objectName).join(", ");
    log("info", `${name} (${protocolLabel(device)}, ${dataDirection}): Creating BACnet objects: ${allNames}`, undefined, "creation");
    const created = await send(httpClient, buildCreateRequest(device, timeout));
    if (created.status !== 200) {
      log("error", `${name} (${protocolLabel(device)}): Object creation failed: ${describeFailure(created, request.url)}`);
      return false;
    }
    const initialValues = await getInitialValues?.(device).catch(() => ({})) ?? {};
    const written = await send(httpClient, buildWriteValuesRequest(device, previousValues, timeout, initialValues));
    if (written.status !== 200) {
      log("error", `${name} (${protocolLabel(device)}): Writing values after creation failed: ${describeFailure(written, request.url)}`);
      return false;
    }
    if (dataDirection !== "downlink") return true;

    // Read the objects again so the downlink decision uses the values that were just written.
    const reread = await send(httpClient, request);
    if (reread.status !== 200 || reread.data.includes("Unknown Object")) {
      log("error", `${name} (${protocolLabel(device)}, ${dataDirection}): Reading the created objects failed: ${describeFailure(reread, request.url)}`);
      return false;
    }
    try {
      storeDownlinkValues(device, reread.data);
    } catch (error) {
      log("error", `${name} (${protocolLabel(device)}): Invalid downlink response: ${error.message}`);
      return false;
    }
    return true;
  }

  if (dataDirection === "downlink") {
    try {
      storeDownlinkValues(device, response.data);
    } catch (error) {
      log("error", `${name} (${protocolLabel(device)}): Invalid downlink response: ${error.message}`);
      return false;
    }
  }
  const names = Object.values(device.bacnet.objects)
    .filter((object) => object.dataDirection === dataDirection)
    .map((object) => object.objectName)
    .join(", ");
  log("info", `${name} (${protocolLabel(device)}): ${dataDirection === "uplink" ? "Wrote uplink BACNet objects" : "Read downlink BACNet objects"}: ${names}`, undefined, dataDirection === "uplink" ? "up" : "down");
  return true;
}

// MQTT diagnostics: records a snapshot of a device after its REST BACnet operation.
/**
 * Distech REST adapter: writes uplink values, then reads downlink values into the mapped device objects.
 */
async function processRestApiBacnet(device, { httpClient = defaultHttpClient, previousValues = {}, timeout = DEFAULT_TIMEOUT_MS, log = () => {}, getInitialValues } = {}) {
  if (device?.controller?.protocol !== "restAPIBacnet") return { handled: false };
  if (device.controller.model !== "distechControlsV2") {
    log("error", `${device.identity.deviceName}: Unknown controller model: ${device.controller.model}`);
    return { handled: true, ok: false };
  }

  const ctx = { httpClient, previousValues, timeout, log, getInitialValues };
  const objects = Object.values(device.bacnet.objects);

  if (objects.some((object) => object.dataDirection === "uplink")) {
    if (!(await runStream(device, "uplink", ctx))) return { handled: true, ok: false };
    logDeviceObject(log, device, "uplink");
  }
  if (objects.some((object) => object.dataDirection === "downlink")) {
    if (!(await runStream(device, "downlink", ctx))) return { handled: true, ok: false };
    logDeviceObject(log, device, "downlink");
  }

  // With downlink objects, TX time is logged once the downlink has been prepared.
  if (!objects.some((object) => object.dataDirection === "downlink")) {
    log("info", `${device.identity.deviceName} (${protocolLabel(device)}): TX time = ${Date.now() - device.transmitTime}ms`, undefined, "txTime");
  }
  return { handled: true, ok: true };
}

module.exports = { processRestApiBacnet, buildReadWriteRequest, buildCreateRequest, buildWriteValuesRequest };
