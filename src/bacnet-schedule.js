const { ApplicationTag, ObjectType, PropertyIdentifier, ASN1_ARRAY_ALL, ASN1_NO_PRIORITY } = require("@bacnet-js/client");
const asn1 = require("@bacnet-js/client/dist/lib/asn1");
const { getClient, describeError, isUnknownObject } = require("./bacnet-native");

// The client cannot encode BACnetDeviceObjectPropertyReference values (LIST_OF_OBJECT_PROPERTY_REFERENCES) when writing.
// Local references (no device) are encoded as: [0] objectId, [1] propertyId.
if (!asn1.bacappEncodeApplicationData.supportsObjectPropertyReference) {
  const encodeApplicationData = asn1.bacappEncodeApplicationData;
  asn1.bacappEncodeApplicationData = (buffer, value) => {
    if (value?.type !== ApplicationTag.DEVICE_OBJECT_PROPERTY_REFERENCE) return encodeApplicationData(buffer, value);
    asn1.encodeContextObjectId(buffer, 0, value.value.objectId.type, value.value.objectId.instance);
    asn1.encodeContextEnumerated(buffer, 1, value.value.propertyId);
  };
  asn1.bacappEncodeApplicationData.supportsObjectPropertyReference = true;
}

const BACNET_PORT = 47808;
const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const real = (value) => ({ type: ApplicationTag.REAL, value: Number(value) });
const nullValue = () => ({ type: ApplicationTag.NULL, value: null });
const string = (value) => ({ type: ApplicationTag.CHARACTER_STRING, value: String(value) });

// The BACnet client encodes times from the local clock fields of a Date.
function timeToDate(time) {
  const [hours, minutes, seconds] = String(time).split(":");
  return new Date(2000, 0, 1, Number(hours), Number(minutes), Math.floor(Number(seconds || 0)));
}

function transitionsToEntries(transitions) {
  return Object.values(transitions ?? {})
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map((transition) => ({
      time: timeToDate(transition.time),
      value: transition.value === null ? nullValue() : real(transition.value)
    }));
}

/** zone.weekly ({monday: {transitions}}) -> BACnet WEEKLY_SCHEDULE payload (Monday first). */
function toWeeklySchedule(weekly = {}) {
  return DAYS.map((day) => transitionsToEntries(weekly[day]?.transitions));
}

/** buildSpecialEvents() result -> BACnet EXCEPTION_SCHEDULE payload. */
function toExceptionSchedule(special) {
  return Object.values(special).map((event) => {
    const { year, month, "day-of-month": day } = event.period.date;
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
    return {
      date: { type: ApplicationTag.DATE, value: { year: year - 1900, month, day, wday: weekday } },
      events: transitionsToEntries(event.transitions),
      priority: event["event-priority"]
    };
  });
}

const scheduleId = (instance) => ({ type: ObjectType.SCHEDULE, instance });
const analogValueId = (instance) => ({ type: ObjectType.ANALOG_VALUE, instance });

/** Schedule operations over native BACnet (bacnet-js), mirroring the REST API operations of ical-schedule.js. */
function createNativeScheduleDriver(connection, { client, log = () => {}, deviceProfiles = {} } = {}) {
  const address = { address: `${connection.ipAddress}:${BACNET_PORT}` };
  const bacnet = () => client ?? getClient();

  const write = (objectId, property, values, options = {}) => bacnet().writeProperty(address, objectId, property, values, options);

  async function settleAll(label, tasks) {
    const results = await Promise.allSettled(tasks.map((task) => task()));
    results.forEach((result) => {
      if (result.status === "rejected") log("error", `${label}: ${describeError(result.reason)}`);
    });
  }

  // Deleting an object that does not exist is expected on a first start.
  const remove = (objectId) => bacnet().deleteObject(address, objectId).catch(() => {});

  // index/priority are explicit because the client otherwise encodes them as 0, which controllers reject (Class:0 Code:2).
  const create = (objectId, name) => bacnet().createObject(address, objectId, [
    { property: { id: PropertyIdentifier.OBJECT_NAME, index: ASN1_ARRAY_ALL }, value: [string(name)], priority: ASN1_NO_PRIORITY }
  ]);

  // Same defaults as at startup, also used to rebuild a schedule that disappeared from the BMS.
  async function initializeSchedule(zone, profiles) {
    const id = scheduleId(zone.scheduleID);
    await settleAll("Schedule setup", [
      () => write(id, PropertyIdentifier.SCHEDULE_DEFAULT, [real(19)]),
      () => write(id, PropertyIdentifier.DESCRIPTION, [string(`Zone ${zone.scheduleName}`)]),
      ...(Object.keys(zone.devices ?? {}).length ? [() => writeReferences(zone, profiles)] : [])
    ]);
  }

  async function setupSchedules(zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    for (let i = min; i <= max; i++) await remove(scheduleId(i));
    for (const zone of zones) await create(scheduleId(zone.scheduleID), zone.scheduleName);
    await settleAll("Schedule setup", zones.flatMap((zone) => [
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.SCHEDULE_DEFAULT, [real(19)]),
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.DESCRIPTION, [string(`Zone ${zone.scheduleName}`)])
    ]));
  }

  // The schedule drives the AVToBindName (downlink) objects of its zone devices through its list of object property references.
  function writeReferences(zone, profiles) {
    const references = boundObjects(zone, profiles).map((instance) => ({
      type: ApplicationTag.DEVICE_OBJECT_PROPERTY_REFERENCE,
      value: { objectId: analogValueId(instance), propertyId: PropertyIdentifier.PRESENT_VALUE }
    }));
    return write(scheduleId(zone.scheduleID), PropertyIdentifier.LIST_OF_OBJECT_PROPERTY_REFERENCES, references);
  }

  async function setupBindings(zones, conf, profiles = deviceProfiles) {
    await settleAll("Schedule references", zones.map((zone) => () => writeReferences(zone, profiles)));
  }

  // BACnet controllers reject an empty EXCEPTION_SCHEDULE (INVALID_TAG), so "no special event" is one eventless entry on a past date.
  const EMPTY_EXCEPTION_SCHEDULE = [{
    date: { type: ApplicationTag.DATE, value: { year: 90, month: 1, day: 1, wday: 1 } },
    events: [],
    priority: 16
  }];

  async function writeZoneSchedule(zone, special) {
    const id = scheduleId(zone.scheduleID);
    const exceptions = Object.keys(special ?? {}).length ? toExceptionSchedule(special) : EMPTY_EXCEPTION_SCHEDULE;
    await write(id, PropertyIdentifier.EXCEPTION_SCHEDULE, exceptions);
    await write(id, PropertyIdentifier.WEEKLY_SCHEDULE, toWeeklySchedule(zone.weekly));
    await write(id, PropertyIdentifier.SCHEDULE_DEFAULT, [real(zone.valueUnOccupied)]);
  }

  // An unknown object means the schedule is missing on the BMS: it is recreated with the same instance, then written again once.
  async function updateZoneSchedule(zone, special) {
    try {
      await writeZoneSchedule(zone, special);
    } catch (error) {
      if (!isUnknownObject(error)) throw error;
      log("warning", `Schedule ${zone.scheduleID} (${zone.scheduleName}) not found on the BMS, recreating it`);
      await create(scheduleId(zone.scheduleID), zone.scheduleName);
      await initializeSchedule(zone, deviceProfiles);
      await writeZoneSchedule(zone, special);
    }
  }

  function boundObjects(zone, deviceProfiles) {
    const objects = [];
    for (const [profileName, device] of Object.entries(zone.devices ?? {})) {
      const definition = deviceProfiles[profileName].bacnet;
      const object = definition.objects[device.AVToBindName];
      for (const number of device.deviceNums) {
        objects.push(definition.instanceRangeAV * number + object.instanceNum + definition.offsetAV);
      }
    }
    return objects;
  }

  return { setupSchedules, setupBindings, updateZoneSchedule };
}

module.exports = { createNativeScheduleDriver, toWeeklySchedule, toExceptionSchedule };
