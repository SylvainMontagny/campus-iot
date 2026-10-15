const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectType, PropertyIdentifier, ASN1_ARRAY_ALL, ASN1_NO_PRIORITY } = require("@bacnet-js/client");
const { createNativeScheduleDriver, toWeeklySchedule, toExceptionSchedule } = require("../src/bacnet-schedule");

const special = {
  1: {
    "event-priority": 16,
    period: { date: { month: 3, year: 2030, "day-of-month": 7 }, type: "Date" },
    name: "A",
    transitions: { 1: { time: "09:00:00", value: 19, key: "1" }, 2: { time: "15:30:00", value: null, key: "2" } },
    key: "1"
  }
};

test("special events become a BACnet exception schedule", () => {
  const [entry] = toExceptionSchedule(special);
  assert.equal(entry.priority, 16);
  assert.deepEqual(entry.date.value, { year: 130, month: 3, day: 7, wday: 4 });
  assert.equal(entry.events[0].time.getHours(), 9);
  assert.deepEqual(entry.events[0].value, { type: 4, value: 19 });
  assert.equal(entry.events[1].time.getMinutes(), 30);
  assert.equal(entry.events[1].value.value, null);
});

test("the weekly schedule starts on Monday and always has seven days", () => {
  const weekly = toWeeklySchedule({ friday: { transitions: { 1: { time: "15:00:00.00", value: 7 } } } });
  assert.equal(weekly.length, 7);
  assert.equal(weekly[4].length, 1);
  assert.equal(weekly[4][0].time.getHours(), 15);
  assert.deepEqual(weekly[0], []);
});

test("a zone schedule is written to the BACnet schedule object of the controller", async () => {
  const writes = [];
  const client = { writeProperty: async (address, id, property, values) => { writes.push({ address, id, property, values }); } };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });

  await driver.updateZoneSchedule({ scheduleID: 7, weekly: {}, valueUnOccupied: 15 }, special);

  assert.deepEqual(writes.map((write) => write.property), [
    PropertyIdentifier.EXCEPTION_SCHEDULE, PropertyIdentifier.WEEKLY_SCHEDULE, PropertyIdentifier.SCHEDULE_DEFAULT
  ]);
  assert.deepEqual(writes[0].address, { address: "10.0.0.9:47808" });
  assert.deepEqual(writes[0].id, { type: ObjectType.SCHEDULE, instance: 7 });
  assert.deepEqual(writes[2].values, [{ type: 4, value: 15 }]);
});

test("a schedule missing on the BMS (unknown object) is recreated with the same instance, then written again", async () => {
  const calls = [];
  let missing = true;
  const client = {
    createObject: async (address, id) => { calls.push(["create", id.instance]); missing = false; },
    writeProperty: async (address, id, property) => {
      calls.push(["write", id.instance, property]);
      if (missing) throw new Error("BacnetError - Class:1 - Code:31");
    }
  };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });

  await driver.updateZoneSchedule({ scheduleID: 7, scheduleName: "z", weekly: {}, valueUnOccupied: 15 }, special);

  assert.deepEqual(calls[0], ["write", 7, PropertyIdentifier.EXCEPTION_SCHEDULE]);
  assert.deepEqual(calls[1], ["create", 7]);
  assert.ok(calls.slice(2).every((call) => call[1] === 7));
  assert.deepEqual(calls.slice(-3).map((call) => call[2]), [
    PropertyIdentifier.EXCEPTION_SCHEDULE, PropertyIdentifier.WEEKLY_SCHEDULE, PropertyIdentifier.SCHEDULE_DEFAULT
  ]);
});

test("other write errors do not recreate the schedule", async () => {
  let created = false;
  const client = {
    createObject: async () => { created = true; },
    writeProperty: async () => { throw new Error("BacnetError - Class:1 - Code:37"); }
  };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });

  await assert.rejects(driver.updateZoneSchedule({ scheduleID: 7, scheduleName: "z", weekly: {}, valueUnOccupied: 15 }, special));
  assert.equal(created, false);
});

test("an empty calendar writes one eventless placeholder entry instead of an empty exception schedule", async () => {
  const writes = [];
  const client = { writeProperty: async (address, id, property, values) => { writes.push({ property, values }); } };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });

  await driver.updateZoneSchedule({ scheduleID: 7, weekly: {}, valueUnOccupied: 15 }, {});

  assert.equal(writes[0].property, PropertyIdentifier.EXCEPTION_SCHEDULE);
  assert.equal(writes[0].values.length, 1);
  assert.deepEqual(writes[0].values[0].events, []);
});

test("the native driver has no scheduleAV objects nor scheduleAV update", () => {
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client: {} });
  assert.equal(driver.setupScheduleAV, undefined);
  assert.equal(driver.updateScheduleAV, undefined);
});

test("schedules are created with explicit index and priority", async () => {
  const created = [];
  const client = {
    deleteObject: async () => {},
    createObject: async (address, id, values) => { created.push({ id, values }); },
    writeProperty: async () => {}
  };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });

  await driver.setupSchedules([{ scheduleID: 2, scheduleName: "z" }], { scheduleInstanceRange: [1, 2] });

  assert.equal(created.length, 1);
  assert.deepEqual(created[0].id, { type: ObjectType.SCHEDULE, instance: 2 });
  assert.equal(created[0].values[0].property.index, ASN1_ARRAY_ALL);
  assert.equal(created[0].values[0].priority, ASN1_NO_PRIORITY);
});

test("each schedule references the AVToBindName objects of its zone devices", async () => {
  const writes = [];
  const client = { writeProperty: async (address, id, property, values) => { writes.push({ id, property, values }); } };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });
  const deviceProfiles = { valve: { bacnet: { instanceRangeAV: 100, offsetAV: 5000, objects: { setpoint: { instanceNum: 12 } } } } };
  const zone = { scheduleID: 2, scheduleName: "z", devices: { valve: { deviceNums: [3, 4], AVToBindName: "setpoint" } } };

  await driver.setupBindings([zone], {}, deviceProfiles);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].property, PropertyIdentifier.LIST_OF_OBJECT_PROPERTY_REFERENCES);
  assert.deepEqual(writes[0].values.map((reference) => reference.value.objectId), [
    { type: ObjectType.ANALOG_VALUE, instance: 5312 }, { type: ObjectType.ANALOG_VALUE, instance: 5412 }
  ]);
});
