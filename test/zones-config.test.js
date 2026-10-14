const test = require("node:test");
const assert = require("node:assert/strict");
const { createDefaultZonesSchedules, validateZonesSchedules, resolveZones, applyAdeUrlSuffix, findDuplicateIcalUrls } = require("../src/zones-config");
const { buildSpecialEvents } = require("../src/ical-schedule");

const deviceProfiles = {
  valve: {
    identity: { maxDevNum: 10 },
    bacnet: { objects: { setpoint: { dataDirection: "downlink" }, temperature: { dataDirection: "uplink" } } }
  }
};
const connections = { bms: { protocol: "restAPIBacnet", ipAddress: "192.168.1.10" } };

function makeData(zone = {}) {
  const data = createDefaultZonesSchedules();
  data.zones.push({
    scheduleName: "8D-120", connectionName: "bms", url: "https://example.org/a.ics",
    devices: { valve: { deviceNums: [1, 2], AVToBindName: "setpoint" } }, ...zone
  });
  return data;
}

test("a complete zone configuration is valid", () => {
  assert.deepEqual(validateZonesSchedules(makeData(), { deviceProfiles, connections }), []);
});

test("invalid zones are reported with their path", () => {
  const data = makeData({ connectionName: "missing", devices: { valve: { deviceNums: [11], AVToBindName: "temperature" } } });
  const paths = validateZonesSchedules(data, { deviceProfiles, connections }).map((error) => error.path);
  assert.deepEqual(paths.sort(), [
    "zonesSchedules.zones.0.connectionName",
    "zonesSchedules.zones.0.devices.valve.AVToBindName",
    "zonesSchedules.zones.0.devices.valve.deviceNums"
  ]);
});

test("device numbers cannot be shared between zones", () => {
  const data = makeData();
  data.zones.push({ ...structuredClone(data.zones[0]), scheduleName: "8D-121" });
  const errors = validateZonesSchedules(data, { deviceProfiles, connections });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /more than once/);
});

test("log options must be booleans", () => {
  const data = makeData();
  data.icalToScheduleConf.logs.scheduleAVUpdate = "yes";
  const errors = validateZonesSchedules(data, { deviceProfiles, connections });
  assert.deepEqual(errors.map((error) => error.path), ["zonesSchedules.icalToScheduleConf.logs"]);
});

test("zones inherit the global defaults and get consecutive schedule instances", () => {
  const data = makeData({ valueOccupied: 21 });
  data.icalToScheduleConf.scheduleInstanceRange = [5, 50];
  const [zone] = resolveZones(data);
  assert.equal(zone.scheduleID, 5);
  assert.equal(zone.valueOccupied, 21);
  assert.equal(zone.valueUnOccupied, 15);
  assert.equal(zone.timeZone, "Europe/Paris");
});

test("ADE suffix is appended or replaced only when enabled", () => {
  const now = new Date("2025-01-01T10:00:00Z");
  const base = { addSuffixToAdeURL: true, nbrDaysPreview: 10 };
  assert.equal(applyAdeUrlSuffix({ ...base, url: "https://x/a?b=1" }, now), "https://x/a?b=1&lastDate=2025-01-11");
  assert.equal(applyAdeUrlSuffix({ ...base, url: "https://x/a?b=1&lastDate=2020-01-01" }, now), "https://x/a?b=1&lastDate=2025-01-11");
  assert.equal(applyAdeUrlSuffix({ ...base, addSuffixToAdeURL: false, url: "https://x/a" }, now), "https://x/a");
});

test("resolveZones applies the ADE suffix from the defaults", () => {
  const data = makeData({ url: "https://x/a?b=1" });
  data.icalToScheduleConf.defaults.addSuffixToAdeURL = true;
  const [zone] = resolveZones(data);
  assert.match(zone.url, /^https:\/\/x\/a\?b=1&lastDate=\d{4}-\d{2}-\d{2}$/);
});

test("zones sharing an iCal URL are reported by name", () => {
  const zones = [
    { scheduleName: "A", url: "https://x/a.ics" },
    { scheduleName: "B", url: " https://x/a.ics" },
    { scheduleName: "C", url: "https://x/c.ics" }
  ];
  assert.deepEqual(findDuplicateIcalUrls(zones), ["Zones A, B use the same iCal URL: https://x/a.ics"]);
  assert.deepEqual(findDuplicateIcalUrls(zones.slice(1)), []);
});

test("zones adding events to a BACnet schedule need a schedule ID but no devices", () => {
  const data = makeData({ configuration: "scheduleEventsConf", scheduleID: 120, devices: undefined });
  assert.deepEqual(validateZonesSchedules(data, { deviceProfiles, connections }), []);

  data.zones[0].scheduleID = "";
  assert.deepEqual(validateZonesSchedules(data, { deviceProfiles, connections }).map((error) => error.path), ["zonesSchedules.zones.0.scheduleID"]);
});

test("a BACnet schedule ID cannot be reused but may fall in the ical range", () => {
  const data = makeData();
  data.zones.push({ scheduleName: "A", configuration: "scheduleEventsConf", connectionName: "bms", url: "https://example.org/b.ics", scheduleID: 3 });
  data.zones.push({ scheduleName: "B", configuration: "scheduleEventsConf", connectionName: "bms", url: "https://example.org/c.ics", scheduleID: 200 });
  data.zones.push({ scheduleName: "C", configuration: "scheduleEventsConf", connectionName: "bms", url: "https://example.org/d.ics", scheduleID: 200 });
  const paths = validateZonesSchedules(data, { deviceProfiles, connections }).map((error) => error.path);
  assert.deepEqual(paths, ["zonesSchedules.zones.3.scheduleID"]);
});

test("both BACnet and REST API BACnet connections are accepted", () => {
  const data = makeData();
  assert.deepEqual(validateZonesSchedules(data, { deviceProfiles, connections: { bms: { protocol: "bacnet", ipAddress: "10.0.0.1" } } }), []);
  assert.equal(validateZonesSchedules(data, { deviceProfiles, connections: { bms: { protocol: "other", ipAddress: "10.0.0.1" } } }).length, 1);
});

test("zones of the events configuration use their own defaults and keep their schedule ID", () => {
  const data = makeData();
  data.scheduleEventsConf.defaults.valueOccupied = 21;
  data.zones.push({ scheduleName: "E", configuration: "scheduleEventsConf", connectionName: "bms", url: "https://example.org/e.ics", scheduleID: 77 });
  const [ical, events] = resolveZones(data);
  assert.equal(ical.valueOccupied, 19);
  assert.equal(ical.scheduleID, 0);
  assert.equal(events.valueOccupied, 21);
  assert.equal(events.scheduleID, 77);
});

test("the events configuration has no ScheduleAV or instance range settings", () => {
  const data = makeData();
  assert.equal(data.scheduleEventsConf.logs.scheduleAVUpdate, undefined);
  assert.equal(data.scheduleEventsConf.scheduleInstanceRange, undefined);
});

test("grouped events are merged per day with the configured offsets", () => {
  const zone = { ...resolveZones(makeData())[0], groupEvents: true, timeOffsetBeforeStart: 60, timeOffsetBeforeEnd: 30, eventsToDiscard: ["SKIP"] };
  const events = [
    { start: new Date("2030-01-07T09:00:00Z"), end: new Date("2030-01-07T10:00:00Z"), summary: "A", description: "" },
    { start: new Date("2030-01-07T13:00:00Z"), end: new Date("2030-01-07T15:00:00Z"), summary: "B", description: "" },
    { start: new Date("2030-01-07T11:00:00Z"), end: new Date("2030-01-07T12:00:00Z"), summary: "C", description: "SKIP" }
  ];
  const special = buildSpecialEvents(zone, events);
  assert.equal(Object.keys(special).length, 1);
  assert.equal(special[1].name, "A, B");
  assert.equal(special[1].transitions[1].time, "09:00:00"); // 10:00 Paris - 1 h
  assert.equal(special[1].transitions[2].time, "15:30:00"); // 16:00 Paris - 30 min
  assert.equal(special[1].transitions[1].value, 19);
});
