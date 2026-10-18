const { resolveZones, ICAL_TO_SCHEDULE } = require("./zones-config");

const TYPE_NAMES = { 2: "analogValue", 5: "binaryValue", analogValue: "analogValue", binaryValue: "binaryValue" };

/**
 * Rows of the device profile table built from the objects read on the BMS (listBmsObjects result):
 * only the analog/binary values that match an object of the profile, one row per BACnet object.
 * A downlink object bound to a zone of the iCal configuration also gets that zone's schedule and
 * its present value, taken from the schedules read on the same BMS.
 */
function buildBmsObjectRows({ deviceProfile, definition, connectionName, bmsObjects, zonesSchedules }) {
  const bacnet = definition?.bacnet ?? {};
  const maxDevNum = definition?.identity?.maxDevNum ?? 0;

  let zones = [];
  try {
    zones = zonesSchedules ? resolveZones(zonesSchedules).filter((zone) => zone.configuration === ICAL_TO_SCHEDULE && zone.devices?.[deviceProfile]) : [];
  } catch {
    zones = [];
  }

  // "type:instance" -> profile object it stands for
  const expected = new Map();
  for (const [objectName, object] of Object.entries(bacnet.objects ?? {})) {
    const type = TYPE_NAMES[object.objectType];
    if (!type) continue;
    const offset = (type === "analogValue" ? bacnet.offsetAV : bacnet.offsetBV) ?? 0;
    const range = (type === "analogValue" ? bacnet.instanceRangeAV : bacnet.instanceRangeBV) ?? 0;
    const entries = object.assignementMode === "manual"
      ? [{ instance: object.instanceNum, deviceNum: undefined }]
      : Array.from({ length: maxDevNum }, (_, index) => ({ instance: object.instanceNum + offset + range * (index + 1), deviceNum: index + 1 }));
    for (const { instance, deviceNum } of entries) expected.set(`${type}:${instance}`, { objectName, object, deviceNum });
  }

  const scheduleValues = new Map((bmsObjects?.schedules ?? []).map((schedule) => [Number(schedule.instance), schedule.presentValue ?? ""]));
  const zoneOf = (objectName, deviceNum) => zones.find((zone) => {
    const binding = zone.devices?.[deviceProfile];
    return binding?.AVToBindName === objectName && (deviceNum === undefined || (binding.deviceNums ?? []).includes(deviceNum));
  });

  const rows = [];
  for (const value of bmsObjects?.values ?? []) {
    const match = expected.get(`${value.type}:${value.instance}`);
    if (!match) continue;
    const downlink = match.object.dataDirection === "downlink";
    const zone = downlink ? zoneOf(match.objectName, match.deviceNum) : undefined;
    rows.push({
      type: value.type,
      instance: value.instance,
      name: value.name,
      presentValue: value.presentValue ?? "",
      direction: match.object.dataDirection,
      objectName: match.objectName,
      deviceNum: match.deviceNum,
      controlledBy: zone ? { scheduleName: zone.scheduleName, presentValue: scheduleValues.get(zone.scheduleID) ?? "" } : null,
      downlinkPolicy: null
    });
  }
  applyDownlinkPolicies(rows, bacnet.objects ?? {});
  return rows;
}

const WITHIN_RANGE = "compareToUplinkObjectWithinRange";

/**
 * Marks the uplink rows targeted by a "compare with uplink object" downlink strategy:
 * "ok" when the downlink value on the BMS already matches the uplink value (no downlink scheduled),
 * "due" when it does not (a downlink will be sent). Same rules as shouldTriggerDownlink in downlink.js.
 */
function applyDownlinkPolicies(rows, objects) {
  for (const [downName, object] of Object.entries(objects)) {
    if (object.dataDirection !== "downlink" || !["compareToUplinkObject", WITHIN_RANGE].includes(object.downlinkStrategy) || !object.uplinkToCompareWith) continue;
    const [min, max] = Array.isArray(object.range) && object.range.length >= 2 ? object.range : [0, 0];
    for (const downRow of rows.filter((row) => row.objectName === downName)) {
      const upRow = rows.find((row) => row.objectName === object.uplinkToCompareWith && row.deviceNum === downRow.deviceNum);
      const up = Number(upRow?.presentValue);
      const down = Number(downRow.presentValue);
      if (!upRow || upRow.presentValue === "" || downRow.presentValue === "" || Number.isNaN(up) || Number.isNaN(down)) continue;
      const respected = object.downlinkStrategy === WITHIN_RANGE ? down >= up + min && down <= up + max : down === up;
      if (!respected) upRow.downlinkPolicy = "due";
      else upRow.downlinkPolicy ??= "ok";
    }
  }
}

module.exports = { buildBmsObjectRows };
