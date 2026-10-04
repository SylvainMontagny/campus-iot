const { default: Bacnet, ApplicationTag, ErrorClass, ErrorCode, ObjectType, PropertyIdentifier, getEnumName } = require("@bacnet-js/client");
const { logDeviceObject } = require("./restapi-bacnet");

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

// The client only reports BACnet errors as "BacnetError - Class:x - Code:y".
function describeError(error) {
  const message = error?.message || String(error);
  const match = message.match(/Class:(\d+) - Code:(\d+)/);
  return match ? `${describeBacnetCode(Number(match[1]), Number(match[2]))} (${message})` : message;
}

async function writeUplinkObjects(client, device, log) {
  const address = controllerAddress(device);
  const objects = objectsOf(device, "uplink");
  const results = await Promise.allSettled(
    objects.map((object) => client.writeProperty(address, objectId(object), PropertyIdentifier.PRESENT_VALUE, [toAppData(object)], {}))
  );

  let ok = true;
  results.forEach((result, index) => {
    if (result.status === "fulfilled") return;
    ok = false;
    log("error", `${device.identity.deviceName} (BACnet): Error writing BACnet object ${objects[index].objectName}: ${describeError(result.reason)}`);
  });
  if (ok) {
    log("info", `${device.identity.deviceName} (BACnet): Wrote uplink BACNet objects: ${objects.map((object) => object.objectName).join(", ")}`, undefined, "up");
  }
  return ok;
}

async function readDownlinkObjects(client, device, log) {
  const objects = objectsOf(device, "downlink");
  const request = objects.map((object) => ({
    objectId: objectId(object),
    properties: [{ id: PropertyIdentifier.PRESENT_VALUE, index: ARRAY_ALL }]
  }));

  let result;
  try {
    result = await client.readPropertyMultiple(controllerAddress(device), request);
  } catch (error) {
    log("error", `${device.identity.deviceName} (BACnet): Error reading BACnet objects: ${describeError(error)}`);
    return false;
  }

  let ok = true;
  for (const read of result?.values ?? []) {
    const object = objects.find((candidate) => candidate.objectType === read.objectId.type && candidate.instanceNum === read.objectId.instance);
    const first = read.values?.[0]?.value?.[0];
    if (!object || !first) continue;
    if (first.type === ApplicationTag.ERROR) {
      ok = false;
      log("error", `${device.identity.deviceName} (BACnet): Error reading BACnet object ${object.objectName}: ${describeBacnetCode(first.value?.errorClass, first.value?.errorCode)}`);
      continue;
    }
    object.value = object.objectType === ObjectType.ANALOG_VALUE ? Number(first.value) : first.value;
  }
  if (ok) {
    log("info", `${device.identity.deviceName} (BACnet): Read downlink BACNet objects: ${objects.map((object) => object.objectName).join(", ")}`, undefined, "down");
  }
  return ok;
}

/** Native BACnet: writes uplink objects, then reads downlink objects into device.bacnet.objects[*].value. */
async function processBacnet(device, { client, timeout = DEFAULT_TIMEOUT_MS, log = () => {} } = {}) {
  if (device?.controller?.protocol !== "bacnet") return { handled: false };

  const bacnetClient = client ?? getClient(timeout);
  const hasDownlink = objectsOf(device, "downlink").length > 0;

  if (objectsOf(device, "uplink").length > 0) {
    if (!(await writeUplinkObjects(bacnetClient, device, log))) return { handled: true, ok: false };
    logDeviceObject(log, device, "uplink");
  }
  if (hasDownlink) {
    if (!(await readDownlinkObjects(bacnetClient, device, log))) return { handled: true, ok: false };
    logDeviceObject(log, device, "downlink");
  }

  if (!hasDownlink) {
    log("info", `${device.identity.deviceName} (BACnet): TX time = ${Date.now() - device.transmitTime}ms`, undefined, "txTime");
  }
  return { handled: true, ok: true };
}

module.exports = { processBacnet };
