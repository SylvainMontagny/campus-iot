const { default: Bacnet, ApplicationTag, ErrorClass, ErrorCode, ObjectType, PropertyIdentifier, getEnumName } = require("@bacnet-js/client");
const { logDeviceObject } = require("./restapi-bacnet");
const { protocolLabel } = require("./downlink");

const DEFAULT_TIMEOUT_MS = 6000;
const BACNET_PORT = 47808;
const ARRAY_ALL = 4294967295;

let sharedClient = null;

function getClient(timeout) {
  if (!sharedClient) {
    const client = new Bacnet({ apduTimeout: timeout });
    // A socket error leaves the client unusable: drop it so the next message creates a new one.
    client.on("error", () => {
      if (sharedClient === client) sharedClient = null;
      try { client.close(); } catch { /* already closed */ }
    });
    sharedClient = client;
  }
  return sharedClient;
}

function controllerAddress(device) {
  return { address: `${device.controller.ipAddress}:${BACNET_PORT}` };
}

function objectId(object) {
  return { type: object.objectType, instance: object.instanceNum };
}

function toAppData(object) {
  const value = Number(object.value);
  return object.objectType === ObjectType.ANALOG_VALUE
    ? { type: ApplicationTag.REAL, value }
    : { type: ApplicationTag.ENUMERATED, value };
}

function objectsOf(device, dataDirection) {
  return Object.values(device.bacnet.objects).filter((object) => object.dataDirection === dataDirection);
}

function describeBacnetCode(errorClass, errorCode) {
  if (errorCode === ErrorCode.UNKNOWN_OBJECT) return "The BACnet object does not exist in the controller";
  const className = getEnumName(ErrorClass, errorClass) ?? errorClass;
  const codeName = getEnumName(ErrorCode, errorCode) ?? errorCode;
  return `BACnet error ${className} / ${codeName}`;
}

function isUnknownObject(error) {
  const errorClass = error?.errorClass ?? error?.value?.errorClass;
  const errorCode = error?.errorCode ?? error?.value?.errorCode;
  if (errorCode !== undefined) {
    return Number(errorCode) === ErrorCode.UNKNOWN_OBJECT
      && (errorClass === undefined || Number(errorClass) === ErrorClass.OBJECT);
  }

  const message = error?.message || String(error);
  if (/\bunknown[\s_-]*object\b/i.test(message)) return true;
  const classMatch = message.match(/\bclass\s*[:=]?\s*(\d+)/i);
  const codeMatch = message.match(/\bcode\s*[:=]?\s*(\d+)/i);
  return classMatch?.[1] === "1" && codeMatch?.[1] === "31";
}

function isConfigurationInProgress(error) {
  const errorClass = error?.errorClass ?? error?.value?.errorClass;
  const errorCode = error?.errorCode ?? error?.value?.errorCode;
  if (errorClass !== undefined || errorCode !== undefined) {
    return Number(errorClass) === ErrorClass.DEVICE && Number(errorCode) === ErrorCode.CONFIGURATION_IN_PROGRESS;
  }

  const message = error?.message || String(error);
  const classMatch = message.match(/\bclass\s*[:=]?\s*(\d+)/i);
  const codeMatch = message.match(/\bcode\s*[:=]?\s*(\d+)/i);
  return classMatch?.[1] === "0" && codeMatch?.[1] === "2";
}

function describeError(error) {
  const message = error?.message || String(error);
  const errorClass = error?.errorClass ?? error?.value?.errorClass;
  const errorCode = error?.errorCode ?? error?.value?.errorCode;
  if (errorClass !== undefined && errorCode !== undefined) {
    const description = describeBacnetCode(Number(errorClass), Number(errorCode));
    return message === "[object Object]" ? description : `${description} (${message})`;
  }
  const match = message.match(/Class\s*[:=]?\s*(\d+).*?Code\s*[:=]?\s*(\d+)/i);
  return match ? `${describeBacnetCode(Number(match[1]), Number(match[2]))} (${message})` : message;
}

function downlinkValue(device, object, previousValues) {
  if (object.dataDirection !== "downlink") return object.value;
  const entry = Object.entries(device.bacnet.objects).find(([, candidate]) => candidate === object);
  const previous = entry && previousValues?.[device.identity.deviceName]?.bacnet?.objects?.[entry[0]]?.value;
  return previous ?? object.value;
}

async function createAndWriteObjects(client, device, objects, previousValues, log) {
  const address = controllerAddress(device);
  const names = objects.map((object) => object.objectName).join(", ");
  log("info", `${device.identity.deviceName} (${protocolLabel(device)}): Creating BACnet objects: ${names}`, undefined, "creation");

  // Each request is awaited (ACK) before the next one. Controllers reject initial values in
  // CreateObject, so the object is created bare, then named, then given its value.
  for (const object of objects) {
    try {
      await client.createObject(address, objectId(object), []);
      await client.writeProperty(
        address,
        objectId(object),
        PropertyIdentifier.OBJECT_NAME,
        [{ type: ApplicationTag.CHARACTER_STRING, value: object.objectName }],
        {}
      );
    } catch (error) {
      log("error", `${device.identity.deviceName} (${protocolLabel(device)}): Error creating BACnet object ${object.objectName}: ${describeError(error)}`);
      return false;
    }
  }

  for (const object of objects) {
    try {
      await client.writeProperty(
        address,
        objectId(object),
        PropertyIdentifier.PRESENT_VALUE,
        [toAppData({ ...object, value: downlinkValue(device, object, previousValues) })],
        {}
      );
    } catch (error) {
      log("error", `${device.identity.deviceName} (${protocolLabel(device)}): Error writing BACnet object ${object.objectName} after creation: ${describeError(error)}`);
      return false;
    }
  }
  return true;
}

async function writeUplinkObjects(client, device, previousValues, log) {
  const address = controllerAddress(device);
  const objects = objectsOf(device, "uplink");
  const results = await Promise.allSettled(
    objects.map((object) => client.writeProperty(address, objectId(object), PropertyIdentifier.PRESENT_VALUE, [toAppData(object)], {}))
  );

  const missing = [];
  let ok = true;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    if (isUnknownObject(result.reason)) {
      missing.push(objects[index]);
      return;
    }
    ok = false;
    log("error", `${device.identity.deviceName} (${protocolLabel(device)}): Error writing BACnet object ${objects[index].objectName}: ${describeError(result.reason)}`);
  });
  if (!ok) return false;
  if (missing.length > 0 && !(await createAndWriteObjects(client, device, missing, previousValues, log))) return false;

  log("info", `${device.identity.deviceName} (${protocolLabel(device)}): Wrote uplink BACNet objects: ${objects.map((object) => object.objectName).join(", ")}`, undefined, "up");
  return true;
}

async function readDownlinkObjects(client, device, previousValues, log) {
  const objects = objectsOf(device, "downlink");
  const request = objects.map((object) => ({
    objectId: objectId(object),
    properties: [{ id: PropertyIdentifier.PRESENT_VALUE, index: ARRAY_ALL }]
  }));

  let result;
  try {
    result = await client.readPropertyMultiple(controllerAddress(device), request);
  } catch (error) {
    if (isUnknownObject(error)) {
      return createAndWriteObjects(client, device, objects, previousValues, log);
    }
    log("error", `${device.identity.deviceName} (${protocolLabel(device)}): Error reading BACnet objects: ${describeError(error)}`);
    return false;
  }

  let ok = true;
  const missing = [];
  for (const read of result?.values ?? []) {
    const object = objects.find((candidate) => candidate.objectType === read.objectId.type && candidate.instanceNum === read.objectId.instance);
    const first = read.values?.[0]?.value?.[0];
    if (!object || !first) continue;
    if (first.type === ApplicationTag.ERROR) {
      if (isUnknownObject(first.value)) {
        missing.push(object);
        continue;
      }
      ok = false;
      log("error", `${device.identity.deviceName} (${protocolLabel(device)}): Error reading BACnet object ${object.objectName}: ${describeBacnetCode(first.value?.errorClass, first.value?.errorCode)}`);
      continue;
    }
    object.value = object.objectType === ObjectType.ANALOG_VALUE ? Number(first.value) : first.value;
  }
  if (missing.length > 0) {
    if (!ok) return false;
    return createAndWriteObjects(client, device, missing, previousValues, log);
  }
  if (ok) {
    log("info", `${device.identity.deviceName} (${protocolLabel(device)}): Read downlink BACNet objects: ${objects.map((object) => object.objectName).join(", ")}`, undefined, "down");
  }
  return ok;
}

/** Native BACnet: writes uplink objects, then reads downlink objects into device.bacnet.objects[*].value. */
async function processBacnet(device, { client, previousValues = {}, timeout = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  if (device?.controller?.protocol !== "bacnet") return { handled: false };

  const bacnetClient = client ?? getClient(timeout);
  const hasDownlink = objectsOf(device, "downlink").length > 0;

  if (objectsOf(device, "uplink").length > 0) {
    if (!(await writeUplinkObjects(bacnetClient, device, previousValues, log))) return { handled: true, ok: false };
    logDeviceObject(log, device, "uplink");
  }
  if (hasDownlink) {
    if (!(await readDownlinkObjects(bacnetClient, device, previousValues, log))) return { handled: true, ok: false };
    logDeviceObject(log, device, "downlink");
  }

  if (!hasDownlink) {
    log("info", `${device.identity.deviceName} (${protocolLabel(device)}): TX time = ${Date.now() - device.transmitTime}ms`, undefined, "txTime");
  }
  return { handled: true, ok: true };
}

module.exports = { processBacnet, getClient, describeError, isUnknownObject };
