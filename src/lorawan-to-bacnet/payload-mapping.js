const NETWORKS = {
  tts: { uplinkSuffix: "/up", downlinkSuffix: "/down" },
  chirpstack: { uplinkSuffix: "/event/up", downlinkSuffix: "/command/down" },
  actility: { uplinkSuffix: "/uplink", downlinkSuffix: "/downlink" }
};

// LoRaWAN-to-BACnet mapping: decodes network-server uplinks and resolves payload fields to a configured device profile.
function mapIncomingPacket(topic, rawPayload, deviceProfiles) {
  let payload;
  try {
    payload = Buffer.isBuffer(rawPayload) ? JSON.parse(rawPayload.toString("utf8")) :
      typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
  } catch (error) {
    return { error: `Invalid JSON MQTT payload: ${error.message}` };
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "Invalid MQTT payload: expected a JSON object" };
  }

  let networkServer;
  if (Object.hasOwn(payload, "deviceInfo")) networkServer = "chirpstack";
  if (Object.hasOwn(payload, "end_device_ids")) networkServer = "tts";
  if (Object.hasOwn(payload, "DevEUI_uplink")) networkServer = "actility";
  if (!networkServer) return { error: "Unknown network server payload format" };

  if (networkServer === "actility" && Object.hasOwn(payload, "DevEUI_notification")) {
    return { ignored: true };
  }
  if (networkServer === "actility" && Object.hasOwn(payload, "DevEUI_downlink_Rejected")) {
    return { error: "Actility : Downlink Message Rejected" };
  }

  let deviceName;
  let deviceEui;
  let devicePayload;
  let topicDownlink;
  if (networkServer === "tts") {
    deviceName = payload.end_device_ids?.device_id;
    deviceEui = payload.end_device_ids?.dev_eui;
    topicDownlink = topic.replace(NETWORKS.tts.uplinkSuffix, "") + NETWORKS.tts.downlinkSuffix;
    if (!payload.uplink_message || !Object.hasOwn(payload.uplink_message, "decoded_payload")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = payload.uplink_message.decoded_payload;
  } else if (networkServer === "chirpstack") {
    if (payload.fPort === 0) return { ignored: true };
    deviceName = payload.deviceInfo?.deviceName;
    deviceEui = payload.deviceInfo?.devEui;
    topicDownlink = topic.replace(NETWORKS.chirpstack.uplinkSuffix, "") + NETWORKS.chirpstack.downlinkSuffix;
    if (!Object.hasOwn(payload, "object")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = payload.object;
  } else {
    const uplink = payload.DevEUI_uplink;
    deviceName = uplink?.CustomerData?.name;
    deviceEui = uplink?.DevEUI;
    topicDownlink = topic.replace(NETWORKS.actility.uplinkSuffix, "") + NETWORKS.actility.downlinkSuffix;
    if (!uplink || !Object.hasOwn(uplink, "payload")) {
      return { error: `${deviceName} : No payload decoder configured on the Network Server` };
    }
    devicePayload = uplink.payload;
  }

  const match = String(deviceName).match(/^(.*)-(\d+)$/);
  if (!match) {
    return {
      error: `Error: Device Name (${deviceName}) does not respect *xxx - num* format`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }
  const deviceProfile = match[1];
  const deviceNumber = Number.parseInt(match[2], 10);
  if (deviceNumber === 0) {
    return {
      error: `Error: Device Num is 0 is not allowed (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }
  if (!deviceProfiles[deviceProfile]) {
    return {
      error: `Error: Device Profile does not belong to the "LoRaWAN to BACnet" List (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }

  const sourceDevice = deviceProfiles[deviceProfile];
  if (deviceNumber > sourceDevice.identity.maxDevNum) {
    return {
      error: `Error: Device number is too high (${deviceName})`,
      details: { errorType: "deviceName", value: deviceName }
    };
  }
  const configuredNetworkServer = sourceDevice.lorawan?.networkServer;
  if ((configuredNetworkServer === "ttn" ? "tts" : configuredNetworkServer) !== networkServer) {
    return {
      error: `Error: Network server mismatch (${deviceName}): payload comes from '${networkServer}' but device profile '${deviceProfile}' is configured for '${configuredNetworkServer}'`,
      details: { errorType: "networkServer", value: networkServer }
    };
  }

  const device = JSON.parse(JSON.stringify(sourceDevice));
  device.identity.deviceName = deviceName;
  device.identity.deviceProfile = deviceProfile;
  device.identity.deviceNum = deviceNumber;
  device.identity.devEUI = deviceEui;
  device.mqtt ||= {};
  device.mqtt.topicDownlink = topicDownlink;

  for (const [objectName, object] of Object.entries(device.bacnet.objects)) {
    if (object.assignementMode === "auto") {
      if (object.objectType === "analogValue") {
        object.instanceNum += device.bacnet.offsetAV + device.bacnet.instanceRangeAV * deviceNumber;
      } else if (object.objectType === "binaryValue") {
        object.instanceNum += device.bacnet.offsetBV + device.bacnet.instanceRangeBV * deviceNumber;
      } else {
        return { error: `Object type of ${objectName} is unknown : ${object.objectType}` };
      }
    }

    object.objectName = `${deviceName}-${objectName}-${object.instanceNum}`;
    if (object.dataDirection === "uplink") {
      const keys = String(object.lorawanPayloadName || "").split(/[.\[\]]/).filter((key) => key !== "");
      object.value = keys.reduce((value, key) => value?.[key], devicePayload);
    }
    if (object.value === undefined && object.dataDirection === "uplink") {
      return {
        error: `Device : ${device.identity.deviceName} - Object : ${objectName} - ${object.lorawanPayloadName} doesn't exist in the received LoRaWAN payload.`
      };
    }
    if (object.value === undefined || typeof object.value === "object") {
      return { error: `Device : ${device.identity.deviceName} - Object : ${objectName} - Wrong Payload decoder or Wrong Device description` };
    }

    if (device.controller.protocol === "bacnet") {
      if (object.objectType === "analogValue") object.objectType = 2;
      if (object.objectType === "binaryValue") object.objectType = 5;
      device.bacnet.uplinkKeys = Object.entries(device.bacnet.objects)
        .filter(([, bacnetObject]) => bacnetObject.dataDirection === "uplink")
        .map(([key]) => key);
    }
  }

  device.transmitTime = Date.now();
  return { device };
}

module.exports = { mapIncomingPacket };
