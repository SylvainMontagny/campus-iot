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

// Native BACnet schedule adapter: encodes a number as a BACnet REAL application value.
const real = (value) => ({ type: ApplicationTag.REAL, value: Number(value) });
// Native BACnet schedule adapter: encodes an empty schedule transition as BACnet NULL.
const nullValue = () => ({ type: ApplicationTag.NULL, value: null });
// Native BACnet schedule adapter: encodes a schedule label as a BACnet character string.
const string = (value) => ({ type: ApplicationTag.CHARACTER_STRING, value: String(value) });

// The BACnet client encodes times from the local clock fields of a Date.
// Native BACnet schedule adapter: converts a schedule time string into the local-clock Date format expected by bacnet-js.
function timeToDate(time) {
  const [hours, minutes, seconds] = String(time).split(":");
  return new Date(2000, 0, 1, Number(hours), Number(minutes), Math.floor(Number(seconds || 0)));
}

// Native BACnet schedule adapter: encodes a day's transitions for a BACnet schedule property.
function transitionsToEntries(transitions) {
  return Object.values(transitions ?? {})
    .sort((a, b) => String(a.time).localeCompare(String(b.time)))
    .map((transition) => ({
      time: timeToDate(transition.time),
      value: transition.value === null ? nullValue() : real(transition.value)
    }));
}

/** Native BACnet schedule adapter: converts zone.weekly into a Monday-first WEEKLY_SCHEDULE payload. */
function toWeeklySchedule(weekly = {}) {
  return DAYS.map((day) => transitionsToEntries(weekly[day]?.transitions));
}

/** Native BACnet schedule adapter: converts iCalendar special events into an EXCEPTION_SCHEDULE payload. */
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

// Native BACnet schedule adapter: builds the identifier for a schedule object.
const scheduleId = (instance) => ({ type: ObjectType.SCHEDULE, instance });
// Native BACnet schedule adapter: builds the identifier for an analog value bound to a schedule.
const analogValueId = (instance) => ({ type: ObjectType.ANALOG_VALUE, instance });

/** Native BACnet schedule adapter: provides schedule setup, binding, and update operations for the schedule service. */
function createNativeScheduleDriver(connection, { client, log = () => {}, deviceProfiles = {} } = {}) {
  const address = { address: `${connection.ipAddress}:${BACNET_PORT}` };
  // Native BACnet schedule adapter: uses an injected client in tests or the shared application client.
  const bacnet = () => client ?? getClient();

  // Native BACnet schedule adapter: writes one property to the selected controller.
  const write = (objectId, property, values, options = {}) => bacnet().writeProperty(address, objectId, property, values, options);

  // Native BACnet schedule adapter: runs independent property writes and logs each failed result.
  async function settleAll(label, tasks) {
    const results = await Promise.allSettled(tasks.map((task) => task()));
    results.forEach((result) => {
      if (result.status === "rejected") log("error", `${label}: ${describeError(result.reason)}`);
    });
  }

  // Native BACnet schedule adapter: removes an existing object before setup; absence is expected on first start.
  const remove = (objectId) => bacnet().deleteObject(address, objectId).catch(() => {});

  // Native BACnet schedule adapter: creates a named schedule with explicit index and priority values required by controllers.
  const create = (objectId, name) => bacnet().createObject(address, objectId, [
    { property: { id: PropertyIdentifier.OBJECT_NAME, index: ASN1_ARRAY_ALL }, value: [string(name)], priority: ASN1_NO_PRIORITY }
  ]);

  // Native BACnet schedule adapter: applies the same defaults and bindings used at startup when rebuilding a missing schedule.
  async function initializeSchedule(zone, profiles) {
    const id = scheduleId(zone.scheduleID);
    await settleAll("Schedule setup", [
      () => write(id, PropertyIdentifier.SCHEDULE_DEFAULT, [real(19)]),
      () => write(id, PropertyIdentifier.DESCRIPTION, [string(`Zone ${zone.scheduleName}`)]),
      ...(Object.keys(zone.devices ?? {}).length ? [() => writeReferences(zone, profiles)] : [])
    ]);
  }

  // Native BACnet schedule adapter: replaces the configured schedule range with objects for the active zones.
  async function setupSchedules(zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    for (let i = min; i <= max; i++) await remove(scheduleId(i));
    for (const zone of zones) await create(scheduleId(zone.scheduleID), zone.scheduleName);
    await settleAll("Schedule setup", zones.flatMap((zone) => [
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.SCHEDULE_DEFAULT, [real(19)]),
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.DESCRIPTION, [string(`Zone ${zone.scheduleName}`)])
    ]));
  }

  // Native BACnet schedule adapter: builds property references from a zone schedule to its bound device analog values.
  function referencesFor(zone, profiles) {
    return boundObjects(zone, profiles).map((instance) => ({
      type: ApplicationTag.DEVICE_OBJECT_PROPERTY_REFERENCE,
      value: { objectId: analogValueId(instance), propertyId: PropertyIdentifier.PRESENT_VALUE }
    }));
  }

  // Native BACnet schedule adapter: writes a zone's device references to its schedule object.
  function writeReferences(zone, profiles) {
    return write(scheduleId(zone.scheduleID), PropertyIdentifier.LIST_OF_OBJECT_PROPERTY_REFERENCES, referencesFor(zone, profiles));
  }

  // Native BACnet schedule adapter: binds each zone schedule to its configured device downlink objects.
  async function setupBindings(zones, conf, profiles = deviceProfiles) {
    const bindings = zones.map((zone) => ({
      zone,
      references: referencesFor(zone, profiles)
    }));
    const results = await Promise.allSettled(bindings.map(({ zone, references }) => Promise.resolve().then(() => {
      return write(scheduleId(zone.scheduleID), PropertyIdentifier.LIST_OF_OBJECT_PROPERTY_REFERENCES, references);
    })));
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const { zone, references } = bindings[index];
        const instances = references.map((reference) => reference.value.objectId.instance);
        log("error", `Schedule references failed for ${zone.scheduleName} (schedule instance ${zone.scheduleID}; analogValue instances ${instances.join(", ") || "none"}): ${describeError(result.reason)}`);
      }
    });
  }

  // BACnet controllers reject an empty EXCEPTION_SCHEDULE (INVALID_TAG), so "no special event" is one eventless entry on a past date.
  const EMPTY_EXCEPTION_SCHEDULE = [{
    date: { type: ApplicationTag.DATE, value: { year: 90, month: 1, day: 1, wday: 1 } },
    events: [],
    priority: 16
  }];

  // Native BACnet schedule adapter: writes weekly and exception events and the zone's unoccupied default.
  async function writeZoneSchedule(zone, special) {
    const id = scheduleId(zone.scheduleID);
    const exceptions = Object.keys(special ?? {}).length ? toExceptionSchedule(special) : EMPTY_EXCEPTION_SCHEDULE;
    await write(id, PropertyIdentifier.EXCEPTION_SCHEDULE, exceptions);
    await write(id, PropertyIdentifier.WEEKLY_SCHEDULE, toWeeklySchedule(zone.weekly));
    await write(id, PropertyIdentifier.SCHEDULE_DEFAULT, [real(zone.valueUnOccupied)]);
  }

  // Native BACnet schedule adapter: updates a zone schedule and optionally recreates a missing schedule at the same instance.
  async function updateZoneSchedule(zone, special, { recreate = false } = {}) {
    try {
      await writeZoneSchedule(zone, special);
    } catch (error) {
      if (!isUnknownObject(error)) throw error;
      if (!recreate) throw new Error(`object schedule ${zone.scheduleID} not found on the controller`);
      log("warning", `Schedule ${zone.scheduleID} (${zone.scheduleName}) not found on the BMS, recreating it`);
      await create(scheduleId(zone.scheduleID), zone.scheduleName);
      await initializeSchedule(zone, deviceProfiles);
      await writeZoneSchedule(zone, special);
    }
  }

  // Native BACnet schedule adapter: calculates the BACnet AV instances controlled by a zone.
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
