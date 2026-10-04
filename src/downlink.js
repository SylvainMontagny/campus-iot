// Protocol-independent downlink preparation: decides if a downlink is needed and builds the MQTT message.

function protocolLabel(device) {
  return device.controller.protocol === "restAPIBacnet" ? "RestAPI" : device.controller.protocol;
}

// Range is an offset band [center + min, center + max].
function isWithinBand(range, center, value) {
  const [min, max] = Array.isArray(range) && range.length >= 2 ? range : [0, 0];
  return value >= center + min && value <= center + max;
}

function shouldTriggerDownlink(objects, previousObjects, objectName, object) {
  const previousValue = previousObjects[objectName]?.value;
  const uplinkValue = object.uplinkToCompareWith ? objects[object.uplinkToCompareWith]?.value : undefined;

  switch (object.downlinkStrategy) {
    case "onChangeOfThisValue":
      return object.value !== previousValue;
    case "onChangeOfThisValueWithinRange":
      // Send when the previously sent value is outside the band around the BMS value.
      return !isWithinBand(object.range, object.value, previousValue);
    case "compareToUplinkObjectWithinRange":
      return uplinkValue !== undefined && !isWithinBand(object.range, uplinkValue, object.value);
    case "compareToUplinkObject":
      return uplinkValue !== undefined && object.value !== uplinkValue;
    default:
      return false;
  }
}

function buildPayloadForObject(objects, objectName) {
  const downlinkPort = objects[objectName].downlinkPort;
  const payload = {};
  for (const [candidateName, candidate] of Object.entries(objects)) {
    if (candidate.dataDirection === "downlink" && candidate.downlinkPort === downlinkPort) {
      payload[candidateName] = candidate.value;
    }
  }
  return { downlinkPort, payload };
}

function describeTrigger(device, objects, previousObjects, objectName) {
  const object = objects[objectName];
  const sourceName = object.uplinkToCompareWith;
  const sourceValue = sourceName ? objects[sourceName]?.value : undefined;
  const base = `${device.identity.deviceName} (${protocolLabel(device)}): Downlink scheduled: `;

  switch (object.downlinkStrategy) {
    case "onChangeOfThisValue":
      return `${base}${objectName} ${object.value} ≠ previous value ${previousObjects[objectName]?.value}`;
    case "onChangeOfThisValueWithinRange":
      return `${base}${objectName} ${object.value} (range ${object.range?.[0]} / ${object.range?.[1]}) and previous value ${previousObjects[objectName]?.value} is outside the range`;
    case "compareToUplinkObjectWithinRange":
      return `${base}${sourceName} ${sourceValue} (range ${object.range?.[0]} / ${object.range?.[1]}) and ${objectName} ${object.value} is outside the range`;
    case "compareToUplinkObject":
      return `${base}${sourceName} ${sourceValue} ≠ ${objectName} ${object.value}`;
    default:
      return `${base}${objectName} ${object.value}`;
  }
}

function buildMessage(device, downlinkPort, payload, log) {
  const objects = device.bacnet.objects;
  const remapped = {};
  for (const [objectName, value] of Object.entries(payload)) {
    remapped[objects[objectName].lorawanPayloadName || objectName] = value;
  }

  const { networkServer, flushDownlinkQueue } = device.lorawan;
  const topic = device.mqtt.topicDownlink;

  if (networkServer === "tts") {
    return {
      topic: topic + (flushDownlinkQueue ? "/replace" : "/push"),
      payload: { downlinks: [{ f_port: downlinkPort, decoded_payload: remapped, priority: "NORMAL" }] }
    };
  }
  if (networkServer === "chirpstack") {
    if (flushDownlinkQueue === true) {
      log("info", `${device.identity.deviceName}: ChirpStack downlink queue flush (gRPC) is not supported yet`, undefined, "down");
    }
    return {
      topic,
      payload: { devEui: device.identity.devEUI, confirmed: false, fPort: downlinkPort, object: remapped }
    };
  }
  if (networkServer === "actility") {
    const driver = device.lorawan.actility?.driver || {};
    return {
      topic,
      payload: {
        DevEUI_downlink: {
          DevEUI: device.identity.devEUI,
          FPort: downlinkPort,
          payload: remapped,
          FlushDownlinkQueue: String(+Boolean(flushDownlinkQueue)),
          DriverCfg: { app: { pId: driver.pId, mId: driver.mId, ver: driver.ver } }
        }
      }
    };
  }
  return null;
}

/**
 * Returns { topic, payload } to publish, or null when no downlink is needed.
 * Updates previousValues[deviceName] with the values that are sent.
 */
function prepareDownlink(device, previousValues, log = () => {}) {
  const name = device.identity.deviceName;
  const objects = device.bacnet.objects;
  previousValues[name] ||= structuredClone(device);
  const previousObjects = previousValues[name].bacnet?.objects || {};

  let highPriority = null;
  let lowPriority = null;
  for (const [objectName, object] of Object.entries(objects)) {
    if (object.dataDirection !== "downlink" || !shouldTriggerDownlink(objects, previousObjects, objectName, object)) continue;
    if (object.downlinkPortPriority === "high") {
      highPriority = objectName;
      break;
    }
    if (object.downlinkPortPriority === "low") lowPriority = objectName;
  }

  const triggerName = highPriority ?? lowPriority;
  if (triggerName === null) {
    if (Object.values(objects).some((object) => object.dataDirection === "downlink")) {
      log("info", `${name} (${protocolLabel(device)}): No downlink`, undefined, "down");
    }
    return null;
  }

  const { downlinkPort, payload } = buildPayloadForObject(objects, triggerName);
  log("info", describeTrigger(device, objects, previousObjects, triggerName), undefined, "down");

  device.lorawan.downlinkPort = downlinkPort;
  for (const [objectName, value] of Object.entries(payload)) {
    if (previousObjects[objectName]) previousObjects[objectName].value = value;
  }

  return buildMessage(device, downlinkPort, payload, log);
}

module.exports = { prepareDownlink, protocolLabel };
