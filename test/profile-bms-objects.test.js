const test = require("node:test");
const assert = require("node:assert/strict");
const { buildBmsObjectRows } = require("../src/profile-bms-objects");
const { createDefaultZonesSchedules } = require("../src/zones-config");

const definition = {
  identity: { maxDevNum: 5 },
  bacnet: {
    offsetAV: 100,
    offsetBV: 200,
    instanceRangeAV: 10,
    instanceRangeBV: 10,
    objects: {
      temperature: { dataDirection: "uplink", objectType: "analogValue", assignementMode: "auto", instanceNum: 0 },
      setpoint: { dataDirection: "downlink", objectType: "analogValue", assignementMode: "auto", instanceNum: 1 },
      mode: { dataDirection: "downlink", objectType: "binaryValue", assignementMode: "auto", instanceNum: 2 }
    }
  }
};

const bmsObjects = {
  values: [
    { type: "analogValue", instance: 110, name: "temp-1", presentValue: "21.5" },
    { type: "analogValue", instance: 121, name: "setpoint-2", presentValue: "20" },
    { type: "binaryValue", instance: 222, name: "mode-2", presentValue: "1" },
    { type: "analogValue", instance: 9999, name: "unrelated", presentValue: "0" }
  ],
  schedules: [{ instance: 0, name: "room1", presentValue: "20" }]
};

function zonesSchedules(deviceNums) {
  const data = createDefaultZonesSchedules();
  data.zones = [{ scheduleName: "room1", connectionName: "bms", url: "https://example.org/a.ics", devices: { valve: { AVToBindName: "setpoint", deviceNums } } }];
  return data;
}

const build = (connectionName, deviceNums) => buildBmsObjectRows({ deviceProfile: "valve", definition, connectionName, bmsObjects, zonesSchedules: zonesSchedules(deviceNums) });

test("only the BMS objects of the profile are listed, downlink ones with their schedule present value", () => {
  const rows = build("bms", [2]);
  assert.deepEqual(rows.map((row) => [row.type, row.instance, row.name, row.presentValue, row.direction]), [
    ["analogValue", 110, "temp-1", "21.5", "uplink"],
    ["analogValue", 121, "setpoint-2", "20", "downlink"],
    ["binaryValue", 222, "mode-2", "1", "downlink"]
  ]);
  assert.equal(rows[0].controlledBy, null);
  assert.deepEqual(rows[1].controlledBy, { scheduleName: "room1", presentValue: "20" });
  assert.equal(rows[2].controlledBy, null);
});

test("a device that is not listed in the zone is not controlled by its schedule", () => {
  assert.ok(build("bms", [5]).every((row) => row.controlledBy === null));
});
