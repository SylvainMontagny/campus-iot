const test = require("node:test");
const assert = require("node:assert/strict");
const { validateConfig } = require("../src/config-validation");
const { createDefaultConfig } = require("../src/default-config");

function configuredDevice() {
  return {
    identity: { maxDevNum: 8 },
    controller: { ipAddress: "192.168.1.20" },
    bacnet: {
      offsetAV: 0,
      offsetBV: 0,
      instanceRangeAV: 10,
      instanceRangeBV: 10,
      objects: {
        temperature: {
          objectType: "analogValue",
          dataDirection: "uplink",
          assignementMode: "auto",
          instanceNum: 0,
          lorawanPayloadName: "sensor.temperature"
        }
      }
    }
  };
}

test("empty default configuration is valid", () => {
  assert.deepEqual(validateConfig(createDefaultConfig()), []);
});

test("rejects malformed IPv4 addresses when devices exist", () => {
  const config = createDefaultConfig();
  config.deviceList.sensor = configuredDevice();
  config.deviceList.sensor.controller.ipAddress = "300.0.0.1";

  assert.ok(validateConfig(config).some((error) => error.path === "deviceList.sensor.controller.ipAddress"));
});

test("rejects device assignments to missing connection profiles", () => {
  const config = createDefaultConfig();
  config.deviceList.sensor = configuredDevice();
  config.deviceConnections.sensor = "Removed connection";

  assert.ok(validateConfig(config).some((error) => error.path === "deviceConnections.sensor"));
});

test("accepts a downlink comparison that references an existing uplink", () => {
  const config = createDefaultConfig();
  config.deviceList.sensor = configuredDevice();
  config.deviceList.sensor.bacnet.objects.setpoint = {
    objectType: "analogValue",
    dataDirection: "downlink",
    assignementMode: "auto",
    instanceNum: 1,
    downlinkPort: 10,
    downlinkStrategy: "compareToUplinkObject",
    uplinkToCompareWith: "temperature"
  };

  assert.deepEqual(validateConfig(config), []);
});

test("rejects an unknown downlink comparison target", () => {
  const config = createDefaultConfig();
  config.deviceList.sensor = configuredDevice();
  config.deviceList.sensor.bacnet.objects.setpoint = {
    objectType: "analogValue",
    dataDirection: "downlink",
    assignementMode: "auto",
    instanceNum: 1,
    downlinkPort: 10,
    downlinkStrategy: "compareToUplinkObject",
    uplinkToCompareWith: "not-an-uplink"
  };

  assert.ok(validateConfig(config).some((error) => error.path.endsWith("uplinkToCompareWith")));
});

test("rejects manual instances inside an automatic allocation range", () => {
  const config = createDefaultConfig();
  config.deviceList.sensor = configuredDevice();
  config.deviceList.manual = {
    identity: { maxDevNum: 2 },
    controller: { ipAddress: "192.168.1.20" },
    bacnet: {
      offsetAV: 200,
      offsetBV: 200,
      instanceRangeAV: 10,
      instanceRangeBV: 10,
      objects: {
        fixed: {
          objectType: "analogValue",
          dataDirection: "uplink",
          assignementMode: "manual",
          instanceNum: 20,
          lorawanPayloadName: "temperature"
        }
      }
    }
  };

  assert.ok(validateConfig(config).some((error) => error.message.includes("overlaps sensor's automatic range")));
});