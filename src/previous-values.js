const { readSchedulePresentValues } = require("./bms-objects");
const { resolveZones, ICAL_TO_SCHEDULE } = require("./zones-config");

const TYPE_NAMES = { 2: "analogValue", 5: "binaryValue", analogValue: "analogValue", binaryValue: "binaryValue" };

/**
 * Rows of the previousValues table for one device profile: one per BACnet object of each device that sent data.
 * A downlink object bound to a zone of the iCal configuration also gets that zone's schedule and its present value.
 */
async function buildPreviousValuesRows({ deviceProfile, entries, zonesSchedules, connections = {}, readSchedules = readSchedulePresentValues }) {
  let zones = [];
  try {
    zones = zonesSchedules ? resolveZones(zonesSchedules).filter((zone) => zone.configuration === ICAL_TO_SCHEDULE) : [];
  } catch {
    zones = [];
  }
  const scheduleOf = (device, objectName) => zones.find((zone) => {
    const binding = zone.devices?.[deviceProfile];
    return binding?.AVToBindName === objectName && (binding.deviceNums ?? []).includes(device.identity?.deviceNum);
  });

  const rows = [];
  for (const device of entries) {
    for (const [objectName, object] of Object.entries(device.bacnet?.objects ?? {})) {
      const zone = object.dataDirection === "downlink" ? scheduleOf(device, objectName) : undefined;
      rows.push({
        deviceName: device.identity?.deviceName ?? "",
        type: TYPE_NAMES[object.objectType] ?? String(object.objectType ?? ""),
        instance: object.instanceNum,
        name: object.objectName ?? objectName,
        presentValue: object.value === undefined ? "" : String(object.value),
        direction: object.dataDirection,
        controlledBy: zone ? { scheduleName: zone.scheduleName, connectionName: zone.connectionName, scheduleID: zone.scheduleID, presentValue: "" } : null
      });
    }
  }

  const wanted = new Map();
  for (const { controlledBy } of rows) {
    if (controlledBy) wanted.set(controlledBy.connectionName, new Set([...(wanted.get(controlledBy.connectionName) ?? []), controlledBy.scheduleID]));
  }
  const valuesByConnection = new Map();
  await Promise.all([...wanted].map(async ([connectionName, instances]) => {
    valuesByConnection.set(connectionName, await readSchedules(connections[connectionName], [...instances]).catch(() => new Map()));
  }));
  for (const { controlledBy } of rows) {
    if (!controlledBy) continue;
    controlledBy.presentValue = valuesByConnection.get(controlledBy.connectionName)?.get(controlledBy.scheduleID) ?? "";
    delete controlledBy.connectionName;
    delete controlledBy.scheduleID;
  }
  return rows;
}

module.exports = { buildPreviousValuesRows };
