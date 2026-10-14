const test = require("node:test");
const assert = require("node:assert/strict");
const { ObjectType, PropertyIdentifier } = require("@bacnet-js/client");
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

test("scheduleAV values are copied to the scheduleAV object and the bound device objects", async () => {
  const writes = [];
  const client = {
    readProperty: async () => ({ values: [{ type: 4, value: 19 }] }),
    writeProperty: async (address, id, property, values, options) => { writes.push({ id, values, options }); }
  };
  const driver = createNativeScheduleDriver({ ipAddress: "10.0.0.9" }, { client });
  const deviceProfiles = { valve: { bacnet: { instanceRangeAV: 100, offsetAV: 5000, objects: { setpoint: { instanceNum: 12 } } } } };
  const zone = { scheduleID: 2, scheduleName: "z", devices: { valve: { deviceNums: [3], AVToBindName: "setpoint" } } };

  await driver.updateScheduleAV([zone], { scheduleAVInstanceOffset: 10000 }, "bms", deviceProfiles);

  assert.deepEqual(writes.map((write) => write.id.instance), [10002, 5312]);
  assert.equal(writes[1].options.priority, 14);
});
