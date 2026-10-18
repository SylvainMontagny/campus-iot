const test = require("node:test");
const assert = require("node:assert/strict");
const { scheduleInitialValues } = require("../src/schedule-initial-values");
const { buildWriteValuesRequest } = require("../src/restapi-bacnet");
const { createDefaultZonesSchedules } = require("../src/zones-config");

const deviceProfiles = {
  valve: { identity: { maxDevNum: 10 }, controller: { connectionName: "bms" }, bacnet: { objects: { setpoint: { dataDirection: "downlink" } } } }
};
const connections = { bms: { protocol: "bacnet", ipAddress: "10.0.0.1" } };

function zonesSchedules(zone = {}) {
  const data = createDefaultZonesSchedules();
  data.zones = [{ scheduleName: "room1", url: "https://example.org/a.ics", devices: { valve: { AVToBindName: "setpoint", deviceNums: [2] } }, ...zone }];
  return data;
}

const device = (deviceNum) => ({
  identity: { deviceProfile: "valve", deviceNum, deviceName: `valve-${deviceNum}` },
  controller: { connectionName: "bms" },
  bacnet: { objects: { setpoint: { dataDirection: "downlink", value: 15 } } }
});

const run = (dev, data = zonesSchedules()) => {
  const calls = [];
  const readValues = async (connection, instances) => { calls.push(instances); return new Map([[0, "21.5"]]); };
  return scheduleInitialValues(dev, { zonesSchedules: data, deviceProfiles, connections, readValues }).then((result) => ({ result, calls }));
};

test("a downlink object controlled by a zone takes its schedule present value", async () => {
  const { result, calls } = await run(device(2));
  assert.deepEqual(result, { setpoint: 21.5 });
  assert.deepEqual(calls, [[0]]);
});

test("a device that no zone controls keeps the profile default", async () => {
  const { result, calls } = await run(device(3));
  assert.deepEqual(result, {});
  assert.deepEqual(calls, []);
});

test("an unreadable schedule keeps the default", async () => {
  const result = await scheduleInitialValues(device(2), { zonesSchedules: zonesSchedules(), deviceProfiles, connections, readValues: async () => new Map() });
  assert.deepEqual(result, {});
});

test("REST creation writes the schedule value before the previous and default values", () => {
  const request = buildWriteValuesRequest(device(2), {}, 1000, { setpoint: 21.5 });
  const body = typeof request.data === "string" ? JSON.parse(request.data) : request.data;
  assert.equal(body["property-references"][0].value, 21.5);
});
