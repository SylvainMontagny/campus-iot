const axios = require("axios");
const https = require("node:https");
const { getClient, describeError } = require("./bacnet-native");

const TIMEOUT_MS = 8000;
const BACNET_PORT = 47808;
const DISTECH_BASE = "/api/rest/v2";
const DEVICE_WILDCARD_INSTANCE = 4194303;
const BATCH_SIZE = 20;
const MAX_OBJECTS = 5000;

const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  validateStatus: () => true
});

const WANTED_TYPES = { analogvalue: "analogValue", binaryvalue: "binaryValue", schedule: "schedule" };
const SCHEDULE_REST_PROPERTIES = ["objectName", "presentValue", "exceptionSchedule"];
const VALUE_REST_PROPERTIES = ["objectName", "presentValue"];

function canonicalType(type) {
  return WANTED_TYPES[String(type).replace(/[^a-z]/gi, "").toLowerCase()] ?? null;
}

// Flattens decoded BACnet / JSON structures into readable text (times, dates, values).
function toText(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date) return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(" ");
  if (typeof value === "object") {
    if ("year" in value && "month" in value && "day" in value) {
      const year = Number(value.year) < 1000 ? Number(value.year) + 1900 : Number(value.year);
      return `${year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
    }
    if ("value" in value && "type" in value) return toText(value.value);
    return JSON.stringify(value);
  }
  return String(value);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (number) => String(number).padStart(2, "0");
const inner = (item) => (item && typeof item === "object" && !(item instanceof Date) && "value" in item ? item.value : item);

function formatEventDate(item) {
  const date = inner(item);
  if (date instanceof Date) {
    if (date.getFullYear() < 1901) return "*";
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} (${DAY_NAMES[date.getDay()]})`;
  }
  if (Array.isArray(date)) return date.map(formatEventDate).join(" → ");
  return toText(date);
}

function formatEventTime(item) {
  const time = inner(item);
  if (time instanceof Date) return `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  return toText(time);
}

function formatEventValue(item) {
  const value = inner(item);
  return value === null || value === undefined ? "null" : toText(value);
}

// One line per exception event: "date: time → value, time → value (priority n)".
function formatExceptionSchedule(entries) {
  const list = Array.isArray(entries) && entries.length === 1 && Array.isArray(entries[0]?.value) ? entries[0].value : entries;
  if (!Array.isArray(list)) return toText(list);
  return list.map((entry) => {
    const events = (entry.events ?? []).map((event) => `${formatEventTime(event.time)} → ${formatEventValue(event.value)}`).join(", ");
    const priority = entry.priority === undefined || entry.priority === null ? "" : ` (priority ${toText(inner(entry.priority))})`;
    return `${formatEventDate(entry.date)}: ${events || "no events"}${priority}`;
  }).join("\n");
}

function splitObjects(objects) {
  const byType = (type) => objects.filter((object) => object.type === type).sort((a, b) => a.instance - b.instance);
  return {
    values: [...byType("analogValue"), ...byType("binaryValue")].map(({ type, instance, name, presentValue }) => ({ type, instance, name, presentValue })),
    schedules: byType("schedule").map(({ instance, name, presentValue, exceptionSchedule }) => ({ instance, name, presentValue, exceptionSchedule }))
  };
}

function basicAuthorization(connection) {
  return `Basic ${Buffer.from(`${connection.bacnetLogin ?? ""}:${connection.bacnetPassword ?? ""}`).toString("base64")}`;
}

// ---- REST API (Distech Controls v2) ----

// The object list may come back as {type, instance} entries or as "type,instance" strings.
function parseRestObjectId(entry) {
  if (entry && typeof entry === "object") {
    const instance = Number(entry.instance ?? entry.instanceNumber);
    const type = entry.type ?? entry.objectType;
    return type && Number.isInteger(instance) ? { type: String(type), instance } : null;
  }
  const match = /^\s*([A-Za-z][\w-]*)\s*[,:\s]\s*(\d+)\s*$/.exec(String(entry ?? ""));
  return match ? { type: match[1], instance: Number(match[2]) } : null;
}

function restRequest(connection, method, path, data, timeout) {
  return httpClient.request({
    method,
    url: `https://${connection.ipAddress}${DISTECH_BASE}${path}`,
    headers: { Authorization: basicAuthorization(connection), "Content-Type": "application/json" },
    data,
    timeout
  });
}

function restFailure(response) {
  if (response.status === 401 || response.status === 403) return "The BMS rejected the credentials. Check login and password";
  if (response.status === 404) return "The BMS does not provide this REST service (HTTP 404)";
  return `The BMS answered HTTP ${response.status}`;
}

async function readRestObjectList(connection, { client = restRequestFor, timeout }) {
  const attempts = [
    () => client(connection, "POST", "/services/bacnet/local/objects/read-property-multiple",
      { encode: "text", "property-references": [{ type: "device", instance: DEVICE_WILDCARD_INSTANCE, property: "objectList" }] }, timeout),
    () => client(connection, "GET", "/services/bacnet/local/objects", undefined, timeout)
  ];
  let lastFailure = "no answer";
  for (const attempt of attempts) {
    let response;
    try {
      response = await attempt();
    } catch (error) {
      throw new Error(`Cannot reach the BMS: ${error.code || error.message}`);
    }
    if (response.status !== 200) {
      lastFailure = restFailure(response);
      if (response.status === 401 || response.status === 403) throw new Error(lastFailure);
      continue;
    }
    const data = typeof response.data === "string" ? safeJson(response.data) : response.data;
    const entries = collectEntries(data);
    const objects = entries.map(parseRestObjectId).filter(Boolean).filter((object) => object.type !== "device");
    if (objects.length) return objects;
    lastFailure = "The BMS returned an empty object list";
  }
  throw new Error(lastFailure);
}

function restRequestFor(connection, method, path, data, timeout) {
  return restRequest(connection, method, path, data, timeout);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Some firmwares return the list as one string: "[device 1109, analog-value 10, schedule 0]".
function splitListString(text) {
  const match = /^\s*\[(.*)\]\s*$/s.exec(text);
  return match ? match[1].split(",").map((part) => part.trim()).filter(Boolean) : null;
}

function collectEntries(data) {
  if (Array.isArray(data)) {
    return data.flatMap((item) => {
      if (item && typeof item === "object" && "value" in item) {
        if (Array.isArray(item.value)) return item.value;
        if (typeof item.value === "string") return splitListString(item.value) ?? [item];
      }
      return [item];
    });
  }
  if (data && typeof data === "object") {
    for (const key of ["results", "objects", "value", "objectList"]) {
      if (Array.isArray(data[key])) return collectEntries(data[key]);
    }
  }
  return [];
}

async function enrichRestObjects(connection, objects, { client, timeout }) {
  const byKey = new Map(objects.map((object) => [`${object.restType}:${object.instance}`, object]));
  const canonicalKey = new Map(objects.map((object) => [`${object.type}:${object.instance}`, object]));
  const propertiesOf = (object) => (object.type === "schedule" ? SCHEDULE_REST_PROPERTIES : VALUE_REST_PROPERTIES);
  for (let start = 0; start < objects.length; start += BATCH_SIZE) {
    const batch = objects.slice(start, start + BATCH_SIZE);
    const references = batch.flatMap((object) => propertiesOf(object).map((property) => ({ type: object.restType, instance: object.instance, property })));
    let response;
    try {
      response = await client(connection, "POST", "/services/bacnet/local/objects/read-property-multiple", { encode: "text", "property-references": references }, timeout);
    } catch {
      continue;
    }
    if (response.status !== 200) continue;
    const data = typeof response.data === "string" ? safeJson(response.data) : response.data;
    for (const result of data?.results ?? []) {
      const object = byKey.get(`${result.type}:${result.instance}`) ?? canonicalKey.get(`${canonicalType(result.type)}:${result.instance}`);
      if (!object || result.property === undefined) continue;
      if (result.property === "objectName") object.name = toText(result.value);
      else if (result.property === "presentValue") object.presentValue = toText(result.value);
      else if (result.property === "exceptionSchedule") object.exceptionSchedule = formatExceptionSchedule(result.value);
    }
  }
}

function blankObject(type, instance, extra = {}) {
  return { type, instance, name: "", presentValue: "", exceptionSchedule: "", ...extra };
}

async function listRestObjects(connection, options = {}) {
  if (connection.model !== "distechControlsV2") throw new Error(`Unknown controller model: ${connection.model}`);
  const client = options.client ?? restRequestFor;
  const timeout = options.timeout ?? TIMEOUT_MS;
  const objects = (await readRestObjectList(connection, { client, timeout }))
    .filter((object) => canonicalType(object.type))
    .map((object) => blankObject(canonicalType(object.type), object.instance, { restType: canonicalType(object.type) }));
  await enrichRestObjects(connection, objects, { client, timeout });
  return splitObjects(objects);
}

// ---- Native BACnet ----

function valueOf(property) {
  return toText(property?.value);
}

async function readNativeObjectList(client, address, bacnet) {
  const { ObjectType, PropertyIdentifier } = bacnet;
  const deviceId = { type: ObjectType.DEVICE, instance: DEVICE_WILDCARD_INSTANCE };
  const toId = (item) => ({ type: item.value.type, instance: item.value.instance });
  try {
    const all = await client.readProperty(address, deviceId, PropertyIdentifier.OBJECT_LIST);
    return all.values.map(toId);
  } catch (error) {
    // Large lists may need segmentation: read the array element by element instead.
    const count = await client.readProperty(address, deviceId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: 0 })
      .then((result) => Number(result.values[0].value))
      .catch(() => { throw error; });
    const items = [];
    for (let index = 1; index <= Math.min(count, MAX_OBJECTS); index += 1) {
      const result = await client.readProperty(address, deviceId, PropertyIdentifier.OBJECT_LIST, { arrayIndex: index });
      items.push(toId(result.values[0]));
    }
    return items;
  }
}

function camelType(name) {
  return String(name).replace(/\(\d+\)$/, "").toLowerCase().replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
}

async function listNativeObjects(connection, { client, timeout = TIMEOUT_MS, bacnet = require("@bacnet-js/client") } = {}) {
  const { ObjectType, PropertyIdentifier, getEnumName } = bacnet;
  const ownedClient = client ?? getClient(timeout);
  const address = { address: `${connection.ipAddress}:${BACNET_PORT}` };
  let ids;
  try {
    ids = await readNativeObjectList(ownedClient, address, bacnet);
  } catch (error) {
    throw new Error(`Cannot read the object list: ${describeError(error)}`);
  }
  const objects = ids
    .map((id) => ({ id, type: canonicalType(camelType(getEnumName(ObjectType, id.type) ?? id.type)) }))
    .filter((entry) => entry.type)
    .map((entry) => blankObject(entry.type, entry.id.instance, { typeId: entry.id.type }));
  const propertyIds = (object) => (object.type === "schedule"
    ? [PropertyIdentifier.OBJECT_NAME, PropertyIdentifier.PRESENT_VALUE, PropertyIdentifier.EXCEPTION_SCHEDULE]
    : [PropertyIdentifier.OBJECT_NAME, PropertyIdentifier.PRESENT_VALUE]);
  const store = (object, id, values) => {
    if (id === PropertyIdentifier.OBJECT_NAME) object.name = toText(values);
    else if (id === PropertyIdentifier.PRESENT_VALUE) object.presentValue = toText(values);
    else if (id === PropertyIdentifier.EXCEPTION_SCHEDULE) object.exceptionSchedule = formatExceptionSchedule(values);
  };
  for (let start = 0; start < objects.length; start += BATCH_SIZE) {
    const batch = objects.slice(start, start + BATCH_SIZE);
    try {
      const result = await ownedClient.readPropertyMultiple(address, batch.map((object) => ({
        objectId: { type: object.typeId, instance: object.instance },
        properties: propertyIds(object).map((id) => ({ id, index: 0xffffffff }))
      })));
      for (const entry of result.values) {
        const object = batch.find((candidate) => candidate.typeId === entry.objectId.type && candidate.instance === entry.objectId.instance);
        if (!object) continue;
        for (const property of entry.values) store(object, property.property.id, property.value);
      }
    } catch {
      // A batch can fail as a whole (e.g. a response too large for one APDU): read its objects one by one.
      for (const object of batch) {
        for (const id of propertyIds(object)) {
          try {
            const single = await ownedClient.readProperty(address, { type: object.typeId, instance: object.instance }, id);
            store(object, id, single.values);
          } catch {
            // Leave the cell empty; the object itself is still listed.
          }
        }
      }
    }
  }
  return splitObjects(objects);
}


async function listBmsObjects(connection, options = {}) {
  if (!connection?.ipAddress) throw new Error("BMS IP address is required");
  if (connection.protocol === "restAPIBacnet") return listRestObjects(connection, options.rest);
  if (connection.protocol === "bacnet") return listNativeObjects(connection, options.bacnet);
  throw new Error(`Unknown BMS protocol: ${connection.protocol}`);
}

const REST_DELETE_SERVICES = { analogValue: "analog-values", binaryValue: "binary-values", schedule: "schedules" };

/** Deletes objects ({type, instance}) on the BMS; returns { deleted, failed: [{type, instance, error}] }. */
async function deleteBmsObjects(connection, objects, options = {}) {
  if (!connection?.ipAddress) throw new Error("BMS IP address is required");
  if (!Array.isArray(objects) || !objects.length) throw new Error("No object to delete");
  const targets = objects.map((object) => ({ type: canonicalType(object?.type), instance: Number(object?.instance) }));
  if (targets.some((target) => !target.type || !Number.isInteger(target.instance))) throw new Error("Invalid object to delete");
  const failed = [];
  let deleted = 0;
  const record = (target, error) => failed.push({ ...target, error });

  if (connection.protocol === "restAPIBacnet") {
    const client = options.rest?.client ?? restRequestFor;
    for (const target of targets) {
      try {
        const response = await client(connection, "DELETE", `/services/bacnet/local/objects/${REST_DELETE_SERVICES[target.type]}/${target.instance}`, undefined, options.rest?.timeout ?? TIMEOUT_MS);
        if (response.status >= 200 && response.status < 300) deleted += 1;
        else record(target, restFailure(response));
      } catch (error) {
        record(target, `Cannot reach the BMS: ${error.code || error.message}`);
      }
    }
  } else if (connection.protocol === "bacnet") {
    const bacnet = options.bacnet?.bacnet ?? require("@bacnet-js/client");
    const client = options.bacnet?.client ?? getClient(options.bacnet?.timeout ?? TIMEOUT_MS);
    const address = { address: `${connection.ipAddress}:${BACNET_PORT}` };
    const typeIds = { analogValue: bacnet.ObjectType.ANALOG_VALUE, binaryValue: bacnet.ObjectType.BINARY_VALUE, schedule: bacnet.ObjectType.SCHEDULE };
    for (const target of targets) {
      try {
        await client.deleteObject(address, { type: typeIds[target.type], instance: target.instance });
        deleted += 1;
      } catch (error) {
        record(target, describeError(error));
      }
    }
  } else {
    throw new Error(`Unknown BMS protocol: ${connection.protocol}`);
  }
  return { deleted, failed };
}

module.exports = { listBmsObjects, deleteBmsObjects };
