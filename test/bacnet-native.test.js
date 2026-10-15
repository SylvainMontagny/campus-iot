const test = require("node:test");
const assert = require("node:assert/strict");
const { ApplicationTag, PropertyIdentifier } = require("@bacnet-js/client");
const { processBacnet, isUnknownObject } = require("../src/bacnet-native");

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
    writeProperty: async () => { throw new Error("write failed"); },
    readPropertyMultiple: async () => { throw new Error("must not be called"); }
  };
  const logs = [];

  const outcome = await processBacnet(makeDevice(), { client, log: (...args) => logs.push(args) });

  assert.equal(outcome.ok, false);
  assert.equal(logs.filter(([level]) => level === "error").length, 2);
  assert.match(logs[0][1], /Error writing BACnet object valve-1-temperature-5010: write failed/);
});

test("creates a missing uplink object and applies its LoRaWAN value", async () => {
  const creates = [];
  const writes = [];
  let temperatureCreated = false;
  const client = {
    writeProperty: async (address, id, property, values) => {
      writes.push({ id, property, values });
      if (id.instance === 5010 && !temperatureCreated) {
        throw new Error("BacnetError - Class:1 - Code:31");
      }
    },
    createObject: async (address, id, properties) => {
      creates.push({ address, id, properties });
      temperatureCreated = true;
    },
    readPropertyMultiple: async () => ({ values: [] })
  };

  const outcome = await processBacnet(makeDevice(), { client });

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.equal(creates.length, 1);
  assert.deepEqual(creates[0].id, { type: 2, instance: 5010 });
  assert.deepEqual(creates[0].properties, []);
  const created = writes.filter(({ id }) => id.instance === 5010).slice(1);
  assert.deepEqual(created.map(({ property }) => property), [PropertyIdentifier.OBJECT_NAME, PropertyIdentifier.PRESENT_VALUE]);
  assert.deepEqual(created[0].values, [{ type: ApplicationTag.CHARACTER_STRING, value: "valve-1-temperature-5010" }]);
  assert.equal(created[1].values[0].value, 21.5);
});

test("creates a missing downlink object and applies its configured default", async () => {
  const creates = [];
  const writes = [];
  const client = {
    writeProperty: async (address, id, property, values) => { writes.push({ id, values }); },
    createObject: async (address, id, properties) => { creates.push({ id, properties }); },
    readPropertyMultiple: async () => ({
      values: [{
        objectId: { type: 2, instance: 5012 },
        values: [{ id: 85, index: 4294967295, value: [{ type: ApplicationTag.ERROR, value: { errorClass: 1, errorCode: 31 } }] }]
      }]
    })
  };

  const outcome = await processBacnet(makeDevice(), { client });

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.deepEqual(creates.map(({ id }) => id), [{ type: 2, instance: 5012 }]);
  assert.ok(writes.some(({ id, values }) => id.instance === 5012 && values[0].value === 0));
});

test("uses the previously saved downlink value when provisioning", async () => {
  const writes = [];
  const client = {
    writeProperty: async (address, id, property, values) => { writes.push({ id, values }); },
    createObject: async () => {},
    readPropertyMultiple: async () => {
      throw new Error("Unknown object");
    }
  };
  const previousValues = {
    "valve-1": { bacnet: { objects: { setpoint: { value: 17 } } } }
  };

  const outcome = await processBacnet(makeDevice(), { client, previousValues });

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.ok(writes.some(({ id, values }) => id.instance === 5012 && values[0].value === 17));
});

test("recognizes unknown-object errors with controller-specific wording", () => {
  assert.equal(isUnknownObject(new Error("Object lookup failed: class 1, error code 31")), true);
  assert.equal(isUnknownObject(new Error("UnKnOwN object identifier")), true);
  assert.equal(isUnknownObject(new Error("BacnetError - Class:2 - Code:31")), false);
  assert.equal(isUnknownObject({ errorClass: 1, errorCode: 31 }), true);
  assert.equal(isUnknownObject({ errorClass: 2, errorCode: 31 }), false);
});

test("sends one create request and does not write if the controller rejects it", async () => {
  let createCalls = 0;
  const writes = [];
  const client = {
    writeProperty: async (address, id, property, values) => {
      writes.push({ id, values });
      if (id.instance === 5010) throw new Error("BacnetError - Class:1 - Code:31");
    },
    createObject: async () => {
      createCalls++;
      throw new Error("BacnetError - Class:0 - Code:2");
    },
    readPropertyMultiple: async () => ({ values: [] })
  };
  const logs = [];

  const outcome = await processBacnet(makeDevice(), { client, log: (...args) => logs.push(args) });

  assert.deepEqual(outcome, { handled: true, ok: false });
  assert.equal(createCalls, 1);
  assert.equal(writes.filter(({ id }) => id.instance === 5010).length, 1);
  assert.ok(logs.some(([level, message]) => level === "error" && message.includes("CONFIGURATION_IN_PROGRESS")));
});

test("waits for each create acknowledgement before sending the next create request", async () => {
  const createdInstances = [];
  const acknowledgedInstances = new Set();
  let acknowledgeFirst;
  let firstCreateStarted;
  const firstStarted = new Promise((resolve) => { firstCreateStarted = resolve; });
  const client = {
    writeProperty: async (address, id) => {
      if ((id.instance === 5010 || id.instance === 5012) && !acknowledgedInstances.has(id.instance)) {
        throw new Error("BacnetError - Class:1 - Code:31");
      }
    },
    createObject: async (address, id) => {
      createdInstances.push(id.instance);
      if (id.instance === 5010) {
        firstCreateStarted();
        await new Promise((resolve) => { acknowledgeFirst = resolve; });
      }
      acknowledgedInstances.add(id.instance);
    },
    readPropertyMultiple: async () => ({ values: [] })
  };
  const device = makeDevice();
  device.bacnet.objects.open.instanceNum = 5010 + 2;
  const operation = processBacnet(device, { client });
  await firstStarted;

  assert.deepEqual(createdInstances, [5010]);
  acknowledgeFirst();
  const outcome = await operation;

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.deepEqual(createdInstances, [5010, 5012]);
});

test("waits for the create acknowledgement before applying the uplink value", async () => {
  let acknowledgeCreate;
  let createStarted;
  const started = new Promise((resolve) => { createStarted = resolve; });
  const events = [];
  const client = {
    writeProperty: async (address, id, property) => {
      if (id.instance === 5010) {
        if (events.includes("created")) events.push(property === PropertyIdentifier.OBJECT_NAME ? "name-written" : "value-written");
        else throw new Error("BacnetError - Class:1 - Code:31");
      }
    },
    createObject: async () => {
      events.push("create-request");
      createStarted();
      await new Promise((resolve) => { acknowledgeCreate = resolve; });
      events.push("created");
    },
    readPropertyMultiple: async () => ({ values: [] })
  };

  const operation = processBacnet(makeDevice(), { client });
  await started;
  assert.deepEqual(events, ["create-request"]);
  acknowledgeCreate();
  const outcome = await operation;

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.deepEqual(events, ["create-request", "created", "name-written", "value-written"]);
});

test("ignores other protocols", async () => {
  const device = makeDevice();
  device.controller.protocol = "restAPIBacnet";
  assert.deepEqual(await processBacnet(device, { client: {} }), { handled: false });
});
