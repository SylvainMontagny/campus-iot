const test = require("node:test");
const assert = require("node:assert/strict");
const { buildPreviousValuesRows } = require("../src/previous-values");
const { createDefaultZonesSchedules } = require("../src/zones-config");

const entry = {
  identity: { deviceName: "valve-2", deviceProfile: "valve", deviceNum: 2 },
  bacnet: {
    objects: {
      temperature: { dataDirection: "uplink", objectType: 2, instanceNum: 20, objectName: "valve-2-temperature-20", value: 21.5 },
      setpoint: { dataDirection: "downlink", objectType: "analogValue", instanceNum: 21, objectName: "valve-2-setpoint-21", value: 19 },
      mode: { dataDirection: "downlink", objectType: 5, instanceNum: 22, objectName: "valve-2-mode-22", value: 1 }
    }
  }
};

function zonesSchedules(deviceNums) {
  const data = createDefaultZonesSchedules();
  data.zones = [{ scheduleName: "room1", connectionName: "bms", url: "https://example.org/a.ics", devices: { valve: { AVToBindName: "setpoint", deviceNums } } }];
  return data;
}

test("downlink objects bound to an iCal zone show the schedule and its present value", async () => {
  const requested = [];
  const readSchedules = async (connection, instances) => {
    requested.push([connection.ipAddress, instances]);
    return new Map([[instances[0], "20"]]);
  };
  const rows = await buildPreviousValuesRows({ deviceProfile: "valve", entries: [entry], zonesSchedules: zonesSchedules([2]), connections: { bms: { ipAddress: "10.0.0.1" } }, readSchedules });
  assert.deepEqual(rows.map((row) => [row.type, row.instance, row.name, row.presentValue, row.direction]), [
    ["analogValue", 20, "valve-2-temperature-20", "21.5", "uplink"],
    ["analogValue", 21, "valve-2-setpoint-21", "19", "downlink"],
    ["binaryValue", 22, "valve-2-mode-22", "1", "downlink"]
  ]);
  assert.equal(rows[0].controlledBy, null);
  assert.deepEqual(rows[1].controlledBy, { scheduleName: "room1", presentValue: "20" });
  assert.equal(rows[2].controlledBy, null);
  assert.deepEqual(requested, [["10.0.0.1", [0]]]);
});

test("a device that is not listed in the zone is not controlled by its schedule", async () => {
  const rows = await buildPreviousValuesRows({ deviceProfile: "valve", entries: [entry], zonesSchedules: zonesSchedules([5]), connections: { bms: { ipAddress: "10.0.0.1" } }, readSchedules: async () => new Map() });
  assert.ok(rows.every((row) => row.controlledBy === null));
});
