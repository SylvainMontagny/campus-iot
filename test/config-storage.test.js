const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { readConfig, writeConfig, applyConnectionsToDevices } = require("../server");

test("stores only the device map in deviceList.json", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-config-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const config = {
    connections: {
      Office: {
        ipAddress: "10.20.30.40",
        protocol: "restAPIBacnet",
        bacnetLogin: "operator",
        bacnetPassword: "secret",
        networkServer: "tts"
      }
    },
    deviceConnections: { sensor: "Office" },
    deviceList: {
      sensor: {
        identity: { maxDevNum: 4 },
        controller: {
          ipAddress: "192.168.1.10",
          protocol: "restAPIBacnet",
          login: "operator",
          password: "secret"
        },
        lorawan: { networkServer: "tts" },
        bacnet: { objects: {} }
      }
    }
  };

  await writeConfig(config, directory);
  const fileContent = await fs.readFile(path.join(directory, "deviceList.json"), "utf8");
  assert.deepEqual(JSON.parse(fileContent), config.deviceList);
  assert.equal(fileContent.includes("globalConfig"), false);

  const materialized = applyConnectionsToDevices(config);
  assert.equal(materialized.deviceList.sensor.controller.ipAddress, "10.20.30.40");
  assert.equal(materialized.deviceList.sensor.controller.login, "operator");
  assert.equal(materialized.deviceList.sensor.controller.connectionName, "Office");
  assert.equal(config.deviceList.sensor.controller.ipAddress, "192.168.1.10");
  await writeConfig(materialized, directory);
  const savedDeviceList = JSON.parse(await fs.readFile(path.join(directory, "deviceList.json"), "utf8"));
  assert.equal(savedDeviceList.sensor.controller.ipAddress, "10.20.30.40");
  await assert.rejects(fs.access(path.join(directory, "connections.json")), { code: "ENOENT" });

  const restored = await readConfig(directory);
  assert.deepEqual(restored.deviceList, savedDeviceList);
  assert.equal(restored.deviceList.sensor.controller.connectionName, "Office");
  assert.equal(restored.connections.Office.ipAddress, "10.20.30.40");
  assert.equal(restored.connections.Office.bacnetLogin, "operator");
  assert.deepEqual(restored.deviceConnections, config.deviceConnections);
});

test("uses controller.connectionName as the profile assignment fallback", () => {
  const config = {
    connections: {
      Office: {
        ipAddress: "192.168.1.10",
        protocol: "bacnet",
        networkServer: "tts"
      }
    },
    deviceList: {
      sensor: {
        controller: { connectionName: "Office" },
        lorawan: {},
        bacnet: { objects: {} }
      }
    }
  };

  const result = applyConnectionsToDevices(config);
  assert.equal(result.deviceConnections.sensor, "Office");
  assert.equal(result.deviceList.sensor.controller.connectionName, "Office");
  assert.equal(result.deviceList.sensor.controller.ipAddress, "192.168.1.10");
});

test("ignores legacy config.json when deviceList.json is missing", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-legacy-config-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "config.json"), JSON.stringify({
    globalConfig: { ipAddress: "10.0.0.1" },
    deviceList: { legacyDevice: {} }
  }));

  const config = await readConfig(directory);
  assert.deepEqual(config, require("../src/default-config").createDefaultConfig());
});

test("reconstructs separate named profiles from device settings", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-device-settings-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deviceList = {
    office: {
      controller: { ipAddress: "192.168.1.10", protocol: "bacnet" },
      lorawan: { networkServer: "tts" }
    },
    lab: {
      controller: { ipAddress: "10.0.0.15", protocol: "restAPIBacnet", model: "distechControlsV2", login: "lab", password: "secret" },
      lorawan: { networkServer: "chirpstack", chirpstack: { grpcApiKey: "api-key", serverAddress: "chirpstack.local", grpcPort: 8080 } }
    }
  };
  await fs.writeFile(path.join(directory, "deviceList.json"), JSON.stringify(deviceList));

  const migrated = await readConfig(directory);
  assert.equal(Object.keys(migrated.connections).length, 2);
  assert.notEqual(migrated.deviceConnections.office, migrated.deviceConnections.lab);
  assert.equal(migrated.connections[migrated.deviceConnections.lab].ipAddress, "10.0.0.15");
});

test("restores named profiles from controller.connectionName in deviceList.json", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "lorabac-named-profiles-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const deviceList = {
    office: {
      identity: { maxDevNum: 2 },
      controller: { connectionName: "Office LAN", ipAddress: "192.168.1.10", protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      bacnet: { objects: {} }
    },
    lab: {
      identity: { maxDevNum: 2 },
      controller: { connectionName: "Lab LAN", ipAddress: "10.0.0.15", protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      bacnet: { objects: {} }
    }
  };
  await fs.writeFile(path.join(directory, "deviceList.json"), JSON.stringify(deviceList));

  const restored = await readConfig(directory);
  assert.deepEqual(Object.keys(restored.connections).sort(), ["Lab LAN", "Office LAN"]);
  assert.equal(restored.deviceConnections.office, "Office LAN");
  assert.equal(restored.deviceConnections.lab, "Lab LAN");
});