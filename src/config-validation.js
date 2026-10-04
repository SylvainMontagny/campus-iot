const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const OBJECT_TYPES = new Set(["analogValue", "binaryValue"]);
const DIRECTIONS = new Set(["uplink", "downlink"]);
const ASSIGNMENT_MODES = new Set(["auto", "manual"]);
const DOWNLINK_STRATEGIES = new Set([
  "compareToUplinkObject",
  "compareToUplinkObjectWithinRange",
  "onChangeOfThisValue",
  "onChangeOfThisValueWithinRange"
]);

function issue(message, path) {
  return { message, path };
}

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [issue("Configuration must be a JSON object", "")];
  }

  const deviceList = config.deviceList;
  if (!deviceList || typeof deviceList !== "object" || Array.isArray(deviceList)) {
    return [issue("Device list must be an object", "deviceList")];
  }

  const connections = config.connections || {};
  const deviceConnections = config.deviceConnections || {};
  if (typeof connections !== "object" || Array.isArray(connections)) {
    errors.push(issue("Connection profiles must be an object", "connections"));
  }
  if (typeof deviceConnections !== "object" || Array.isArray(deviceConnections)) {
    errors.push(issue("Device connection assignments must be an object", "deviceConnections"));
  }

  const devices = Object.entries(deviceList);
  for (const [deviceName, connectionName] of Object.entries(deviceConnections)) {
    if (connectionName && !Object.hasOwn(connections, connectionName)) {
      errors.push(issue(`Connection profile '${connectionName}' does not exist`, `deviceConnections.${deviceName}`));
    }
  }

  for (const [deviceName, device] of devices) {
    const devicePath = `deviceList.${deviceName}`;
    if (/\s/.test(deviceName)) errors.push(issue("Device type names cannot contain spaces", devicePath));
    const bacnet = device?.bacnet;
    const objects = bacnet?.objects;

    if (!device || typeof device !== "object" || !bacnet || typeof bacnet !== "object" || !objects || typeof objects !== "object" || Array.isArray(objects)) {
      errors.push(issue("Device must contain a BACnet object map", devicePath));
      continue;
    }

    if (!Number.isInteger(device.identity?.maxDevNum) || device.identity.maxDevNum < 1) {
      errors.push(issue("Maximum device number must be a positive whole number", `${devicePath}.identity.maxDevNum`));
    }
    if (!IPV4_PATTERN.test(device.controller?.ipAddress || "")) {
      errors.push(issue("Enter a valid BMS IPv4 address", `${devicePath}.controller.ipAddress`));
    }

    for (const field of ["offsetAV", "offsetBV", "instanceRangeAV", "instanceRangeBV"]) {
      if (!Number.isInteger(bacnet[field]) || bacnet[field] < 0) {
        errors.push(issue(`${field} must be a non-negative whole number`, `${devicePath}.bacnet.${field}`));
      }
    }

    const uplinkNames = new Set(
      Object.entries(objects)
        .filter(([, object]) => object?.dataDirection === "uplink")
        .map(([name]) => name)
    );
    const assignmentModes = new Set();
    const instanceNumbers = { analogValue: new Set(), binaryValue: new Set() };

    for (const [objectName, object] of Object.entries(objects)) {
      const objectPath = `${devicePath}.bacnet.objects.${objectName}`;
      if (!object || typeof object !== "object") {
        errors.push(issue("Object configuration must be an object", objectPath));
        continue;
      }

      if (!OBJECT_TYPES.has(object.objectType)) errors.push(issue("Choose a supported BACnet object type", `${objectPath}.objectType`));
      if (/\s/.test(objectName)) errors.push(issue("Object names cannot contain spaces", objectPath));
      if (/\s/.test(String(object.lorawanPayloadName ?? ""))) errors.push(issue("LoRaWAN payload names cannot contain spaces", `${objectPath}.lorawanPayloadName`));
      if (!DIRECTIONS.has(object.dataDirection)) errors.push(issue("Choose uplink or downlink", `${objectPath}.dataDirection`));
      if (!ASSIGNMENT_MODES.has(object.assignementMode)) errors.push(issue("Choose auto or manual instance assignment", `${objectPath}.assignementMode`));
      if (!Number.isInteger(object.instanceNum) || object.instanceNum < 0) errors.push(issue("Instance number must be a non-negative whole number", `${objectPath}.instanceNum`));
      assignmentModes.add(object.assignementMode);

      if (object.dataDirection === "downlink") {
        if (!Number.isInteger(object.downlinkPort) || object.downlinkPort < 0 || object.downlinkPort > 255) {
          errors.push(issue("Downlink FPort must be a whole number from 0 to 255", `${objectPath}.downlinkPort`));
        }
        if (!DOWNLINK_STRATEGIES.has(object.downlinkStrategy)) errors.push(issue("Choose a supported downlink strategy", `${objectPath}.downlinkStrategy`));
        if (["compareToUplinkObject", "compareToUplinkObjectWithinRange"].includes(object.downlinkStrategy) && !uplinkNames.has(object.uplinkToCompareWith)) {
          errors.push(issue("Comparison target must name an uplink object", `${objectPath}.uplinkToCompareWith`));
        }
        if (object.downlinkStrategy?.endsWith("WithinRange") && (!Array.isArray(object.range) || object.range.length !== 2 || !object.range.every(Number.isFinite) || object.range[1] < object.range[0])) {
          errors.push(issue("Range must contain two numbers in ascending order", `${objectPath}.range`));
        }
      }

      if (OBJECT_TYPES.has(object.objectType) && object.assignementMode === "manual" && Number.isInteger(object.instanceNum)) {
        const used = instanceNumbers[object.objectType];
        if (used.has(object.instanceNum)) errors.push(issue("Manual instance number is already used for this object type", `${objectPath}.instanceNum`));
        used.add(object.instanceNum);
      }
    }

    if (assignmentModes.size > 1) errors.push(issue("All objects on a device must use the same assignment mode", `${devicePath}.bacnet.objects`));
  }

  for (const kind of ["AV", "BV"]) {
    const objectType = kind === "AV" ? "analogValue" : "binaryValue";
    const manualInstances = devices.flatMap(([deviceName, device]) =>
      Object.entries(device?.bacnet?.objects || {})
        .filter(([, object]) => object?.objectType === objectType && object.assignementMode === "manual")
        .map(([objectName, object]) => ({ deviceName, objectName, instanceNum: object.instanceNum }))
    );
    const allocations = devices.map(([name, device]) => {
      const bacnet = device?.bacnet || {};
      const offset = bacnet[`offset${kind}`];
      const range = bacnet[`instanceRange${kind}`];
      const maxDevices = device?.identity?.maxDevNum;
      return { name, start: offset + range, end: offset + range * (maxDevices + 1) };
    }).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));

    allocations.sort((left, right) => left.start - right.start);
    for (let index = 1; index < allocations.length; index += 1) {
      if (allocations[index - 1].end > allocations[index].start) {
        errors.push(issue(`${kind === "AV" ? "Analog" : "Binary"} instance ranges overlap between ${allocations[index - 1].name} and ${allocations[index].name}`, "deviceList"));
      }
    }

    for (const allocation of allocations) {
      for (const manual of manualInstances) {
        if (manual.instanceNum >= allocation.start && manual.instanceNum < allocation.end) {
          errors.push(issue(`Manual instance ${manual.instanceNum} for ${manual.objectName} overlaps ${allocation.name}'s automatic range`, `deviceList.${manual.deviceName}.bacnet.objects.${manual.objectName}.instanceNum`));
        }
      }
    }
  }

  return errors;
}

module.exports = { validateConfig };