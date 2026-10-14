const test = require("node:test");
const assert = require("node:assert/strict");
const { createDefaultRoomsSchedules, validateRoomsSchedules, resolveRooms, applyAdeUrlSuffix } = require("../src/rooms-config");
const { buildSpecialEvents } = require("../src/ical-schedule");

const deviceProfiles = {
  valve: {
    identity: { maxDevNum: 10 },
    bacnet: { objects: { setpoint: { dataDirection: "downlink" }, temperature: { dataDirection: "uplink" } } }
  }
};
const connections = { bms: { protocol: "restAPIBacnet", ipAddress: "192.168.1.10" } };

function makeData(room = {}) {
  const data = createDefaultRoomsSchedules();
  data.rooms.push({
    scheduleName: "8D-120", connectionName: "bms", url: "https://example.org/a.ics",
    devices: { valve: { deviceNums: [1, 2], AVToBindName: "setpoint" } }, ...room
  });
  return data;
}

test("a complete room configuration is valid", () => {
  assert.deepEqual(validateRoomsSchedules(makeData(), { deviceProfiles, connections }), []);
});

test("invalid rooms are reported with their path", () => {
  const data = makeData({ connectionName: "missing", devices: { valve: { deviceNums: [11], AVToBindName: "temperature" } } });
  const paths = validateRoomsSchedules(data, { deviceProfiles, connections }).map((error) => error.path);
  assert.deepEqual(paths.sort(), [
    "roomsSchedules.rooms.0.connectionName",
    "roomsSchedules.rooms.0.devices.valve.AVToBindName",
    "roomsSchedules.rooms.0.devices.valve.deviceNums"
  ]);
});

test("device numbers cannot be shared between rooms", () => {
  const data = makeData();
  data.rooms.push({ ...structuredClone(data.rooms[0]), scheduleName: "8D-121" });
  const errors = validateRoomsSchedules(data, { deviceProfiles, connections });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /more than once/);
});

test("log options must be booleans", () => {
  const data = makeData();
  data.icalToScheduleConf.logs.scheduleAVUpdate = "yes";
  const errors = validateRoomsSchedules(data, { deviceProfiles, connections });
  assert.deepEqual(errors.map((error) => error.path), ["roomsSchedules.icalToScheduleConf.logs"]);
});

test("rooms inherit the global defaults and get consecutive schedule instances", () => {
  const data = makeData({ valueOccupied: 21 });
  data.icalToScheduleConf.scheduleInstanceRange = [5, 50];
  const [room] = resolveRooms(data);
  assert.equal(room.scheduleID, 5);
  assert.equal(room.valueOccupied, 21);
  assert.equal(room.valueUnOccupied, 15);
  assert.equal(room.timeZone, "Europe/Paris");
});

test("ADE suffix is appended or replaced only when enabled", () => {
  const now = new Date("2025-01-01T10:00:00Z");
  const base = { addSuffixToAdeURL: true, nbrDaysPreview: 10 };
  assert.equal(applyAdeUrlSuffix({ ...base, url: "https://x/a?b=1" }, now), "https://x/a?b=1&lastDate=2025-01-11");
  assert.equal(applyAdeUrlSuffix({ ...base, url: "https://x/a?b=1&lastDate=2020-01-01" }, now), "https://x/a?b=1&lastDate=2025-01-11");
  assert.equal(applyAdeUrlSuffix({ ...base, addSuffixToAdeURL: false, url: "https://x/a" }, now), "https://x/a");
});

test("resolveRooms applies the ADE suffix from the defaults", () => {
  const data = makeData({ url: "https://x/a?b=1" });
  data.icalToScheduleConf.defaults.addSuffixToAdeURL = true;
  const [room] = resolveRooms(data);
  assert.match(room.url, /^https:\/\/x\/a\?b=1&lastDate=\d{4}-\d{2}-\d{2}$/);
});

test("grouped events are merged per day with the configured offsets", () => {
  const room = { ...resolveRooms(makeData())[0], groupEvents: true, timeOffsetBeforeStart: 60, timeOffsetBeforeEnd: 30, eventsToDiscard: ["SKIP"] };
  const events = [
    { start: new Date("2030-01-07T09:00:00Z"), end: new Date("2030-01-07T10:00:00Z"), summary: "A", description: "" },
    { start: new Date("2030-01-07T13:00:00Z"), end: new Date("2030-01-07T15:00:00Z"), summary: "B", description: "" },
    { start: new Date("2030-01-07T11:00:00Z"), end: new Date("2030-01-07T12:00:00Z"), summary: "C", description: "SKIP" }
  ];
  const special = buildSpecialEvents(room, events);
  assert.equal(Object.keys(special).length, 1);
  assert.equal(special[1].name, "Merged Events");
  assert.equal(special[1].transitions[1].time, "09:00:00"); // 10:00 Paris - 1 h
  assert.equal(special[1].transitions[2].time, "15:30:00"); // 16:00 Paris - 30 min
  assert.equal(special[1].transitions[1].value, 19);
});
