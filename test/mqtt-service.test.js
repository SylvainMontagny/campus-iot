const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMqttService } = require("../src/mqtt-connections/service");
const { extractPayloadCatalogEntry, mapIncomingPacket } = require("../src/lorawan-to-bacnet/payload-mapping");

function makeDeviceProfiles() {
  return {
    sensor: {
      identity: { maxDevNum: 4 },
      controller: { protocol: "bacnet" },
      lorawan: { networkServer: "tts" },
      mqtt: { topicDownlink: {} },
      bacnet: {
        offsetAV: 100,
        offsetBV: 200,
        instanceRangeAV: 10,
        instanceRangeBV: 5,
        objects: {
          temperature: {
            lorawanPayloadName: "decoded.temperature",
            dataDirection: "uplink",
            assignementMode: "auto",
            instanceNum: 1,
            objectType: "analogValue",
            value: 0
          }
        }
      }
    }
  };
}

test("extracts payload names from uplinks for each supported network server", () => {
  const packets = [
    { end_device_ids: { device_id: "sensor-1" }, uplink_message: { decoded_payload: { temperature: 21, humidity: 45 } } },
    { deviceInfo: { deviceName: "sensor-2" }, object: { temperature: 22 } },
    { DevEUI_uplink: { CustomerData: { name: "sensor-3" }, payload: { temperature: 23 } } }
  ];

  assert.deepEqual(packets.map(extractPayloadCatalogEntry), [
    { deviceProfile: "sensor", payloadNames: ["temperature", "humidity"] },
    { deviceProfile: "sensor", payloadNames: ["temperature"] },
    { deviceProfile: "sensor", payloadNames: ["temperature"] }
  ]);
  assert.equal(extractPayloadCatalogEntry({ DevEUI_uplink: {}, DevEUI_notification: {} }), null);
});

test("records payload names from MQTT uplinks even when the profile is not configured", async () => {
  const fakeClient = new EventEmitter();
  fakeClient.subscribe = (_topic, callback) => callback(null);
  fakeClient.end = () => {};
  const catalogEntries = [];
  const service = createMqttService({
    getDeviceProfiles: async () => ({}),
    onPayloadCatalogUpdate: async (entry) => catalogEntries.push(entry),
    clientFactory: () => fakeClient
  });

  service.connect({ server: "broker.local", port: 1883, topic: "#" });
  fakeClient.emit("connect");
  fakeClient.emit("message", "sensor/up", Buffer.from(JSON.stringify({
    end_device_ids: { device_id: "sensor-1" },
    uplink_message: { decoded_payload: { temperature: 21, humidity: 45 } }
  })));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(catalogEntries, [{ deviceProfile: "sensor", payloadNames: ["temperature", "humidity"] }]);
  service.disconnect();
});

test("maps a TTS uplink to a cloned device output", () => {
  const deviceProfiles = makeDeviceProfiles();
  const result = mapIncomingPacket("v3/app/devices/sensor-2/up", Buffer.from(JSON.stringify({
    end_device_ids: { device_id: "sensor-2", dev_eui: "A1B2" },
    uplink_message: { decoded_payload: { decoded: { temperature: 21.5 } } }
  })), deviceProfiles);

  assert.equal(result.device.identity.deviceName, "sensor-2");
  assert.equal(result.device.identity.deviceProfile, "sensor");
  assert.equal(Object.hasOwn(result.device.identity, "deviceType"), false);
  assert.equal(result.device.identity.deviceNum, 2);
  assert.equal(result.device.identity.devEUI, "A1B2");
  assert.equal(result.device.bacnet.objects.temperature.value, 21.5);
  assert.equal(result.device.bacnet.objects.temperature.instanceNum, 121);
  assert.equal(result.device.bacnet.objects.temperature.objectType, 2);
  assert.equal(result.device.mqtt.topicDownlink, "v3/app/devices/sensor-2/down");
  assert.deepEqual(result.device.bacnet.uplinkKeys, ["temperature"]);
  assert.equal(deviceProfiles.sensor.identity.deviceName, undefined);
  assert.equal(deviceProfiles.sensor.bacnet.objects.temperature.instanceNum, 1);
});

test("processes a profile configured for The Things Stack (ttn) like tts", () => {
  const deviceProfiles = makeDeviceProfiles();
  deviceProfiles.sensor.lorawan.networkServer = "ttn";
  const result = mapIncomingPacket("v3/app@ttn/devices/sensor-2/up", Buffer.from(JSON.stringify({
    end_device_ids: { device_id: "sensor-2", dev_eui: "A1B2" },
    uplink_message: { decoded_payload: { decoded: { temperature: 21.5 } } }
  })), deviceProfiles);
  assert.equal(result.error, undefined);
  assert.equal(result.device.mqtt.topicDownlink, "v3/app@ttn/devices/sensor-2/down");
});

test("maps device number zero for each network server and both BACnet object types", () => {
  const profiles = makeDeviceProfiles();
  profiles.sensor.bacnet.objects.temperature.instanceNum = 0;
  profiles.sensor.bacnet.objects.alarm = {
    lorawanPayloadName: "decoded.alarm", dataDirection: "uplink", assignementMode: "auto",
    instanceNum: 0, objectType: "binaryValue", value: 0
  };
  const decoded = { decoded: { temperature: 21, alarm: 1 } };
  const packets = [
    ["tts", { end_device_ids: { device_id: "sensor-0" }, uplink_message: { decoded_payload: decoded } }],
    ["chirpstack", { deviceInfo: { deviceName: "sensor-0" }, object: decoded }],
    ["actility", { DevEUI_uplink: { CustomerData: { name: "sensor-0" }, payload: decoded } }]
  ];
  for (const [network, packet] of packets) {
    profiles.sensor.lorawan.networkServer = network;
    const result = mapIncomingPacket("topic/up", packet, profiles);
    assert.equal(result.error, undefined);
    assert.equal(result.device.identity.deviceNum, 0);
    assert.equal(result.device.bacnet.objects.temperature.instanceNum, 100);
    assert.equal(result.device.bacnet.objects.alarm.instanceNum, 200);
    assert.equal(result.device.bacnet.objects.temperature.value, 21);
  }
});

test("maps ChirpStack and Actility uplinks and ignores non-uplink notifications", () => {
  const deviceProfiles = makeDeviceProfiles();
  deviceProfiles.sensor.lorawan.networkServer = "chirpstack";
  const chirpstack = mapIncomingPacket("application/sensor/event/up", {
    fPort: 1,
    deviceInfo: { deviceName: "sensor-1", devEui: "C1" },
    object: { decoded: { temperature: 22 } }
  }, deviceProfiles);
  assert.equal(chirpstack.device.identity.devEUI, "C1");
  assert.equal(chirpstack.device.mqtt.topicDownlink, "application/sensor/command/down");
  assert.equal(chirpstack.device.bacnet.objects.temperature.value, 22);

  deviceProfiles.sensor.lorawan.networkServer = "actility";
  const actility = mapIncomingPacket("application/sensor/uplink", {
    DevEUI_uplink: {
      CustomerData: { name: "sensor-3" },
      DevEUI: "A3",
      payload: { decoded: { temperature: 23 } }
    }
  }, deviceProfiles);
  assert.equal(actility.device.identity.devEUI, "A3");
  assert.equal(actility.device.mqtt.topicDownlink, "application/sensor/downlink");
  assert.deepEqual(mapIncomingPacket("application/sensor/uplink", {
    DevEUI_uplink: {}, DevEUI_notification: {}
  }, deviceProfiles), { ignored: true });
  assert.equal(mapIncomingPacket("application/sensor/uplink", {
    DevEUI_uplink: {}, DevEUI_downlink_Rejected: {}
  }, deviceProfiles).error, "Actility : Downlink Message Rejected");
});

test("rejects a payload from a network server other than the configured one", () => {
  const result = mapIncomingPacket("application/sensor/event/up", {
    fPort: 1,
    deviceInfo: { deviceName: "sensor-1", devEui: "C1" },
    object: { decoded: { temperature: 22 } }
  }, makeDeviceProfiles());

  assert.equal(result.device, undefined);
  assert.equal(result.error, "Error: Network server mismatch (sensor-1): payload comes from 'chirpstack' but device profile 'sensor' is configured for 'tts'");
});

test("reports device and payload failures", () => {
  const payload = (deviceId, decodedPayload = { decoded: { temperature: 1 } }) => ({
    end_device_ids: { device_id: deviceId },
    uplink_message: { decoded_payload: decodedPayload }
  });
  const deviceProfiles = makeDeviceProfiles();

  assert.equal(mapIncomingPacket("topic/up", payload("sensor"), deviceProfiles).error,
    "Error: Device Name (sensor) does not respect *xxx - num* format");
  assert.equal(mapIncomingPacket("topic/up", payload("unknown-1"), deviceProfiles).error,
    'Error: Device Profile does not belong to the "LoRaWAN to BACnet" List (unknown-1)');
  assert.equal(mapIncomingPacket("topic/up", payload("sensor-5"), deviceProfiles).error,
    "Error: Device number is too high (sensor-5)");
  assert.equal(mapIncomingPacket("topic/up", {
    end_device_ids: { device_id: "sensor-1" }, uplink_message: {}
  }, deviceProfiles).error, "sensor-1 : No payload decoder configured on the Network Server");
  deviceProfiles.sensor.bacnet.objects.temperature.lorawanPayloadName = "decoded.temperaturee";
  assert.equal(mapIncomingPacket("topic/up", payload("sensor-1", {}), deviceProfiles).error,
    "Device : sensor-1 - Object : temperature - decoded.temperaturee doesn't exist in the received LoRaWAN payload.");

  const unknownObjectType = makeDeviceProfiles();
  unknownObjectType.sensor.bacnet.objects.temperature.objectType = "unsupported";
  assert.equal(mapIncomingPacket("topic/up", payload("sensor-1"), unknownObjectType).error,
    "Object type of temperature is unknown : unsupported");
});

test("subscribes on connect and logs mapped output and legacy errors", async () => {
  const fakeClient = new EventEmitter();
  fakeClient.subscribe = (topic, callback) => {
    fakeClient.subscribedTopic = topic;
    callback(null);
  };
  fakeClient.end = () => {};
  const deviceProfiles = makeDeviceProfiles();
  deviceProfiles.sensor.controller.debug = ["deviceMqtt"];
  const service = createMqttService({
    getDeviceProfiles: async () => deviceProfiles,
    clientFactory: () => fakeClient,
    bacnetHandler: async () => ({ ok: false })
  });

  assert.equal(service.connect({ server: "broker.local", port: "1883", username: "user", password: "pass", topic: "#" }).state, "connecting");
  fakeClient.emit("connect");
  assert.equal(fakeClient.subscribedTopic, "#");
  assert.equal(service.getStatus().state, "connected");
  fakeClient.emit("message", "sensor/up", Buffer.from(JSON.stringify({
    end_device_ids: { device_id: "sensor-1", dev_eui: "A1B2" },
    uplink_message: { decoded_payload: { decoded: { temperature: 19 } } }
  })));
  fakeClient.emit("message", "sensor/up", Buffer.from(JSON.stringify({
    end_device_ids: { device_id: "bad-name" },
    uplink_message: { decoded_payload: {} }
  })));
  await new Promise((resolve) => setImmediate(resolve));

  const messages = service.getLogs().map((entry) => entry.message);
  assert.ok(messages.some((message) => message.startsWith("Device object after MQTT reception:\n")));
  assert.ok(messages.includes("Error: Device Name (bad-name) does not respect *xxx - num* format"));
  assert.equal(service.disconnect().state, "disconnected");
});

test("logs one transmit time when no downlink is scheduled for either BMS protocol", async () => {
  for (const protocol of ["bacnet", "restAPIBacnet"]) {
    const fakeClient = new EventEmitter();
    fakeClient.subscribe = (_topic, callback) => callback(null);
    fakeClient.end = () => {};
    const deviceProfiles = makeDeviceProfiles();
    deviceProfiles.sensor.controller = { protocol, debug: ["txTime", "down"] };
    deviceProfiles.sensor.bacnet.objects.setpoint = {
      dataDirection: "downlink",
      downlinkStrategy: "compareToUplinkObject",
      uplinkToCompareWith: "temperature",
      downlinkPortPriority: "high",
      downlinkPort: 1,
      value: 19
    };
    const service = createMqttService({
      getDeviceProfiles: async () => deviceProfiles,
      clientFactory: () => fakeClient,
      bacnetHandler: async () => ({ ok: true }),
      restApiBacnetHandler: async () => ({ ok: true })
    });

    service.connect({ server: "broker.local", port: 1883, topic: "#" });
    fakeClient.emit("connect");
    fakeClient.emit("message", "sensor/up", Buffer.from(JSON.stringify({
      end_device_ids: { device_id: "sensor-1", dev_eui: "A1B2" },
      uplink_message: { decoded_payload: { decoded: { temperature: 19 } } }
    })));
    await new Promise((resolve) => setImmediate(resolve));

    const messages = service.getLogs().map((entry) => entry.message);
    assert.equal(messages.filter((message) => message.includes("TX time =")).length, 1, protocol);
    assert.ok(messages.some((message) => message.includes(": No downlink")), protocol);
    service.disconnect();
  }
});

test("requires broker server, valid port, and topic", () => {
  const service = createMqttService({ getDeviceProfiles: async () => ({}) });
  assert.throws(() => service.connect({ server: "broker.local", port: 0, topic: "#" }), /valid port/);
});