const { ApplicationTag, ObjectType, PropertyIdentifier } = require("@bacnet-js/client");
const { getClient, describeError } = require("./bacnet-native");

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
function createNativeScheduleDriver(connection, { client, log = () => {} } = {}) {
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

  async function setupSchedules(zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    for (let i = min; i <= max; i++) await remove(scheduleId(i));
    for (const zone of zones) {
      await bacnet().createObject(address, scheduleId(zone.scheduleID), [
        { property: { id: PropertyIdentifier.OBJECT_NAME }, value: [string(zone.scheduleName)] }
      ]);
    }
    await settleAll("Schedule setup", zones.flatMap((zone) => [
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.SCHEDULE_DEFAULT, [real(19)]),
      () => write(scheduleId(zone.scheduleID), PropertyIdentifier.DESCRIPTION, [string(`Zone ${zone.scheduleName}`)])
    ]));
  }

  async function setupScheduleAV(zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    const offset = conf.scheduleAVInstanceOffset;
    for (let i = min; i <= max; i++) await remove(analogValueId(i + offset));
    for (const zone of zones) {
      await bacnet().createObject(address, analogValueId(zone.scheduleID + offset), [
        { property: { id: PropertyIdentifier.OBJECT_NAME }, value: [string(`scheduleAV-${zone.scheduleName}`)] }
      ]);
    }
    await settleAll("ScheduleAV setup", zones.map((zone) =>
      () => write(analogValueId(zone.scheduleID + offset), PropertyIdentifier.PRESENT_VALUE, [real(zone.valueOccupied)])
    ));
  }

  // Native BACnet has no binding service: scheduleAV values are written to the device objects by updateScheduleAV.
  async function setupBindings() {}

  async function updateZoneSchedule(zone, special) {
    const id = scheduleId(zone.scheduleID);
    await write(id, PropertyIdentifier.EXCEPTION_SCHEDULE, toExceptionSchedule(special));
    await write(id, PropertyIdentifier.WEEKLY_SCHEDULE, toWeeklySchedule(zone.weekly));
    await write(id, PropertyIdentifier.SCHEDULE_DEFAULT, [real(zone.valueUnOccupied)]);
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

  async function updateScheduleAV(zones, conf, label, deviceProfiles = {}) {
    const offset = conf.scheduleAVInstanceOffset;
    for (const zone of zones) {
      let value;
      try {
        const read = await bacnet().readProperty(address, scheduleId(zone.scheduleID), PropertyIdentifier.PRESENT_VALUE);
        value = read?.values?.[0]?.value;
      } catch (error) {
        log("warning", `${label}: Schedule ${zone.scheduleID}: ${describeError(error)}`);
        continue;
      }
      const number = Number(value);
      if (value === null || value === undefined || Number.isNaN(number)) {
        log("warning", `${label}: Schedule ${zone.scheduleID} returns 0 or NULL`);
        continue;
      }
      await settleAll(`${label}: ScheduleAV ${zone.scheduleName}`, [
        () => write(analogValueId(offset + zone.scheduleID), PropertyIdentifier.PRESENT_VALUE, [real(number)]),
        ...boundObjects(zone, deviceProfiles).map((instance) =>
          () => write(analogValueId(instance), PropertyIdentifier.PRESENT_VALUE, [real(number)], { priority: 14 }))
      ]);
    }
  }

  return { setupSchedules, setupScheduleAV, setupBindings, updateZoneSchedule, updateScheduleAV };
}

module.exports = { createNativeScheduleDriver, toWeeklySchedule, toExceptionSchedule };
