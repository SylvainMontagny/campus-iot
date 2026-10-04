const test = require("node:test");
const assert = require("node:assert/strict");
const { processBacnet } = require("../src/bacnet-native");

function makeDevice() {
  return {
    identity: { deviceName: "valve-1" },
    controller: { protocol: "bacnet", ipAddress: "10.0.0.5" },
    transmitTime: Date.now(),
    bacnet: {
      objects: {
        temperature: { objectName: "valve-1-temperature-5010", objectType: 2, instanceNum: 5010, dataDirection: "uplink", value: 21.5 },
        open: { objectName: "valve-1-open-5011", objectType: 5, instanceNum: 5011, dataDirection: "uplink", value: 1 },
        setpoint: { objectName: "valve-1-setpoint-5012", objectType: 2, instanceNum: 5012, dataDirection: "downlink", value: 0 }
      }
    }
  };
}

test("writes uplink objects then reads downlink objects", async () => {
  const writes = [];
  const client = {
    writeProperty: async (address, id, property, values) => { writes.push({ address, id, property, values }); },
    readPropertyMultiple: async () => ({
      values: [{ objectId: { type: 2, instance: 5012 }, values: [{ id: 85, index: 4294967295, value: [{ type: 4, value: 19 }] }] }]
    })
  };
  const device = makeDevice();
  const logs = [];

  const outcome = await processBacnet(device, { client, log: (...args) => logs.push(args) });

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0].address, { address: "10.0.0.5:47808" });
  assert.equal(writes[0].property, 85);
  assert.deepEqual(writes[0].values, [{ type: 4, value: 21.5 }]);
  assert.deepEqual(writes[1].values, [{ type: 9, value: 1 }]);
  assert.equal(device.bacnet.objects.setpoint.value, 19);
  assert.ok(logs.some(([, message]) => message.includes("Wrote uplink BACNet objects: valve-1-temperature-5010, valve-1-open-5011")));
  assert.ok(logs.some(([, message]) => message.includes("Read downlink BACNet objects: valve-1-setpoint-5012")));
});

test("reports write failures and stops", async () => {
  const client = {
    writeProperty: async () => { throw new Error("unknown-object"); },
    readPropertyMultiple: async () => { throw new Error("must not be called"); }
  };
  const logs = [];

  const outcome = await processBacnet(makeDevice(), { client, log: (...args) => logs.push(args) });

  assert.equal(outcome.ok, false);
  assert.equal(logs.filter(([level]) => level === "error").length, 2);
  assert.match(logs[0][1], /Error writing BACnet object valve-1-temperature-5010: unknown-object/);
});

test("ignores other protocols", async () => {
  const device = makeDevice();
  device.controller.protocol = "restAPIBacnet";
  assert.deepEqual(await processBacnet(device, { client: {} }), { handled: false });
});
