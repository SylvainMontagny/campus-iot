const test = require("node:test");
const assert = require("node:assert/strict");
const { processRestApiBacnet } = require("../src/bms-connections/adapters/distech-rest/device-communication");

function makeDevice() {
  return {
    identity: { deviceName: "valve-2" },
    controller: { protocol: "restAPIBacnet", model: "distechControlsV2", ipAddress: "10.0.0.5", login: "a", password: "b" },
    transmitTime: Date.now(),
    bacnet: {
      objects: {
        setpoint: { objectName: "valve-2-setpoint-5022", objectType: "analogValue", instanceNum: 5022, dataDirection: "downlink", value: 15 }
      }
    }
  };
}

test("a missing downlink object is read, created, written with the schedule value, then read again", async () => {
  const steps = [];
  let created = false;
  const httpClient = {
    request: async (request) => {
      const url = request.url;
      if (url.endsWith("/batch")) { steps.push("create"); created = true; return { status: 200, data: "{}" }; }
      if (url.endsWith("/write-property-multiple")) {
        steps.push(`write ${request.data["property-references"][0].value}`);
        return { status: 200, data: "{}" };
      }
      steps.push(created ? "read ok" : "read failed");
      return { status: 200, data: created ? JSON.stringify({ results: [{ type: "analogValue", instance: 5022, value: 21 }] }) : "Unknown Object" };
    }
  };
  const device = makeDevice();

  const outcome = await processRestApiBacnet(device, { httpClient, getInitialValues: async () => ({ setpoint: 21 }) });

  assert.deepEqual(outcome, { handled: true, ok: true });
  assert.deepEqual(steps, ["read failed", "create", "write 21", "read ok"]);
  assert.equal(device.bacnet.objects.setpoint.value, 21);
});
