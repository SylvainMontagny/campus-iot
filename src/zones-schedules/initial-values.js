const { resolveZones, ICAL_TO_SCHEDULE } = require("./configuration");
const { readSchedulePresentValues } = require("../bms-connections/objects");

/**
 * Downlink initialization: gets a zone schedule's current value for each mapped device object it controls.
 * Initial values of the downlink objects of a device that are controlled by a zone of the iCal
 * configuration: the present value of the zone's schedule on the device's BMS.
 * Returns { objectKey: value }; objects that are not controlled, or whose schedule cannot be read, are left out
 * so that the caller falls back to the device profile default.
 */
async function scheduleInitialValues(device, { zonesSchedules, deviceProfiles, connections, readValues = readSchedulePresentValues } = {}) {
  if (!zonesSchedules?.zones?.length) return {};
  const { deviceProfile, deviceNum } = device.identity;
  const connection = connections?.[device.controller?.connectionName];
  if (!connection) return {};

  let zones;
  try {
    zones = resolveZones(zonesSchedules, deviceProfiles).filter((zone) => zone.configuration === ICAL_TO_SCHEDULE && !zone.excluded);
  } catch {
    return {};
  }

  const scheduleOfObject = new Map();
  for (const zone of zones) {
    const binding = zone.devices?.[deviceProfile];
    const key = binding?.AVToBindName;
    if (!key || !(binding.deviceNums ?? []).includes(deviceNum) || device.bacnet.objects[key]?.dataDirection !== "downlink") continue;
    scheduleOfObject.set(key, zone.scheduleID);
  }
  if (!scheduleOfObject.size) return {};

  const values = await readValues(connection, [...new Set(scheduleOfObject.values())]);
  const initial = {};
  for (const [key, scheduleID] of scheduleOfObject) {
    const text = values.get(scheduleID);
    const value = text === undefined || text === "" ? NaN : Number(text);
    if (Number.isFinite(value)) initial[key] = value;
  }
  return initial;
}

module.exports = { scheduleInitialValues };
